import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit");
const fontkit = require("fontkit");

function readRequestBody(request: import("node:http").IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: import("node:http").ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

// This server only ever expects requests from the app's own Electron window / dev-server
// origin. Vite's built-in CORS middleware never runs for these routes (this plugin's
// configureServer registers them before Vite's internal middleware stack), so without this
// check any website open in a normal browser tab could blind-POST/PUT/DELETE here while the
// dev server is running.
const TRUSTED_API_ORIGINS = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

function isTrustedApiRequest(request: import("node:http").IncomingMessage) {
  const secFetchSite = request.headers["sec-fetch-site"];

  if (typeof secFetchSite === "string") {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }

  const origin = request.headers.origin;

  if (!origin) {
    return true;
  }

  return TRUSTED_API_ORIGINS.has(origin);
}

// SNS Read / SNS Update / Enrich Markdown / Import Archive all concurrently walk, read,
// rename, and delete the same Markdown vault via spawned child scripts (dedupe, validate,
// import, enrich). Without this lock, running two of them at once (e.g. two buttons clicked
// back-to-back) can let one pipeline delete/merge a file while another is mid-write on it,
// silently discarding work.
let activeVaultPipelineLabel: string | null = null;

function tryBeginVaultPipeline(label: string): boolean {
  if (activeVaultPipelineLabel) {
    return false;
  }

  activeVaultPipelineLabel = label;
  return true;
}

function endVaultPipeline() {
  activeVaultPipelineLabel = null;
}

function parseEnv(content: string) {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        const key = index >= 0 ? line.slice(0, index).trim() : line;
        const value = index >= 0 ? line.slice(index + 1).trim() : "";

        return [key, value.replace(/^["']|["']$/g, "")];
      })
  );
}

function upsertEnv(content: string, updates: Record<string, string>) {
  const lines = content ? content.split(/\r?\n/) : [];
  const usedKeys = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);

    if (!match) {
      return line;
    }

    const key = match[1];

    if (!(key in updates)) {
      return line;
    }

    usedKeys.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!usedKeys.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  return `${nextLines.join("\n").trim()}\n`;
}

function runNodeScript(scriptPath: string, args: string[] = []) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `${path.basename(scriptPath)} exited with code ${code}`));
      }
    });
  });
}

function runDedupeMarkdown(platform = "all") {
  const args = ["--apply"];

  if (platform && platform !== "all") {
    args.push("--platform", platform);
  }

  return runNodeScript(path.resolve(process.cwd(), "tools/dedupe-sns-markdown.mjs"), args);
}

function runDetachedNodeScript(scriptPath: string, args: string[] = []) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: false
  });

  child.unref();
}

async function loadRuntimeEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  const fileEnv = await readFile(envPath, "utf8")
    .then(parseEnv)
    .catch(() => ({}));

  return {
    ...fileEnv,
    ...process.env
  };
}

function runPowerShell(script: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      cwd: process.cwd(),
      windowsHide: true
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `PowerShell exited with code ${code}`));
      }
    });
  });
}

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

async function saveRequestBody(request: import("node:http").IncomingMessage, filePath: string) {
  let received = 0;

  await pipeline(
    request,
    async function* limitSize(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length;

        if (received > MAX_UPLOAD_BYTES) {
          throw new Error(`Upload exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit.`);
        }

        yield chunk;
      }
    },
    createWriteStream(filePath)
  );
}

function sanitizeUploadName(value: string) {
  const name = path.basename(value || "archive.zip");
  const sanitized = name.replace(/[^\w .()[\]-\uac00-\ud7af]/g, "_");

  return sanitized.toLowerCase().endsWith(".zip") ? sanitized : `${sanitized || "archive"}.zip`;
}

function scriptArgsForArchiveImport(platform: string, zipPath: string) {
  switch (platform) {
    case "facebook":
      return {
        script: path.resolve(process.cwd(), "tools/import-facebook-export.mjs"),
        args: ["--zip", zipPath],
        label: "Facebook"
      };
    case "instagram":
      return {
        script: path.resolve(process.cwd(), "tools/import-meta-export.mjs"),
        args: ["--platform", "instagram", "--zip", zipPath],
        label: "Instagram"
      };
    case "threads":
      return {
        script: path.resolve(process.cwd(), "tools/import-meta-export.mjs"),
        args: ["--platform", "threads", "--zip", zipPath],
        label: "Threads"
      };
    case "youtube":
      return {
        script: path.resolve(process.cwd(), "tools/import-youtube-takeout.mjs"),
        args: ["--zip", zipPath],
        label: "YouTube"
      };
    case "x":
      return {
        script: path.resolve(process.cwd(), "tools/import-x-archive.mjs"),
        args: ["--zip", zipPath],
        label: "X"
      };
    default:
      return null;
  }
}

async function listZipEntries(zipPath: string) {
  const escapedPath = zipPath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
    `$zip=[System.IO.Compression.ZipFile]::OpenRead('${escapedPath}');`,
    "try {",
    "  $zip.Entries | Select-Object -First 2500 -ExpandProperty FullName",
    "} finally {",
    "  $zip.Dispose()",
    "}"
  ].join(" ");
  const result = await runPowerShell(script);

  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function detectPlatformFromZipEntries(entries: string[]) {
  const normalizedEntries = entries.map((entry) => entry.toLowerCase());
  const joined = normalizedEntries.join("\n");

  if (normalizedEntries.some((entry) => entry.includes("threads/threads_and_replies.json"))) {
    return "threads";
  }

  if (
    normalizedEntries.some((entry) => entry.includes("your_instagram_activity/media/posts")) ||
    normalizedEntries.some((entry) => entry.includes("your_instagram_activity/media/reels"))
  ) {
    return "instagram";
  }

  if (
    normalizedEntries.some((entry) => entry.includes("your_facebook_activity/posts")) ||
    normalizedEntries.some((entry) => entry.includes("posts/your_posts")) ||
    normalizedEntries.some((entry) => entry.includes("facebook"))
  ) {
    return "facebook";
  }

  if (
    normalizedEntries.some((entry) => entry.includes("youtube") && entry.endsWith(".csv")) ||
    normalizedEntries.some((entry) => entry.includes("youtube") && entry.includes("posts")) ||
    joined.includes("youtube")
  ) {
    return "youtube";
  }

  if (
    normalizedEntries.some((entry) => entry.includes("data/tweets.js")) ||
    normalizedEntries.some((entry) => entry.includes("data/tweets-part")) ||
    normalizedEntries.some((entry) => entry.includes("tweet_media"))
  ) {
    return "x";
  }

  return "";
}

function normalizePathForCompare(filePath: string) {
  return path.resolve(filePath).toLowerCase();
}

function isPathInside(childPath: string, parentPath: string) {
  const child = normalizePathForCompare(childPath);
  const parent = normalizePathForCompare(parentPath);

  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function isFilesystemRoot(folderPath: string) {
  const resolved = path.resolve(folderPath);

  return path.parse(resolved).root === resolved;
}

async function walkMarkdownFiles(root: string, files: string[] = []) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith("_")) {
        continue;
      }

      await walkMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseSimpleFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const properties: Record<string, string | string[]> = {};

  if (!match) {
    return properties;
  }

  const lines = match[1].split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

    if (!keyValue) {
      continue;
    }

    const [, key, rawValue] = keyValue;

    if (!rawValue) {
      const list: string[] = [];

      while (lines[index + 1]?.match(/^\s*-\s+/)) {
        index += 1;
        list.push(lines[index].replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, ""));
      }

      properties[key] = list;
      continue;
    }

    properties[key] = rawValue.replace(/^["']|["']$/g, "");
  }

  return properties;
}

function readProperty(properties: Record<string, string | string[]>, key: string) {
  const value = properties[key];

  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readListProperty(properties: Record<string, string | string[]>, key: string) {
  const value = properties[key];

  if (Array.isArray(value)) {
    return value;
  }

  return value ? [value] : [];
}

const GENERATED_MARKDOWN_SECTIONS = ["Date", "Body", "Images", "Videos", "Comments", "Summary", "Source"];
const MARKDOWN_CARD_CACHE_TTL_MS = 30_000;

type MarkdownCard = Record<string, any>;
type MarkdownCardsPayload = {
  cards: MarkdownCard[];
  root: string;
  cached?: boolean;
  durationMs?: number;
};
type PdfBookRange = {
  title: string;
  label: string;
  from: string;
  to: string;
};

let markdownCardsCache: { key: string; payload: MarkdownCardsPayload; createdAt: number } | null = null;

function invalidateMarkdownCardsCache() {
  markdownCardsCache = null;
}

// /api/media is requested once per rendered card image (potentially thousands in a burst on
// the unfiltered "Total" view) and only needs the vault root path out of settings.json - reading
// and re-parsing the whole file on every single request is wasted I/O. This short TTL cache
// (plus explicit invalidation on settings writes) removes that per-request cost.
const SETTINGS_CACHE_TTL_MS = 2000;
let cachedSettingsSnapshot: { value: Record<string, any>; expiresAt: number } | null = null;

async function readCachedSettings(settingsFilePath: string): Promise<Record<string, any>> {
  const now = Date.now();

  if (cachedSettingsSnapshot && cachedSettingsSnapshot.expiresAt > now) {
    return cachedSettingsSnapshot.value;
  }

  const raw = await readFile(settingsFilePath, "utf8").catch(() => "");
  const value = raw ? JSON.parse(raw) : {};

  cachedSettingsSnapshot = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

function invalidateSettingsCache() {
  cachedSettingsSnapshot = null;
}

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  limit: number,
  mapper: (item: Input) => Promise<Output>
) {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

function extractSection(markdown: string, section: string) {
  const sectionIndex = GENERATED_MARKDOWN_SECTIONS.findIndex((item) => item.toLowerCase() === section.toLowerCase());
  const headingMatch = markdown.match(new RegExp(`(^|\\r?\\n)## ${section}\\s*\\r?\\n`, "i"));

  if (!headingMatch || typeof headingMatch.index !== "number") {
    return "";
  }

  const start = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(start);
  const laterSections =
    sectionIndex >= 0 ? GENERATED_MARKDOWN_SECTIONS.slice(sectionIndex + 1) : GENERATED_MARKDOWN_SECTIONS;
  const endOffsets = laterSections
    .map((nextSection) => rest.match(new RegExp(`\\r?\\n## ${nextSection}\\s*\\r?\\n`, "i"))?.index)
    .filter((index): index is number => typeof index === "number");
  const end = endOffsets.length ? start + Math.min(...endOffsets) : markdown.length;

  return markdown.slice(start, end).trim();
}

function relativeWebPath(root: string, filePath: string) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

function buildMediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

function stripFacebookFooterText(value: string) {
  return value
    .replace(/…\s*더 보기/g, "")
    .replace(/더 보기/g, "")
    .replace(/\+?\d+장/g, "")
    .replace(/\d+:\d+\s*\/\s*\d+:\d+/g, "")
    .replace(/모든 공감:\s*\d+[\s\S]*$/g, "")
    .replace(/댓글\s*\d+개[\s\S]*$/g, "")
    .trim();
}

function extractReactionText(value: string) {
  const match = value.match(/모든 공감:\s*(\d+)/);

  return match ? `공감 ${match[1]}` : "";
}

function extractCommentAuthors(commentsText: string) {
  return Array.from(
    new Set(
      commentsText
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*[-*]?\s*([^:\n]{1,48})\s*:/)?.[1]?.trim() ?? "")
        .filter((author) => author && !/^(https?|comment|comments)$/i.test(author))
    )
  );
}

function detectPlatformFromPath(filePath: string) {
  const lower = filePath.toLowerCase();

  if (lower.includes(`${path.sep}facebook${path.sep}`)) return "facebook";
  if (lower.includes(`${path.sep}instagram${path.sep}`)) return "instagram";
  if (lower.includes(`${path.sep}threads${path.sep}`)) return "threads";
  if (lower.includes(`${path.sep}youtube${path.sep}`)) return "youtube";
  if (lower.includes(`${path.sep}naver-blog${path.sep}`)) return "naver-blog";
  if (lower.includes(`${path.sep}x${path.sep}`)) return "x";

  return "other";
}

async function buildMarkdownCard(root: string, accounts: Array<Record<string, any>>, filePath: string): Promise<MarkdownCard | null> {
  const markdown = await readFile(filePath, "utf8").catch(() => "");

  if (!markdown.includes("type: sns-post") && !markdown.includes("platform:")) {
    return null;
  }

  const properties = parseSimpleFrontmatter(markdown);
  const platform = readProperty(properties, "platform") || detectPlatformFromPath(filePath);
  const accountLabel = readProperty(properties, "account") || platform;
  const accountUrl = readProperty(properties, "account_url");
  const normalizedAccountLabel = accountLabel.toLowerCase();
  const account =
    accounts.find((item: { platform?: string; url?: string }) => item.platform === platform && item.url === accountUrl) ??
    accounts.find((item: { url?: string }) => accountUrl && item.url === accountUrl) ??
    accounts.find((item: { platform?: string; label?: string }) => item.platform === platform && item.label === accountLabel) ??
    accounts.find((item: { label?: string }) => item.label?.toLowerCase() === normalizedAccountLabel) ??
    accounts.find((item: { platform?: string }) => item.platform === platform);
  const rawBody = extractSection(markdown, "Body");
  const body = stripFacebookFooterText(rawBody);
  const commentsText = extractSection(markdown, "Comments");
  const reactionText = extractReactionText(rawBody);
  const summaryLines = readListProperty(properties, "summary").length
    ? readListProperty(properties, "summary")
    : extractSection(markdown, "Summary")
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
      .slice(0, 2);
  const imagesSection = extractSection(markdown, "Images");
  const imageEmbeds = [...imagesSection.matchAll(/!\[\[([^\]]+)\]\]/g)].map((match) => match[1]);
  const imageLinks = [...imagesSection.matchAll(/!\[[^\]]*\]\(([^)]+)\)|\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1] || match[2])
    .filter(Boolean);
  const localImages = imageEmbeds
    .map((imagePath) => path.resolve(path.dirname(filePath), imagePath.replaceAll("/", path.sep)))
    .filter((imagePath) => isPathInside(imagePath, root));
  const remoteImages = imageLinks.filter((imagePath) => /^https?:\/\//i.test(imagePath));
  const imageUrls = [...localImages.map(buildMediaUrl), ...remoteImages];
  const firstImageUrl = imageUrls[0] ?? "";
  const commentCount = Number(readProperty(properties, "comment_count")) || 0;
  const imageCount = Number(readProperty(properties, "image_count")) || imageUrls.length;
  const dateIso = readProperty(properties, "date") || readProperty(properties, "created").slice(0, 10);
  const dateText = readProperty(properties, "created") || dateIso;
  const tags = readListProperty(properties, "tags").slice(0, 10);

  return {
    id: path.relative(root, filePath),
    accountId: account?.id ?? `${platform}-generated`,
    title: readProperty(properties, "title"),
    platform,
    platformLabel: accountLabel,
    date: dateText.replace("T", " ").slice(0, 16).replaceAll("-", "."),
    dateIso,
    filePath: relativeWebPath(root, filePath),
    absolutePath: filePath,
    body,
    bodyPreview: body.replace(/\s+/g, " ").slice(0, 320),
    summary: summaryLines.join(" ") || body.replace(/\s+/g, " ").slice(0, 180) || "No body preview captured.",
    summaryLines,
    imageCount,
    commentCount,
    commentsText,
    reactionText,
    commentAuthors: extractCommentAuthors(commentsText),
    tags,
    imageUrls,
    sourceUrl: readProperty(properties, "source_url") || readProperty(properties, "source"),
    thumbnailUrl: firstImageUrl
  };
}

async function buildMarkdownCards(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const root = path.resolve(settings.obsidianRootFolder || process.env.SNS_READER_OBSIDIAN_FOLDER || "data/sample-md");
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  const cacheKey = `${settingsFilePath}:${root}:${JSON.stringify(accounts.map((account: Record<string, any>) => [account.id, account.platform, account.label, account.url]))}`;
  const now = Date.now();

  if (markdownCardsCache?.key === cacheKey && now - markdownCardsCache.createdAt < MARKDOWN_CARD_CACHE_TTL_MS) {
    return {
      ...markdownCardsCache.payload,
      cached: true,
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const files = await walkMarkdownFiles(root);
  const cardResults: Array<MarkdownCard | null> = await mapWithConcurrency(files, 64, (filePath) => buildMarkdownCard(root, accounts, filePath));
  const cards: MarkdownCard[] = cardResults.filter((card): card is MarkdownCard => card !== null);
  const payload = {
    cards: cards.sort((left, right) => String(right.dateIso).localeCompare(String(left.dateIso))),
    root,
    durationMs: Date.now() - startedAt,
  };

  markdownCardsCache = { key: cacheKey, payload, createdAt: Date.now() };

  return payload;
}

function sanitizeFileSegment(value: string) {
  return String(value || "SNS_Book")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function monthRangeSegment(range: PdfBookRange) {
  const fromMatch = String(range.from || "").match(/^(\d{4})-(\d{2})/);
  const toMatch = String(range.to || "").match(/^(\d{4})-(\d{2})/);
  const from = fromMatch ? `${fromMatch[1]}.${fromMatch[2]}` : "start";
  const to = toMatch ? `${toMatch[1]}.${toMatch[2]}` : "end";

  return `${from}-${to}`;
}

function pdfOutputFileName(range: PdfBookRange) {
  return `SNS ${monthRangeSegment(range)}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 140) + ".pdf";
}

function dateRangeSegment(range: PdfBookRange) {
  const from = String(range.from || "start").replaceAll("-", ".");
  const to = String(range.to || "end").replaceAll("-", ".");

  return `${from}-${to}`;
}

function pdfOutputFileNameForRange(range: PdfBookRange, existingNames: Set<string>) {
  const monthName = pdfOutputFileName(range);

  if (!existingNames.has(monthName.toLowerCase())) {
    existingNames.add(monthName.toLowerCase());
    return monthName;
  }

  const dateName = `SNS ${dateRangeSegment(range)}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 150) + ".pdf";

  existingNames.add(dateName.toLowerCase());
  return dateName;
}

function pdfMetadataPath(pdfPath: string) {
  const metadataRoot = path.join(process.cwd(), "data", "runtime", "pdf-metadata");
  const hash = createHash("sha1").update(path.resolve(pdfPath).toLowerCase()).digest("hex");

  return path.join(metadataRoot, `${hash}.json`);
}

function parseDateOnly(value: string) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return Number.isFinite(date.getTime()) ? date : null;
}

function formatKoreanDate(date: Date | null) {
  if (!date) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

const genericMeshTags = new Set(["sns", "facebook", "instagram", "threads", "youtube", "x", "naverblog", "naver-blog"]);
const pdfMeshVisibleEdgeLimit = 360;

type PdfMeshEdge = {
  from: string;
  to: string;
  sharedTags: string[];
  weight: number;
};

function pdfEdgeKey(from: string, to: string) {
  return from < to ? `${from}---${to}` : `${to}---${from}`;
}

function selectBalancedPdfMeshEdges(edges: PdfMeshEdge[], limit: number) {
  const selected: PdfMeshEdge[] = [];
  const selectedKeys = new Set<string>();
  const nodeVisualCounts = new Map<string, number>();
  const tagVisualCounts = new Map<string, number>();
  const tagLimit = Math.max(18, Math.ceil(limit / 10));
  const nodeCaps = [2, 4, 7, Number.POSITIVE_INFINITY];

  for (const nodeCap of nodeCaps) {
    for (const edge of edges) {
      if (selected.length >= limit) {
        return selected;
      }

      const key = pdfEdgeKey(edge.from, edge.to);
      if (selectedKeys.has(key)) {
        continue;
      }

      const primaryTag = edge.sharedTags[0] ?? "";
      const fromCount = nodeVisualCounts.get(edge.from) ?? 0;
      const toCount = nodeVisualCounts.get(edge.to) ?? 0;
      const currentTagCount = tagVisualCounts.get(primaryTag) ?? 0;

      if (fromCount >= nodeCap || toCount >= nodeCap || currentTagCount >= tagLimit) {
        continue;
      }

      selected.push(edge);
      selectedKeys.add(key);
      nodeVisualCounts.set(edge.from, fromCount + 1);
      nodeVisualCounts.set(edge.to, toCount + 1);
      tagVisualCounts.set(primaryTag, currentTagCount + 1);
    }
  }

  return selected;
}

function hashToUnit(value: string, salt: number) {
  let hash = 2166136261 ^ salt;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function semanticTagsFromPost(post: Record<string, any>) {
  return Array.from(
    new Set(
      (Array.isArray(post.tags) ? post.tags : [])
        .map((tag: string) => String(tag).replace(/^#/, "").trim())
        .filter((tag: string) => tag && !genericMeshTags.has(tag.toLowerCase()))
    )
  );
}

const englishMonthNames = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

function monthKeyFromPost(post: Record<string, any>) {
  const match = String(post.dateIso || post.date || "").match(/^(\d{4})-(\d{2})/);

  return match ? `${match[1]}-${match[2]}` : "";
}

function getPdfRange(settings: Record<string, any>, cards: Array<Record<string, any>>): PdfBookRange {
  if (settings.pdfSplitMode === "year") {
    const year = String(settings.pdfYear || new Date().getFullYear()).split(",")[0].trim();

    return {
      title: `SNS Archive ${year}`,
      label: `${year}.01.01 - ${year}.12.31`,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    };
  }

  if (settings.pdfSplitMode === "date-range") {
    return {
      title: `SNS Archive ${settings.pdfDateFrom || "start"}_${settings.pdfDateTo || "end"}`,
      label: `${settings.pdfDateFrom || "start"} - ${settings.pdfDateTo || "end"}`,
      from: String(settings.pdfDateFrom || ""),
      to: String(settings.pdfDateTo || ""),
    };
  }

  const dates = cards.map((card) => card.dateIso).filter(Boolean).sort();
  const from = String(settings.pdfDateFrom || dates[0] || "");
  const to = String(settings.pdfDateTo || dates.at(-1) || "");

  return {
    title: `SNS Archive ${from || "all"}_${to || "all"}`,
    label: `${from || "first"} - ${to || "latest"} / ${settings.pdfPageCount || 200} pages target`,
    from,
    to,
  };
}

function filterCardsByRange(cards: Array<Record<string, any>>, range: PdfBookRange) {
  return cards
    .filter((card) => {
      const dateIso = String(card.dateIso || "");

      if (!dateIso) {
        return false;
      }

      return (!range.from || dateIso >= range.from) && (!range.to || dateIso <= range.to);
    })
    .sort((left, right) => String(left.dateIso).localeCompare(String(right.dateIso)));
}

function filterCardsByPlatform(cards: Array<Record<string, any>>, settings: Record<string, any>) {
  const selected = Array.isArray(settings.pdfPlatforms) ? settings.pdfPlatforms.filter(Boolean) : [];

  if (selected.length === 0) {
    return cards;
  }

  const allowed = new Set(selected.map((platform: string) => String(platform).toLowerCase()));

  return cards.filter((card) => allowed.has(String(card.platform || "").toLowerCase()));
}

function pdfRangeFromPosts(posts: Array<Record<string, any>>) {
  const dates = posts.map((post) => String(post.dateIso || "")).filter(Boolean).sort();
  const from = dates[0] || "";
  const to = dates.at(-1) || from;

  return {
    title: `SNS Archive ${from || "all"}_${to || "all"}`,
    label: `${from || "first"} - ${to || "latest"}`,
    from,
    to,
  };
}

function filterPdfPosts(cards: Array<Record<string, any>>, settings: Record<string, any>) {
  return filterCardsByRange(cards, getPdfRange(settings, cards));
}

function parsePdfYearRanges(value: string): PdfBookRange[] {
  const entries = String(value || new Date().getFullYear())
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("PDF year list is empty.");
  }

  return entries.map((entry) => {
    const match = entry.match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);

    if (!match) {
      throw new Error(`Invalid year range: ${entry}`);
    }

    const startYear = Number(match[1]);
    const endYear = Number(match[2] || match[1]);
    if (startYear > endYear) {
      throw new Error(`년도 범위는 앞의 연도가 뒤의 연도보다 클 수 없습니다: ${entry}`);
    }

    const fromYear = startYear;
    const toYear = endYear;
    const label = fromYear === toYear ? `${fromYear}.01.01 - ${fromYear}.12.31` : `${fromYear}.01.01 - ${toYear}.12.31`;
    const title = fromYear === toYear ? `SNS Archive ${fromYear}` : `SNS Archive ${fromYear}-${toYear}`;

    return {
      title,
      label,
      from: `${fromYear}-01-01`,
      to: `${toYear}-12-31`,
    };
  });
}

function estimatePostPageCost(post: Record<string, any>, settings: Record<string, any>) {
  const textColumnCount = getPdfTextColumnCount(settings);
  const isLandscape = settings.pdfPageOrientation === "landscape";
  const imageLayout = String(settings.imageLayout || "collage");
  const bodyText = [
    post.title,
    post.body,
    settings.pdfFields?.includes("comments") ? post.commentsText : "",
    settings.pdfFields?.includes("summary") ? (post.summaryLines ?? []).join("\n") : "",
    settings.pdfFields?.includes("tags") ? (post.tags ?? []).join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n");
  const charsPerPage = isLandscape ? textColumnCount * 1250 : textColumnCount * 850;
  const textPages = Math.max(1, Math.ceil(bodyText.length / Math.max(450, charsPerPage)));
  const imageCount = settings.pdfFields?.includes("images") ? pdfImagePathsFromPost(post).length : 0;
  const imageOnly = isImageOnlyPdfPost(post);

  if (imageOnly && imageCount > 0) {
    return 1;
  }

  if (imageCount === 0) {
    return textPages;
  }

  if (imageCount < 4) {
    return textPages + (textPages > 1 ? 1 : 0);
  }

  const collagePage = imageLayout === "collage" || imageLayout === "collage-individual" ? 1 : 0;
  const individualPages = imageLayout === "individual" || imageLayout === "collage-individual" ? Math.ceil(imageCount / (isLandscape ? 8 : 6)) : 0;
  const imagePages = Math.max(1, collagePage + individualPages);

  return textPages + imagePages;
}

function chunkPostsByTargetPages(posts: Array<Record<string, any>>, settings: Record<string, any>) {
  const minVolumePages = 30;
  const targetPages = Math.max(minVolumePages, Number(settings.pdfPageCount || 200));
  const frontAndBackMatterPages = 5;
  const postBudget = Math.max(1, targetPages - frontAndBackMatterPages);
  const minPostBudget = Math.max(1, minVolumePages - frontAndBackMatterPages);
  const chunks: Array<Array<Record<string, any>>> = [];
  const costs: number[] = [];
  let currentChunk: Array<Record<string, any>> = [];
  let currentCost = 0;

  for (const post of posts) {
    const postCost = estimatePostPageCost(post, settings);

    if (currentChunk.length && currentCost + postCost > postBudget) {
      chunks.push(currentChunk);
      costs.push(currentCost);
      currentChunk = [];
      currentCost = 0;
    }

    currentChunk.push(post);
    currentCost += postCost;
  }

  if (currentChunk.length) {
    chunks.push(currentChunk);
    costs.push(currentCost);
  }

  if (chunks.length > 1 && (costs.at(-1) ?? 0) < minPostBudget) {
    const remainder = chunks.pop() ?? [];

    chunks[chunks.length - 1].push(...remainder);
  }

  return chunks;
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = keyFn(item);

    if (!key) {
      continue;
    }

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function topEntries(counts: Map<string, number>, limit: number) {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit);
}

function reactionScore(post: Record<string, any>) {
  const reactionNumber = Number(String(post.reactionText || "").match(/\d+/)?.[0] ?? 0);
  const commentCount = Number(post.commentCount || 0);

  return reactionNumber + commentCount * 2;
}

function makePeriodBins(posts: Array<Record<string, any>>) {
  const dates = posts.map((post) => parseDateOnly(post.dateIso)).filter((date): date is Date => Boolean(date));

  if (dates.length === 0) {
    return [];
  }

  const minTime = Math.min(...dates.map((date) => date.getTime()));
  const maxTime = Math.max(...dates.map((date) => date.getTime()));
  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.max(1, Math.ceil((maxTime - minTime) / dayMs) + 1);
  const binCount = Math.min(12, Math.max(1, spanDays <= 90 ? Math.ceil(spanDays / 7) : Math.ceil(spanDays / 31)));
  const binMs = Math.max(dayMs, Math.ceil((spanDays * dayMs) / binCount));
  const bins = Array.from({ length: binCount }, (_item, index) => {
    const from = new Date(minTime + binMs * index);
    const to = new Date(Math.min(maxTime, minTime + binMs * (index + 1) - dayMs));

    return {
      label: spanDays <= 90 ? `${formatKoreanDate(from).slice(5)}-${formatKoreanDate(to).slice(5)}` : formatKoreanDate(from).slice(0, 7),
      from: from.getTime(),
      to: to.getTime() + dayMs - 1,
      count: 0,
    };
  });

  for (const date of dates) {
    const bin = bins.find((item) => date.getTime() >= item.from && date.getTime() <= item.to) ?? bins.at(-1);

    if (bin) {
      bin.count += 1;
    }
  }

  return bins.filter((bin) => bin.count > 0);
}

function mediaPathFromUrl(url: string) {
  try {
    const parsed = new URL(url, "http://sns-reader.local");
    const mediaPath = parsed.searchParams.get("path");

    return mediaPath ? path.resolve(mediaPath) : "";
  } catch {
    return "";
  }
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

const pdfOriginalImagePathCache = new Map<string, string>();

function isUsablePdfImagePath(filePath: string) {
  if (!filePath || !existsSync(filePath)) {
    return false;
  }

  const extension = path.extname(filePath).toLowerCase();

  if (![".jpg", ".jpeg", ".png"].includes(extension)) {
    return false;
  }

  try {
    return statSync(filePath).size > 512;
  } catch {
    return false;
  }
}

function pdfImagePathsFromPost(post: Record<string, any>) {
  return Array.isArray(post.imageUrls)
    ? post.imageUrls
        .map(mediaPathFromUrl)
        .map((imagePath) => pdfOriginalImagePathCache.get(imagePath) || imagePath)
        .filter(isUsablePdfImagePath)
    : [];
}

function lowResolutionPdfImage(filePath: string) {
  try {
    return statSync(filePath).size < 30000;
  } catch {
    return false;
  }
}

function readJsonFileSyncSafe(filePath: string) {
  try {
    return JSON.parse(require("node:fs").readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function highQualityNaverImageUrls(url: string) {
  if (!/^https?:\/\//i.test(url)) {
    return [];
  }

  const normalized = url.replace(/\?type=[^&]+/i, "");
  const isNaverImage = /(?:postfiles|blogfiles|blogthumb|phinf)\.pstatic\.net/i.test(normalized);

  if (!isNaverImage) {
    return [url];
  }

  return [
    `${normalized}?type=w966`,
    `${normalized}?type=w1`,
    `${normalized}?type=w773`,
    `${normalized}?type=w2`,
    normalized,
  ];
}

async function downloadPdfImageCandidate(url: string, targetPath: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
      Referer: "https://blog.naver.com/",
    },
  });

  if (!response.ok) {
    return 0;
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length < 1024) {
    return 0;
  }

  await writeFile(targetPath, bytes);
  return bytes.length;
}

async function ensureHighQualityPdfImage(localPath: string) {
  if (!isUsablePdfImagePath(localPath) || !lowResolutionPdfImage(localPath)) {
    return;
  }

  const cached = pdfOriginalImagePathCache.get(localPath);

  if (cached && isUsablePdfImagePath(cached)) {
    return;
  }

  const mediaDir = path.dirname(localPath);
  const meta = readJsonFileSyncSafe(path.join(mediaDir, "meta.json"));
  const sourceUrls = Array.isArray(meta?.imageUrls) ? meta.imageUrls.map(String) : [];

  if (sourceUrls.length === 0) {
    return;
  }

  const copiedImages = Array.isArray(meta?.copiedImages) ? meta.copiedImages.map(String) : [];
  const imageIndex = Math.max(0, copiedImages.indexOf(path.basename(localPath)));
  const sourceUrl = sourceUrls[imageIndex] || sourceUrls[0];
  const extension = path.extname(localPath) || ".jpg";
  const targetPath = path.join(mediaDir, `${path.basename(localPath, extension)}.original${extension}`);

  if (isUsablePdfImagePath(targetPath) && statSync(targetPath).size > statSync(localPath).size) {
    pdfOriginalImagePathCache.set(localPath, targetPath);
    return;
  }

  let bestBytes = statSync(localPath).size;

  for (const candidateUrl of highQualityNaverImageUrls(sourceUrl)) {
    const tempPath = `${targetPath}.tmp`;

    try {
      const bytes = await downloadPdfImageCandidate(candidateUrl, tempPath);

      if (bytes > bestBytes * 1.5) {
        await writeFile(targetPath, await readFile(tempPath));
        pdfOriginalImagePathCache.set(localPath, targetPath);
        bestBytes = bytes;
        break;
      }
    } catch {
      // Ignore failed image upgrades and keep the archived local image.
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function ensureHighQualityPdfImages(posts: Array<Record<string, any>>) {
  const localPaths = uniqueStrings(
    posts
      .flatMap((post) => (Array.isArray(post.imageUrls) ? post.imageUrls : []))
      .map((imageUrl) => mediaPathFromUrl(String(imageUrl)))
      .filter(isUsablePdfImagePath)
  );

  await mapWithConcurrency(localPaths, 6, ensureHighQualityPdfImage);
}

function isMeaningfulPdfText(value: string) {
  const normalized = String(value || "")
    .replace(/[?\s.,:;!()[\]{}"'`~_-]/g, "")
    .trim();

  return /[A-Za-z0-9가-힣]/.test(normalized) && normalized.length >= 4;
}

function isImageOnlyPdfPost(post: Record<string, any>) {
  const imagePaths = pdfImagePathsFromPost(post);

  if (imagePaths.length === 0) {
    return false;
  }

  const title = String(post.title || "").trim();
  const body = String(post.body || post.bodyPreview || "").trim();
  const textCandidates = [
    body,
    title && !/^\d{1,5}$/.test(title) ? title : "",
  ];

  return !textCandidates.some(isMeaningfulPdfText);
}

function defaultPdfSampleImagePaths() {
  return [
    path.join(process.cwd(), "assets", "Cover-Long3.jpeg"),
    path.join(process.cwd(), "assets", "Cover-Wide2.png"),
  ].filter(isUsablePdfImagePath);
}

function postImagePaths(post: Record<string, any>) {
  return pdfImagePathsFromPost(post);
}

function seededImageOrder(paths: string[], salt: string) {
  return [...paths].sort((left, right) => {
    const leftKey = `${salt}:${path.basename(left)}:${left.length}`;
    const rightKey = `${salt}:${path.basename(right)}:${right.length}`;

    return leftKey.localeCompare(rightKey);
  });
}

function randomImageOrder(paths: string[]) {
  const ordered = [...paths];

  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
  }

  return ordered;
}

// Picks up to `targetCount` real post images at random. Never pads short of that
// count by repeating images - the mosaic layout adapts to however many images are
// actually available. Only falls back to a single branded placeholder when the
// book has no usable images at all.
function randomPdfCollageImages(paths: string[], targetCount: number) {
  const sourceImages = uniqueStrings(paths).filter(isUsablePdfImagePath);

  if (sourceImages.length > 0) {
    return randomImageOrder(sourceImages).slice(0, Math.max(1, targetCount));
  }

  const fallbackImages = defaultPdfSampleImagePaths();

  return fallbackImages.length ? [randomImageOrder(fallbackImages)[0]] : [];
}

const PDF_OVERVIEW_COLLAGE_IMAGE_COUNT = 20;

function cleanPdfOverviewSummaryLine(value: string) {
  return String(value || "")
    .replace(/^[-*\u2022]\s+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lowInformationSummaryLine(value: string) {
  const text = cleanPdfOverviewSummaryLine(value);

  if (!text) {
    return true;
  }

  return (
    /\?{2,}/.test(text) ||
    /Summary will be generated/i.test(text) ||
    /본문\s*부족|원문\s*보강|링크성|제한된\s*내용|내용이\s*비어|알\s*수\s*없는|복원되지|핵심\s*주제|파악하기\s*어렵/i.test(text)
  );
}

function summarySimilarityKey(value: string) {
  return cleanPdfOverviewSummaryLine(value)
    .replace(/\d{4}[-.]\d{2}[-.]\d{2}/g, "")
    .replace(/\b(?:facebook|instagram|threads|youtube|naver-blog|x)\b/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase()
    .slice(0, 80);
}

function splitPdfSummarySentences(value: string) {
  return cleanPdfOverviewSummaryLine(value)
    .split(/(?<=[.!?。！？다요음임함됨됨니다습니다])\s+/u)
    .map(cleanPdfOverviewSummaryLine)
    .filter(Boolean);
}

function pushUniquePdfSummaryLine(lines: string[], seen: Set<string>, value: string, maxLines = 8) {
  const line = cleanPdfOverviewSummaryLine(value);
  const key = summarySimilarityKey(line);

  if (!line || !key || seen.has(key) || lines.length >= maxLines) {
    return;
  }

  seen.add(key);
  lines.push(line);
}

function meaningfulTagLabels(tagCounts: Array<[string, number]>) {
  const lowValueTags = new Set([
    "SNS",
    "sns",
    "Facebook",
    "Instagram",
    "Threads",
    "YouTube",
    "NaverBlog",
    "naver-blog",
    "아카이브",
    "짧은기록",
    "링크성게시물",
    "본문부족",
    "원문보강",
  ]);

  return tagCounts
    .map(([tag]) => String(tag || "").replace(/^#/, "").trim())
    .filter((tag) => tag && !lowValueTags.has(tag) && !/[?�]/.test(tag))
    .slice(0, 6);
}

function buildPdfOverviewSummaryLines(posts: Array<Record<string, any>>, tagCounts: Array<[string, number]>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  const meaningfulSummaries = posts
    .flatMap((post) => (Array.isArray(post.summaryLines) && post.summaryLines.length ? post.summaryLines : [post.summary]))
    .flatMap((line) => splitPdfSummarySentences(String(line || "")))
    .filter((line) => !lowInformationSummaryLine(line));
  const lowInfoCount = posts.filter((post) => {
    const body = String(post.body || post.bodyPreview || "").trim();
    const summaries = Array.isArray(post.summaryLines) && post.summaryLines.length ? post.summaryLines : [post.summary];

    return !isMeaningfulPdfText(body) || summaries.every((line: string) => lowInformationSummaryLine(line));
  }).length;
  const imagePostCount = posts.filter((post) => pdfImagePathsFromPost(post).length > 0).length;
  const platforms = topEntries(countBy(posts, (post) => String(post.platformLabel || post.platform || "SNS")), 5).map(([label]) => label);
  const topTags = meaningfulTagLabels(tagCounts);

  pushUniquePdfSummaryLine(
    lines,
    seen,
    `이 기간에는 ${posts.length}개의 글이 ${platforms.join(", ") || "SNS"}에서 아카이브되었습니다.`
  );

  for (const summary of meaningfulSummaries) {
    pushUniquePdfSummaryLine(lines, seen, summary, 7);
  }

  if (lowInfoCount > 0) {
    pushUniquePdfSummaryLine(
      lines,
      seen,
      `본문이 짧거나 원문 보강이 필요한 글은 ${lowInfoCount}개이며, 이런 글은 이미지와 링크 맥락을 함께 보존하는 자료로 남겼습니다.`
    );
  }

  if (imagePostCount > 0) {
    pushUniquePdfSummaryLine(lines, seen, `이미지가 포함된 글은 ${imagePostCount}개이며, 사진 중심 글은 본문보다 시각 자료가 기록의 핵심이 되도록 배치했습니다.`);
  }

  if (topTags.length > 0) {
    pushUniquePdfSummaryLine(lines, seen, `주요 TAG는 ${topTags.join(", ")} 흐름으로 묶이며, 같은 TAG를 공유하는 글들은 Mesh View에서 연결 관계를 확인할 수 있습니다.`);
  }

  if (lines.length <= 1) {
    pushUniquePdfSummaryLine(lines, seen, "구체적인 본문이 부족한 글은 별도의 반복 요약 대신 원문 확인과 이미지 보강 대상으로 정리했습니다.");
  }

  return lines.slice(0, 8);
}

const WINDOWS_FONTS_DIR = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");

let cachedSystemFonts: Array<{ family: string; regularPath: string; boldPath: string }> | null = null;

// Scans the OS font directory once and groups files by their real font-table
// family name (via fontkit), not the filename - Windows font filenames are
// inconsistent (e.g. "AGENCYB.TTF" is "Agency FB Bold"). Font collections
// (.ttc) are skipped since PDFKit needs a plain single-family file to embed.
async function scanSystemFonts() {
  if (cachedSystemFonts) {
    return cachedSystemFonts;
  }

  const fileNames = await readdir(WINDOWS_FONTS_DIR).catch(() => [] as string[]);
  const families = new Map<string, { family: string; regularPath: string; boldPath: string }>();

  for (const fileName of fileNames) {
    if (!/\.(ttf|otf)$/i.test(fileName)) {
      continue;
    }

    const fullPath = path.join(WINDOWS_FONTS_DIR, fileName);
    let parsed: any;

    try {
      parsed = fontkit.openSync(fullPath);
    } catch {
      continue;
    }

    const family = String(parsed?.familyName || "").trim();

    if (!family || parsed?.fonts) {
      continue;
    }

    const subfamily = String(parsed?.subfamilyName || "").toLowerCase();
    const isItalic = subfamily.includes("italic") || subfamily.includes("oblique");
    const isBold = subfamily.includes("bold");
    const key = family.toLowerCase();
    const entry = families.get(key) || { family, regularPath: "", boldPath: "" };

    if (isBold && !isItalic && !entry.boldPath) {
      entry.boldPath = fullPath;
    } else if (!isBold && !isItalic && !entry.regularPath) {
      entry.regularPath = fullPath;
    } else if (!entry.regularPath && !entry.boldPath) {
      entry.regularPath = fullPath;
    }

    families.set(key, entry);
  }

  cachedSystemFonts = [...families.values()]
    .map((entry) => ({
      family: entry.family,
      regularPath: entry.regularPath || entry.boldPath,
      boldPath: entry.boldPath,
    }))
    .sort((left, right) => left.family.localeCompare(right.family));

  return cachedSystemFonts;
}

function resolvePdfFont(style: Record<string, any>) {
  const family = String(style.fontFamily || "").toLowerCase();
  const bold = Boolean(style.bold);
  const configuredFont = String(bold ? style.fontBoldPath || style.fontRegularPath || "" : style.fontRegularPath || "").trim();

  if (configuredFont && existsSync(configuredFont)) {
    return configuredFont;
  }

  const windowsFont =
    family.includes("malgun")
      ? bold
        ? "C:\\Windows\\Fonts\\malgunbd.ttf"
        : "C:\\Windows\\Fonts\\malgun.ttf"
      : family.includes("noto")
        ? bold
          ? "C:\\Windows\\Fonts\\NotoSansKR-Bold.ttf"
          : "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"
        : family.includes("nanum")
          ? bold
            ? "C:\\Windows\\Fonts\\NanumGothicBold.ttf"
            : "C:\\Windows\\Fonts\\NanumGothic.ttf"
          : family.includes("kopub")
            ? bold
              ? "C:\\Windows\\Fonts\\KoPubBatangBold.ttf"
              : "C:\\Windows\\Fonts\\KoPubBatangMedium.ttf"
      : "";

  if (windowsFont && existsSync(windowsFont)) {
    return windowsFont;
  }

  return bold ? "Helvetica-Bold" : "Helvetica";
}

function applyPdfTextStyle(doc: any, styles: Record<string, any>, target: string) {
  const style = styles[target] ?? {};

  doc.font(resolvePdfFont(style));
  doc.fontSize(Number(style.fontSize || 11));
  doc.fillColor(String(style.color || "#222222"));

  return style;
}

function addPdfPage(doc: any) {
  doc.addPage({
    layout: doc.snsReaderPageLayout || "portrait",
    size: "A4",
  });
}

function ensurePdfSpace(doc: any, neededHeight: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;

  if (doc.y + neededHeight > bottom) {
    addPdfPage(doc);
    drawPageDecoration(doc);
  }
}

function pdfContentBottom(doc: any) {
  return doc.page.height - doc.page.margins.bottom - 42;
}

function getPdfTextColumnCount(settings: Record<string, any>) {
  const requested = Number(settings.pdfTextColumnCount || 2);

  if (requested === 3) {
    return settings.pdfPageOrientation === "landscape" ? 3 : 2;
  }

  if (settings.pdfPageOrientation === "landscape" && requested === 1) {
    return 2;
  }

  return requested === 1 ? 1 : 2;
}

function drawCornerMotif(doc: any, x: number, y: number, flipX = 1, flipY = 1) {
  const unit = 9;

  doc
    .moveTo(x, y)
    .lineTo(x + unit * 2.3 * flipX, y)
    .lineTo(x + unit * 2.3 * flipX, y + unit * 0.8 * flipY)
    .moveTo(x, y + unit * 1.7 * flipY)
    .lineTo(x + unit * 1.5 * flipX, y + unit * 1.7 * flipY)
    .lineTo(x + unit * 1.5 * flipX, y + unit * 3.2 * flipY)
    .moveTo(x + unit * 3.1 * flipX, y + unit * 0.9 * flipY)
    .lineTo(x + unit * 3.1 * flipX, y + unit * 2.5 * flipY);
}

function drawKoreanCornerMotif(doc: any, x: number, y: number, flipX = 1, flipY = 1) {
  const unit = 8;

  doc
    .moveTo(x, y)
    .lineTo(x + unit * 5 * flipX, y)
    .lineTo(x + unit * 5 * flipX, y + unit * 1.2 * flipY)
    .lineTo(x + unit * 1.2 * flipX, y + unit * 1.2 * flipY)
    .lineTo(x + unit * 1.2 * flipX, y + unit * 5 * flipY)
    .lineTo(x, y + unit * 5 * flipY)
    .moveTo(x + unit * 2 * flipX, y + unit * 2 * flipY)
    .lineTo(x + unit * 4.1 * flipX, y + unit * 2 * flipY)
    .lineTo(x + unit * 4.1 * flipX, y + unit * 3 * flipY)
    .lineTo(x + unit * 3.1 * flipX, y + unit * 3 * flipY)
    .lineTo(x + unit * 3.1 * flipX, y + unit * 4.1 * flipY)
    .moveTo(x + unit * 5.6 * flipX, y + unit * 1.8 * flipY)
    .bezierCurveTo(
      x + unit * 6.5 * flipX,
      y + unit * 1.2 * flipY,
      x + unit * 7.2 * flipX,
      y + unit * 2.4 * flipY,
      x + unit * 6.1 * flipX,
      y + unit * 3 * flipY
    )
    .bezierCurveTo(
      x + unit * 5.3 * flipX,
      y + unit * 3.4 * flipY,
      x + unit * 5.6 * flipX,
      y + unit * 4.4 * flipY,
      x + unit * 6.6 * flipX,
      y + unit * 4.3 * flipY
    );
}

function resolvePdfAssetPath(configuredPath: string, fallbackPath: string) {
  const value = String(configuredPath || "").trim();
  const candidates = [
    value ? path.resolve(value) : "",
    value ? path.resolve(process.cwd(), value) : "",
    fallbackPath,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function cornerPatternPath(doc: any) {
  const primaryPath = path.join(process.cwd(), "assets", "korean-corner-pattern-1.jpeg");
  const configuredPath = String(doc.snsReaderCornerPatternPath || "").trim();

  return resolvePdfAssetPath(configuredPath, primaryPath);
}

function drawCornerPatternImages(doc: any, opacity = 0.5) {
  const patternPath = cornerPatternPath(doc);

  if (!patternPath) {
    return;
  }

  const { width, height } = doc.page;
  const size = 114;
  const pageInset = 9;
  const corners = [
    { x: width - size - pageInset, y: pageInset, rotate: 0 },
    { x: pageInset, y: height - size - pageInset, rotate: 180 },
  ];

  doc.save();
  doc.opacity(opacity);
  for (const corner of corners) {
    doc.save();
    doc.translate(corner.x + size / 2, corner.y + size / 2);
    doc.rotate(corner.rotate);
    doc.image(patternPath, -size / 2, -size / 2, { fit: [size, size], align: "right", valign: "top" });
    doc.restore();
  }
  doc.restore();
}

function drawPageDecoration(doc: any, options: { patterns?: boolean } = {}) {
  const { width, height } = doc.page;
  const margin = 24;

  if (!options.patterns) {
    return;
  }

  doc.save();
  doc.strokeColor("#d8d8d8").lineWidth(0.45).opacity(0.38);
  drawCornerMotif(doc, margin, margin, 1, 1);
  drawCornerMotif(doc, width - margin, margin, -1, 1);
  drawCornerMotif(doc, margin, height - margin, 1, -1);
  drawCornerMotif(doc, width - margin, height - margin, -1, -1);
  doc.stroke();

  doc.strokeColor("#eeeeee").lineWidth(0.35).opacity(0.24);
  for (let index = 0; index < 7; index += 1) {
    const offset = index * 16;
    doc
      .moveTo(width - 118 + offset, 210)
      .lineTo(width - 82 + offset, 246)
      .lineTo(width - 118 + offset, 282)
      .moveTo(58 + offset, height - 190)
      .lineTo(94 + offset, height - 154)
      .lineTo(58 + offset, height - 118);
  }
  doc.stroke();

  drawCornerPatternImages(doc, 0.5);
  doc.opacity(1);
  doc.restore();
}

function drawWrappedText(doc: any, text: string, styles: Record<string, any>, target: string, options: Record<string, any> = {}) {
  const style = applyPdfTextStyle(doc, styles, target);
  const fontSize = Number(style.fontSize || 11);
  const lineGap = Math.max(0, fontSize * (Number(style.lineHeight || 1.4) - 1));
  const x = options.x ?? doc.page.margins.left;
  const y = options.y ?? doc.y;
  const textOptions = { ...options };

  delete textOptions.x;
  delete textOptions.y;

  doc.text(String(text || ""), x, y, {
    width: options.width ?? doc.page.width - doc.page.margins.left - doc.page.margins.right,
    lineGap,
    underline: Boolean(style.underline),
    continued: false,
    ...textOptions,
  });
}

function splitLongToken(doc: any, token: string, width: number) {
  const parts: string[] = [];
  let current = "";

  for (const char of token) {
    const next = `${current}${char}`;

    if (current && doc.widthOfString(next) > width) {
      parts.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function wrapPdfLines(doc: any, text: string, width: number) {
  const lines: string[] = [];
  const paragraphs = String(text || "").replace(/\r\n/g, "\n").split("\n");

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }

    let current = "";
    const words = paragraph.trim().split(/\s+/);

    for (const rawWord of words) {
      const wordParts = doc.widthOfString(rawWord) > width ? splitLongToken(doc, rawWord, width) : [rawWord];

      for (const word of wordParts) {
        const next = current ? `${current} ${word}` : word;

        if (current && doc.widthOfString(next) > width) {
          lines.push(current);
          current = word;
        } else {
          current = next;
        }
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines;
}

function drawTextBox(doc: any, text: string, styles: Record<string, any>, target: string) {
  const style = applyPdfTextStyle(doc, styles, target);
  const fontSize = Number(style.fontSize || 10);
  const lineHeight = fontSize * Number(style.lineHeight || 1.2);
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const paddingX = 14;
  const paddingY = 12;
  const innerWidth = pageWidth - paddingX * 2;
  const lines = wrapPdfLines(doc, text, innerWidth);
  let index = 0;

  while (index < lines.length) {
    ensurePdfSpace(doc, paddingY * 2 + lineHeight * 2);

    const boxX = doc.page.margins.left;
    const boxY = doc.y;
    const bottom = pdfContentBottom(doc);
    const maxLines = Math.max(1, Math.floor((bottom - boxY - paddingY * 2) / lineHeight));
    const chunk = lines.slice(index, index + maxLines);
    const boxHeight = paddingY * 2 + chunk.length * lineHeight;

    doc.save();
    doc.roundedRect(boxX, boxY, pageWidth, boxHeight, 4).fill("#f4f4f1");
    doc.strokeColor("#ddddda").lineWidth(0.55).roundedRect(boxX, boxY, pageWidth, boxHeight, 4).stroke();
    doc.restore();

    applyPdfTextStyle(doc, styles, target);
    let y = boxY + paddingY;

    for (const line of chunk) {
      if (line) {
        doc.text(line, boxX + paddingX, y, {
          lineBreak: false,
          underline: Boolean(style.underline),
          width: innerWidth,
        });
      }
      y += lineHeight;
    }

    doc.y = boxY + boxHeight + 12;
    index += chunk.length;

    if (index < lines.length) {
      addPdfPage(doc);
      drawPageDecoration(doc, { patterns: true });
    }
  }
}

function pdfLineHeight(styles: Record<string, any>, target: string, isHeading = false) {
  const style = styles[target] ?? {};
  const fontSize = Number(style.fontSize || 10);

  if (isHeading) {
    return Math.max(14, fontSize * 1.45);
  }

  return fontSize * Number(style.lineHeight || 1.2);
}

function buildPdfContentLines(doc: any, post: Record<string, any>, settings: Record<string, any>, styles: Record<string, any>, width: number) {
  const lines: Array<{ text: string; target: string; height: number; heading?: boolean }> = [];

  const addBlank = () => {
    lines.push({ text: "", target: "body", height: 7 });
  };
  const addHeading = (text: string) => {
    lines.push({ text, target: "tags", height: pdfLineHeight(styles, "tags", true), heading: true });
  };
  const addText = (text: string, target: string) => {
    if (!String(text || "").trim()) {
      return;
    }

    applyPdfTextStyle(doc, styles, target);
    for (const line of wrapPdfLines(doc, text, width)) {
      lines.push({ text: line, target, height: pdfLineHeight(styles, target) });
    }
  };

  addText(post.body || post.bodyPreview || "", "body");

  if (settings.pdfFields?.includes("comments") && post.commentsText) {
    addBlank();
    addHeading("Comments");
    addText(post.commentsText, "comments");
  }

  if (settings.pdfFields?.includes("summary") && Array.isArray(post.summaryLines) && post.summaryLines.length) {
    addBlank();
    addHeading("Summary");
    addText(post.summaryLines.map((line: string) => `- ${line}`).join("\n"), "summary");
  }

  if (settings.pdfFields?.includes("tags") && Array.isArray(post.tags) && post.tags.length) {
    addBlank();
    addHeading("TAG");
    addText(post.tags.map((tag: string) => (tag.startsWith("#") ? tag : `#${tag}`)).join("  "), "tags");
  }

  return lines;
}

function drawColumnPanel(doc: any, x: number, y: number, width: number, height: number) {
  doc.save();
  doc.fillOpacity(0.5).roundedRect(x, y, width, height, 4).fill("#f4f4f1");
  doc.fillOpacity(1);
  doc.strokeColor("#ddddda").lineWidth(0.55).roundedRect(x, y, width, height, 4).stroke();
  doc.restore();
}

function measureContentLines(lines: Array<{ height: number }>) {
  return lines.reduce((sum, line) => sum + line.height, 0);
}

function drawContentLine(doc: any, line: { text: string; target: string; heading?: boolean }, styles: Record<string, any>, x: number, y: number, width: number) {
  if (line.heading) {
    doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(9.2).fillColor("#1f6f68");
  } else {
    applyPdfTextStyle(doc, styles, line.target);
  }

  if (line.text) {
    doc.text(line.text, x, y, {
      lineBreak: false,
      underline: Boolean((styles[line.target] ?? {}).underline),
      width,
    });
  }
}

function drawContentLinesChunk(doc: any, lines: Array<{ text: string; target: string; height: number; heading?: boolean }>, styles: Record<string, any>, x: number, y: number, width: number) {
  const paddingX = 8;
  const paddingY = 10;
  const chunkHeight = Math.max(34, measureContentLines(lines) + paddingY * 2);

  drawColumnPanel(doc, x, y, width, chunkHeight);

  let cursorY = y + paddingY;
  for (const line of lines) {
    drawContentLine(doc, line, styles, x + paddingX, cursorY, width - paddingX * 2);
    cursorY += line.height;
  }

  return y + chunkHeight;
}

function drawTextColumns(
  doc: any,
  lines: Array<{ text: string; target: string; height: number; heading?: boolean }>,
  styles: Record<string, any>,
  startY: number,
  columnCount = 2
) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 16;
  const safeColumnCount = Math.max(1, Math.min(3, Math.floor(columnCount)));
  const columnWidth = (pageWidth - gap * (safeColumnCount - 1)) / safeColumnCount;
  const columns = Array.from({ length: safeColumnCount }, (_item, index) => doc.page.margins.left + index * (columnWidth + gap));
  const bottom = pdfContentBottom(doc);
  const continuationTop = doc.page.margins.top + 10;
  let pageIndex = 0;
  let columnIndex = 0;
  let cursorY = startY;
  let chunkStartY = startY;
  let chunk: typeof lines = [];
  // `drawContentLinesChunk` draws a padded panel that reaches further down than
  // the raw sum of line heights (it adds top/bottom padding), so track its real
  // returned bottom edge instead of trusting `cursorY` for "where did the drawn
  // content actually end" - otherwise anything placed below it would overlap.
  let lastDrawnBottom = startY;

  const flushChunk = () => {
    if (!chunk.length) {
      return;
    }

    lastDrawnBottom = drawContentLinesChunk(doc, chunk, styles, columns[columnIndex], chunkStartY, columnWidth);
    chunk = [];
  };

  const advanceColumn = () => {
    flushChunk();
    if (columnIndex < safeColumnCount - 1) {
      columnIndex += 1;
      cursorY = pageIndex === 0 ? startY : continuationTop;
    } else {
      addPdfPage(doc);
      drawPageDecoration(doc, { patterns: true });
      pageIndex += 1;
      columnIndex = 0;
      cursorY = continuationTop;
    }
    chunkStartY = cursorY;
  };

  for (const line of lines) {
    if (chunk.length && cursorY + line.height > bottom) {
      advanceColumn();
    }

    chunk.push(line);
    cursorY += line.height;
  }

  flushChunk();

  return { pageIndex, columnIndex, y: lastDrawnBottom, columnWidth, gap };
}

function drawImageCell(doc: any, imagePath: string, x: number, y: number, width: number, height: number) {
  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill("#f4f4f1");
  doc.strokeColor("#ddddda").lineWidth(0.55).roundedRect(x, y, width, height, 4).stroke();
  doc.restore();

  try {
    doc.image(imagePath, x + 8, y + 8, { fit: [width - 16, height - 16], align: "center", valign: "center" });
  } catch {
    const sampleImage = defaultPdfSampleImagePaths()[0];

    if (sampleImage) {
      doc.image(sampleImage, x + 8, y + 8, { fit: [width - 16, height - 16], align: "center", valign: "center" });
    }
  }
}

function pdfImageAspectRatio(doc: any, imagePath: string) {
  try {
    const image = doc.openImage(imagePath);
    const width = Number(image?.width) || 0;
    const height = Number(image?.height) || 0;

    if (width > 0 && height > 0) {
      return width / height;
    }
  } catch {
    // Fall through to the default ratio below.
  }

  return 1.33;
}

function drawCollageImage(doc: any, imagePath: string, x: number, y: number, width: number, height: number) {
  doc.save();
  doc.rect(x, y, width, height).fill("#f4f4f1");

  try {
    doc.image(imagePath, x, y, { width, height });
  } catch {
    const sampleImage = defaultPdfSampleImagePaths()[0];

    if (sampleImage) {
      doc.image(sampleImage, x, y, { width, height });
    } else {
      doc.rect(x, y, width, height).fill("#b9cd92");
    }
  }

  doc.restore();
}

function packJustifiedMosaicRows(ratios: number[], width: number, targetRowHeight: number, gap: number) {
  const rows: Array<{ height: number; count: number }> = [];
  let index = 0;

  while (index < ratios.length) {
    let rowCount = 0;
    let rowRatioSum = 0;
    let rowWidthAtTarget = 0;

    while (index + rowCount < ratios.length) {
      const ratio = ratios[index + rowCount];
      const projectedWidth = rowWidthAtTarget + ratio * targetRowHeight + (rowCount > 0 ? gap : 0);

      if (rowCount > 0 && projectedWidth > width) {
        break;
      }

      rowWidthAtTarget = projectedWidth;
      rowRatioSum += ratio;
      rowCount += 1;
    }

    const rawRowHeight = (width - gap * (rowCount - 1)) / Math.max(0.01, rowRatioSum);
    const rowHeight = Math.max(18, Math.min(rawRowHeight, targetRowHeight * 1.8));

    rows.push({ height: rowHeight, count: rowCount });
    index += rowCount;
  }

  return rows;
}

function totalJustifiedMosaicHeight(rows: Array<{ height: number }>, gap: number) {
  if (rows.length === 0) {
    return 0;
  }

  return rows.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1);
}

// Lays out every image in width-justified rows so each one keeps its natural
// aspect ratio (never cropped, only scaled), then uniformly scales the whole
// mosaic so it fills the given box exactly on a single page/area - no matter
// how many images there are, everything always fits on one page.
function drawMosaicImageGrid(doc: any, imagePaths: string[], x: number, y: number, width: number, height: number, gap = 4) {
  const selectedImages = imagePaths.length ? imagePaths : defaultPdfSampleImagePaths();

  if (selectedImages.length === 0) {
    doc.rect(x, y, width, height).fill(pdfBookColors.collageFallbackA);
    return;
  }

  const ratios = selectedImages.map((imagePath) => pdfImageAspectRatio(doc, imagePath));
  let targetRowHeight = Math.max(24, Math.sqrt((width * height) / selectedImages.length));
  let rows = packJustifiedMosaicRows(ratios, width, targetRowHeight, gap);

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const naturalHeight = totalJustifiedMosaicHeight(rows, gap);

    if (naturalHeight <= 0) {
      break;
    }

    const adjustRatio = height / naturalHeight;

    if (adjustRatio > 0.96 && adjustRatio < 1.04) {
      break;
    }

    targetRowHeight = Math.max(6, targetRowHeight * adjustRatio);
    rows = packJustifiedMosaicRows(ratios, width, targetRowHeight, gap);
  }

  const naturalHeight = totalJustifiedMosaicHeight(rows, gap);
  // Each row is already justified to exactly `width`, so scaling above 1 would push
  // every row wider than the box (bleeding into whatever sits beside/below it).
  // Only ever shrink to fit the height; if the mosaic is naturally shorter than the
  // box (too few images to need the full height), keep it at natural size and
  // center it instead of stretching it past the box.
  const scale = naturalHeight > 0 ? Math.min(1, height / naturalHeight) : 1;
  const scaledWidth = width * scale;
  const scaledGap = gap * scale;
  let cursorY = y + Math.max(0, (height - naturalHeight * scale) / 2);
  let imageIndex = 0;

  for (const row of rows) {
    const rowHeight = Math.max(4, row.height * scale);
    const rowStartX = x + (width - scaledWidth) / 2;
    let cursorX = rowStartX;

    // Every cell keeps its own natural width (ratio * rowHeight) - never forced
    // to stretch and fill the row. A row-height cap (for very tall/narrow
    // images) or a short trailing row can leave real leftover width; that's
    // just left blank rather than distorting a real photo or adding filler.
    for (let cell = 0; cell < row.count; cell += 1) {
      const cellWidth = Math.max(4, ratios[imageIndex] * rowHeight);

      drawCollageImage(doc, selectedImages[imageIndex], cursorX, cursorY, cellWidth, rowHeight);
      cursorX += cellWidth + scaledGap;
      imageIndex += 1;
    }

    cursorY += rowHeight + scaledGap;
  }
}

function drawImageCollagePage(doc: any, imagePaths: string[], title = "") {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const outer = 34;
  const x = outer;
  const y = outer;
  const width = pageWidth - outer * 2;
  const height = pageHeight - outer * 2;

  doc.rect(0, 0, pageWidth, pageHeight).fill(pdfBookColors.coverBackground);
  drawMosaicImageGrid(doc, imagePaths, x, y, width, height, 5);

  if (title) {
    doc.save();
    doc.rect(x, pageHeight - outer - 42, width, 42).fillOpacity(0.62).fill("#26341d");
    doc
      .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
      .fontSize(13)
      .fillOpacity(1)
      .fillColor("#ffffff")
      .text(title, x + 16, pageHeight - outer - 28, { lineBreak: false, width: width - 32 });
    doc.restore();
  }

  return 1;
}

function drawBoxedMosaic(doc: any, imagePaths: string[], x: number, y: number, width: number, height: number) {
  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill("#f4f4f1");
  doc.strokeColor("#ddddda").lineWidth(0.55).roundedRect(x, y, width, height, 4).stroke();
  doc.restore();

  drawMosaicImageGrid(doc, imagePaths, x + 6, y + 6, width - 12, height - 12, 4);
}

function drawPostImageCollage(doc: any, imagePaths: string[], x: number, y: number, width: number, height: number) {
  drawBoxedMosaic(doc, imagePaths, x, y, width, height);
}

function drawFullPagePostImages(doc: any, imagePaths: string[], x: number, y: number, width: number, height: number, imageLayout = "collage") {
  if (imagePaths.length === 0) {
    return;
  }

  const shouldDrawCollage = imageLayout === "collage" || (imageLayout === "collage-individual" && imagePaths.length >= 4);
  const shouldDrawIndividuals = imageLayout === "individual" || imageLayout === "collage-individual";

  if (shouldDrawCollage) {
    drawBoxedMosaic(doc, imagePaths, x, y, width, height);
  }

  if (shouldDrawIndividuals) {
    if (shouldDrawCollage) {
      addPdfPage(doc);
      drawPageDecoration(doc, { patterns: true });
      drawImagesInColumnThenPages(
        doc,
        imagePaths,
        doc.page.margins.left,
        doc.page.margins.top + 10,
        doc.page.width - doc.page.margins.left - doc.page.margins.right,
        false
      );
    } else {
      drawImagesInColumnThenPages(doc, imagePaths, x, y, width, true);
    }
  }
}

function drawImageOnlyPdfPostPage(doc: any, post: Record<string, any>, settings: Record<string, any>, styles: Record<string, any>) {
  const imagePaths = pdfImagePathsFromPost(post);
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const topY = doc.y;
  const bottom = pdfContentBottom(doc);
  const availableHeight = Math.max(120, bottom - topY);

  if (!settings.pdfFields?.includes("images") || imagePaths.length === 0) {
    return false;
  }

  doc.save();
  applyPdfTextStyle(doc, styles, "tags");
  doc.fontSize(7.8).fillColor("#1f6f68").text(String(post.platformLabel || post.platform || "SNS").toUpperCase(), doc.page.margins.left, topY, {
    lineBreak: false,
    width: pageWidth * 0.5,
  });
  applyPdfTextStyle(doc, styles, "date");
  doc.text(String(post.date || post.dateIso || ""), doc.page.margins.left + pageWidth * 0.5, topY, {
    align: "right",
    lineBreak: false,
    width: pageWidth * 0.5,
  });
  doc.restore();

  const titleText = String(post.title || "Untitled Post");
  const titleY = topY + 22;
  const titleStyle = applyPdfTextStyle(doc, styles, "title");
  const titleFontSize = Number(titleStyle.fontSize || 13);
  const titleLineHeight = titleFontSize * Number(titleStyle.lineHeight || 1.25);
  const titleLines = wrapPdfLines(doc, titleText, pageWidth).slice(0, 2);

  titleLines.forEach((line, index) => {
    doc.text(line, doc.page.margins.left, titleY + index * titleLineHeight, {
      lineBreak: false,
      underline: Boolean(titleStyle.underline),
      width: pageWidth,
    });
  });

  const imageY = titleY + Math.max(titleLineHeight, titleLines.length * titleLineHeight) + 18;
  drawFullPagePostImages(
    doc,
    imagePaths,
    doc.page.margins.left,
    imageY,
    pageWidth,
    Math.max(120, bottom - imageY),
    String(settings.imageLayout || "collage")
  );

  return true;
}

function drawImagesInColumnThenPages(doc: any, imagePaths: string[], x: number, y: number, width: number, firstPageSingleColumn: boolean) {
  const bottom = pdfContentBottom(doc);
  const gap = 10;
  let index = 0;

  if (firstPageSingleColumn) {
    const cellHeight = Math.min(220, Math.max(120, (bottom - y - gap) / 2));
    let cursorY = y;

    while (index < imagePaths.length && cursorY + cellHeight <= bottom) {
      drawImageCell(doc, imagePaths[index], x, cursorY, width, cellHeight);
      cursorY += cellHeight + gap;
      index += 1;
    }
  }

  while (index < imagePaths.length) {
    addPdfPage(doc);
    drawPageDecoration(doc, { patterns: true });

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const columnGap = 16;
    const columnWidth = (pageWidth - columnGap) / 2;
    const columns = [doc.page.margins.left, doc.page.margins.left + columnWidth + columnGap];
    const top = doc.page.margins.top + 10;
    const cellHeight = 210;
    let cursorY = top;

    while (index < imagePaths.length) {
      let drewRow = false;

      for (let column = 0; column < 2 && index < imagePaths.length; column += 1) {
        if (cursorY + cellHeight > bottom) {
          break;
        }
        drawImageCell(doc, imagePaths[index], columns[column], cursorY, columnWidth, cellHeight);
        index += 1;
        drewRow = true;
      }

      if (!drewRow) {
        break;
      }

      cursorY += cellHeight + gap;
    }
  }
}

function drawPostContentColumns(doc: any, post: Record<string, any>, settings: Record<string, any>, styles: Record<string, any>) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const textColumnCount = getPdfTextColumnCount(settings);
  const gap = 16;
  const columnWidth = (pageWidth - gap * (textColumnCount - 1)) / textColumnCount;
  const columns = Array.from({ length: textColumnCount }, (_item, index) => doc.page.margins.left + index * (columnWidth + gap));
  const startY = doc.y;
  const bottom = pdfContentBottom(doc);
  const innerWidth = columnWidth - 16;
  const lines = buildPdfContentLines(doc, post, settings, styles, innerWidth);
  const imagePaths = pdfImagePathsFromPost(post);
  const imageLayout = String(settings.imageLayout || "collage");
  const shouldDrawCollage = imagePaths.length > 0 && (imageLayout === "collage" || (imageLayout === "collage-individual" && imagePaths.length >= 4));
  const shouldDrawIndividuals = imagePaths.length > 0 && (imageLayout === "individual" || imageLayout === "collage-individual");
  const leftCapacity = Math.max(0, bottom - startY - 20);
  const textFitsLeft = measureContentLines(lines) <= leftCapacity;

  // Individual images always live inside whichever text column has room; collage
  // images never share a page with text at all - they always get their own new
  // page, built with the exact same mosaic logic as the front/back overview
  // collage. So collage skips the "text | image column" layout entirely, even
  // when the text is short enough that it would otherwise qualify.
  if (!shouldDrawCollage && shouldDrawIndividuals && textColumnCount === 2 && textFitsLeft) {
    drawContentLinesChunk(doc, lines, styles, columns[0], startY, columnWidth);
    drawImagesInColumnThenPages(doc, imagePaths, columns[1], startY, columnWidth, true);
    return;
  }

  const textResult = drawTextColumns(doc, lines, styles, startY, textColumnCount);

  if (!imagePaths.length) {
    return;
  }

  if (shouldDrawCollage) {
    addPdfPage(doc);
    drawPageDecoration(doc, { patterns: true });
    drawPostImageCollage(
      doc,
      imagePaths,
      doc.page.margins.left,
      doc.page.margins.top + 10,
      pageWidth,
      pdfContentBottom(doc) - doc.page.margins.top - 10
    );

    if (shouldDrawIndividuals) {
      // `firstPageSingleColumn: false` already starts on a fresh page internally,
      // so no extra addPdfPage() here - that would leave one page blank.
      drawImagesInColumnThenPages(doc, imagePaths, doc.page.margins.left, doc.page.margins.top + 10, pageWidth, false);
    }

    return;
  }

  // Individual images that didn't fit beside the text (body ran past one
  // column's capacity): the text may have flowed into a second column that
  // ends well before the page bottom (e.g. a short Comments/Summary/TAG
  // block next to a long body) - or even onto a later page, if the body was
  // long enough to need one. Either way, place images in that same column's
  // leftover space on whichever page the text actually ended on, at that
  // column's width - never assume the full page width is free (the *other*
  // column may reach much further down) and never force a fresh page just
  // because earlier pages were needed for the text itself.
  const lastColumnX = columns[textResult.columnIndex];
  const inlineImagesTop = textResult.y + 14;
  const inlineImagesAvailable = bottom - inlineImagesTop;

  if (inlineImagesAvailable >= 150) {
    drawImagesInColumnThenPages(doc, imagePaths, lastColumnX, inlineImagesTop, textResult.columnWidth, true);
  } else {
    drawImagesInColumnThenPages(doc, imagePaths, doc.page.margins.left, doc.page.margins.top + 10, pageWidth, false);
  }
}

function drawHeading(doc: any, text: string) {
  ensurePdfSpace(doc, 52);
  doc.x = doc.page.margins.left;
  doc.moveDown(0.8);
  doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(15).fillColor("#1f6f68").text(text, doc.page.margins.left, doc.y, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
  doc.moveDown(0.35);
}

function drawPanelTitle(doc: any, text: string, x: number, y: number, width: number) {
  doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(15).fillColor("#1f6f68").text(text, x, y, {
    width,
  });
}

function drawFixedTextPanel(doc: any, lines: string[], styles: Record<string, any>, target: string, x: number, y: number, width: number, height: number, align: "left" | "center" = "left") {
  const paddingX = 12;
  const paddingY = 10;
  const style = applyPdfTextStyle(doc, styles, target);
  const fontSize = Number(style.fontSize || 10);
  const lineHeight = fontSize * Number(style.lineHeight || 1.2);
  const maxLines = Math.max(1, Math.floor((height - paddingY * 2) / lineHeight));
  const wrappedLines: string[] = [];

  for (const line of lines) {
    applyPdfTextStyle(doc, styles, target);
    wrappedLines.push(...wrapPdfLines(doc, line, width - paddingX * 2));
  }

  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill("#f6f7f3");
  doc.strokeColor("#d8ded9").lineWidth(1).roundedRect(x, y, width, height, 4).stroke();
  doc.restore();

  const displayLines = wrappedLines.slice(0, maxLines);
  const contentHeight = displayLines.length * lineHeight;
  const textY = y + Math.max(paddingY, (height - contentHeight) / 2);

  applyPdfTextStyle(doc, styles, target);
  displayLines.forEach((line, index) => {
    doc.text(line, x + paddingX, textY + index * lineHeight, {
      align,
      lineBreak: false,
      underline: Boolean(style.underline),
      width: width - paddingX * 2,
    });
  });
}

function drawMonthHeader(doc: any, monthKey: string, sequence: number, postCount: number) {
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);

  if (!match) {
    return;
  }

  const [, year, month] = match;
  const monthLabel = englishMonthNames[Number(month) - 1] ?? month;
  const x = doc.page.margins.left + 20;
  const y = 78;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right - 40;

  doc.save();
  doc.strokeColor("#1f6f68").lineWidth(1.8).moveTo(x, y).lineTo(x + width, y).stroke();
  doc.strokeColor("#d8ded9").lineWidth(0.8).moveTo(x, y + 70).lineTo(x + width, y + 70).stroke();
  doc
    .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
    .fontSize(42)
    .fillColor("#1f6f68")
    .text(String(sequence).padStart(2, "0"), x + 14, y + 15, { lineBreak: false });
  doc
    .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
    .fontSize(18)
    .fillColor("#1f6f68")
    .text(`${monthLabel}, ${year}`, x + 104, y + 22, { lineBreak: false });
  doc
    .font(resolvePdfFont({ fontFamily: "Malgun Gothic" }))
    .fontSize(9)
    .fillColor("#606965")
    .text(`${postCount} POSTS`, x + 106, y + 47, { lineBreak: false });
  doc.rect(x + width - 36, y + 70, 8, 16).fill("#1f6f68");
  doc.rect(x + width - 22, y + 70, 8, 16).fill("#1f6f68");
  doc.restore();
  doc.y = y + 104;
}

function drawBarChart(doc: any, items: Array<[string, number]> | Array<{ label: string; count: number }>, x: number, y: number, width: number, height: number) {
  const normalized = items.map((item) => (Array.isArray(item) ? { label: item[0], count: item[1] } : item));
  const max = Math.max(1, ...normalized.map((item) => item.count));
  const gap = 8;
  const paddingX = 16;
  const chartHeight = Math.min(height - 34, Math.max(78, height * 0.68));
  const chartTop = y + Math.max(12, (height - chartHeight - 22) / 2);
  const chartWidth = width - paddingX * 2;
  const barWidth = Math.max(12, (chartWidth - gap * Math.max(0, normalized.length - 1)) / Math.max(1, normalized.length));

  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill("#f6f7f3");
  doc.strokeColor("#d8ded9").lineWidth(1).roundedRect(x, y, width, height, 4).stroke();
  normalized.forEach((item, index) => {
    const barHeight = Math.max(3, chartHeight * (item.count / max));
    const barX = x + paddingX + index * (barWidth + gap);
    const barY = chartTop + chartHeight - barHeight;

    doc.fillColor("#1f6f68").rect(barX, barY, barWidth, barHeight).fill();
    doc.fillColor("#222222").fontSize(7).text(String(item.count), barX, barY - 10, { width: barWidth, align: "center" });
    doc.fillColor("#59635f").fontSize(6.5).text(item.label, barX - 4, chartTop + chartHeight + 8, { width: barWidth + 8, align: "center" });
  });
  doc.restore();
}

function truncatePdfLabel(value: string, maxLength = 22) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function drawHorizontalBarChart(doc: any, items: Array<{ label: string; count: number; meta?: string }>, x: number, y: number, width: number, height: number) {
  const normalized = items.slice(0, 5);
  const max = Math.max(1, ...normalized.map((item) => item.count));
  const rowHeight = 24;
  const totalRowsHeight = normalized.length * rowHeight;
  const rowsTop = y + Math.max(12, (height - totalRowsHeight) / 2);
  const labelWidth = Math.min(190, width * 0.38);
  const valueWidth = 36;
  const barX = x + labelWidth + 18;
  const barMaxWidth = width - labelWidth - valueWidth - 44;

  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill("#f6f7f3");
  doc.strokeColor("#d8ded9").lineWidth(1).roundedRect(x, y, width, height, 4).stroke();
  normalized.forEach((item, index) => {
    const rowY = rowsTop + index * rowHeight;
    const barWidth = item.count > 0 ? Math.max(8, barMaxWidth * (item.count / max)) : 3;

    doc
      .font(resolvePdfFont({ fontFamily: "Malgun Gothic" }))
      .fontSize(7.3)
      .fillColor("#2d3330")
      .text(item.label, x + 12, rowY + 1, { width: labelWidth, ellipsis: true });
    doc.fillColor("#4b4f4d").rect(barX, rowY + 5, barWidth, 9).fill();
    doc
      .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
      .fontSize(7)
      .fillColor("#1f6f68")
      .text(String(item.count), barX + barMaxWidth + 8, rowY + 2, { width: valueWidth, align: "right" });
    if (item.meta) {
      doc
        .font(resolvePdfFont({ fontFamily: "Malgun Gothic" }))
        .fontSize(6.4)
        .fillColor("#78807b")
        .text(item.meta, x + 12, rowY + 11, { width: labelWidth, ellipsis: true });
    }
  });
  doc.restore();
}

function drawWordCloud(doc: any, tagCounts: Array<[string, number]>, x: number, y: number, width: number, height: number) {
  const padding = 18;
  const palette = ["#1f77b4", "#2ca02c", "#d62728", "#9467bd", "#ff7f0e", "#17becf", "#bc1b8d", "#8c564b", "#4a90e2", "#6b4fbb"];
  const max = Math.max(1, tagCounts[0]?.[1] ?? 1);
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const minFontSize = 8;
  const maxFontSize = Math.min(30, Math.max(15, Math.min(usableWidth, usableHeight) * 0.13));
  const cloudItems = tagCounts.slice(0, 48).map(([tag, count], index) => {
    const label = tag.replace(/^#/, "");
    let size = minFontSize + Math.round(Math.sqrt(count / max) * (maxFontSize - minFontSize));

    doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(size);
    const maxWordWidth = usableWidth * 0.58;
    const measuredWidth = doc.widthOfString(label, { size });

    if (measuredWidth > maxWordWidth) {
      size = Math.max(minFontSize, Math.floor(size * (maxWordWidth / measuredWidth)));
      doc.fontSize(size);
    }

    return {
      label,
      size,
      color: palette[index % palette.length],
      textHeight: size * 1.05,
      textWidth: doc.widthOfString(label, { size }),
    };
  });
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const usableX = x + padding;
  const usableY = y + padding;
  const overlaps = (box: { x: number; y: number; width: number; height: number }) =>
    boxes.some(
      (placed) =>
        box.x < placed.x + placed.width &&
        box.x + box.width > placed.x &&
        box.y < placed.y + placed.height &&
        box.y + box.height > placed.y
    );

  doc.save();
  doc.roundedRect(x, y, width, height, 4).fill("#f6f7f3");
  doc.strokeColor("#d8ded9").lineWidth(1).roundedRect(x, y, width, height, 4).stroke();

  cloudItems.forEach((item, index) => {
    const rotation = index % 5 === 0 ? 90 : 0;
    const boxWidth = rotation ? item.textHeight : item.textWidth;
    const boxHeight = rotation ? item.textWidth : item.textHeight;
    let selectedBox: { x: number; y: number; width: number; height: number } | null = null;

    for (let step = 0; step < 240; step += 1) {
      const angle = step * 0.48 + index * 0.73;
      const radius = 2.1 * step;
      const candidate = {
        x: centerX + Math.cos(angle) * radius - boxWidth / 2,
        y: centerY + Math.sin(angle) * radius - boxHeight / 2,
        width: boxWidth + 8,
        height: boxHeight + 6,
      };

      if (
        candidate.x >= usableX &&
        candidate.y >= usableY &&
        candidate.x + candidate.width <= usableX + usableWidth &&
        candidate.y + candidate.height <= usableY + usableHeight &&
        !overlaps(candidate)
      ) {
        selectedBox = candidate;
        break;
      }
    }

    if (!selectedBox) {
      return;
    }

    boxes.push(selectedBox);
    doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(item.size).fillColor(item.color);

    if (rotation) {
      doc.save();
      doc.translate(selectedBox.x + selectedBox.width / 2, selectedBox.y + selectedBox.height / 2);
      doc.rotate(rotation);
      doc.text(item.label, -item.textWidth / 2, -item.textHeight / 2, { lineBreak: false });
      doc.restore();
    } else {
      doc.text(item.label, selectedBox.x + 4, selectedBox.y + 3, { lineBreak: false });
    }
  });
  doc.restore();
}

function drawMeshView(doc: any, posts: Array<Record<string, any>>, tagCounts: Array<[string, number]>, x: number, y: number, width: number, height: number) {
  const postTagMap = new Map<string, string[]>();
  const topTagEntries: Array<[string, number]> = tagCounts
    .map(([tag, count]) => [String(tag).replace(/^#/, ""), Number(count)] as [string, number])
    .filter(([tag]) => tag && !genericMeshTags.has(tag.toLowerCase()))
    .slice(0, 18);
  const topTags = topTagEntries.map(([tag]) => tag);
  const tagNames = new Set(topTags);
  const edgeWeights = new Map<string, PdfMeshEdge>();
  const postDegrees = new Map<string, number>();
  const postsByVisibleTag = new Map<string, string[]>();
  const graphPosts = posts;
  const postPositions = new Map<string, { x: number; y: number }>();
  const tagPanelGap = width > 340 ? 12 : 8;
  const tagPanelWidth = Math.min(120, Math.max(84, width * 0.24));
  const graphX = x;
  const graphY = y;
  const graphWidth = Math.max(90, width - tagPanelWidth - tagPanelGap);
  const graphHeight = height;
  const tagPanelX = graphX + graphWidth + tagPanelGap;
  const centerX = graphX + graphWidth / 2;
  const centerY = graphY + graphHeight / 2;
  const radius = Math.min(graphWidth, graphHeight) * 0.45;

  graphPosts.forEach((post) => {
    const tags = semanticTagsFromPost(post);

    postDegrees.set(post.id, 0);

    if (tags.length) {
      postTagMap.set(post.id, tags);
    }
  });

  graphPosts.forEach((post) => {
    (postTagMap.get(post.id) ?? [])
      .filter((tag) => tagNames.has(tag))
      .forEach((tag) => {
        const postIds = postsByVisibleTag.get(tag) ?? [];

        postIds.push(post.id);
        postsByVisibleTag.set(tag, postIds);
      });
  });

  postsByVisibleTag.forEach((postIds, tag) => {
    for (let leftIndex = 0; leftIndex < postIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < postIds.length; rightIndex += 1) {
        const from = postIds[leftIndex];
        const to = postIds[rightIndex];
        const key = pdfEdgeKey(from, to);
        const existingEdge = edgeWeights.get(key);

        if (existingEdge) {
          existingEdge.sharedTags.push(tag);
          existingEdge.weight += 1;
        } else {
          edgeWeights.set(key, { from, to, sharedTags: [tag], weight: 1 });
        }

        postDegrees.set(from, (postDegrees.get(from) ?? 0) + 1);
        postDegrees.set(to, (postDegrees.get(to) ?? 0) + 1);
      }
    }
  });

  const sortedEdges = Array.from(edgeWeights.values()).sort(
    (left, right) => right.weight - left.weight || (postDegrees.get(right.from) ?? 0) - (postDegrees.get(left.from) ?? 0)
  );
  const visibleEdges = selectBalancedPdfMeshEdges(sortedEdges, pdfMeshVisibleEdgeLimit);
  const maxDegree = Math.max(1, ...Array.from(postDegrees.values()));
  const layoutPosts = [...graphPosts].sort((left, right) => {
    const degreeDelta = (postDegrees.get(right.id) ?? 0) - (postDegrees.get(left.id) ?? 0);

    return degreeDelta || String(left.dateIso || "").localeCompare(String(right.dateIso || "")) || String(left.id).localeCompare(String(right.id));
  });
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  layoutPosts.forEach((post, index) => {
    const degree = postDegrees.get(post.id) ?? 0;
    const degreeRatio = Math.sqrt(degree / maxDegree);
    const baseRadius = Math.sqrt((index + 0.5) / Math.max(1, layoutPosts.length));
    const radialJitter = (hashToUnit(post.filePath || post.id, 31) - 0.5) * 0.08;
    const radial = clampNumber(baseRadius * (1 - degreeRatio * 0.22) + radialJitter, 0.06, 0.98);
    const angle = index * goldenAngle + hashToUnit(String(post.id) + String(post.dateIso || ""), 17) * 0.42;
    const jitterX = (hashToUnit(String(post.title || "") + String(post.id), 47) - 0.5) * radius * 0.045;
    const jitterY = (hashToUnit(String(post.id) + String(post.platform || ""), 59) - 0.5) * radius * 0.045;

    postPositions.set(post.id, {
      x: clampNumber(centerX + Math.cos(angle) * radius * radial + jitterX, graphX + 10, graphX + graphWidth - 10),
      y: clampNumber(centerY + Math.sin(angle) * radius * radial + jitterY, graphY + 10, graphY + graphHeight - 10),
    });
  });

  doc.save();
  doc.roundedRect(x, y, width, height, 5).fill("#f4f4f1");
  doc.strokeColor("#d8ded9").lineWidth(0.8).roundedRect(x, y, width, height, 5).stroke();
  doc.strokeColor("#e0e4df").lineWidth(0.6).moveTo(tagPanelX - tagPanelGap / 2, y + 10).lineTo(tagPanelX - tagPanelGap / 2, y + height - 10).stroke();
  doc.strokeColor("#ececea").lineWidth(0.35);
  for (let index = 0; index < 7; index += 1) {
    const guideX = graphX + 28 + index * Math.max(32, graphWidth / 7.5);
    doc.moveTo(guideX, graphY + 24).lineTo(guideX + 22, graphY + graphHeight - 24);
  }
  doc.stroke();

  visibleEdges.forEach((edge) => {
    const from = postPositions.get(edge.from);
    const to = postPositions.get(edge.to);

    if (!from || !to) {
      return;
    }

    doc.strokeColor("#9cb7af").lineWidth(0.25 + Math.min(3, edge.weight) * 0.08).moveTo(from.x, from.y).lineTo(to.x, to.y).stroke();
  });

  graphPosts.forEach((post) => {
    const point = postPositions.get(post.id);

    if (!point) {
      return;
    }

    const degree = postDegrees.get(post.id) ?? 0;
    const radiusSize = 0.8 + Math.sqrt(degree / maxDegree) * 2.2;
    const color = String(post.platform || "") === "facebook"
      ? "#2f7de1"
      : String(post.platform || "") === "instagram"
        ? "#c64f8a"
        : String(post.platform || "") === "threads"
          ? "#a78aef"
          : String(post.platform || "") === "youtube"
            ? "#d83b3b"
            : String(post.platform || "") === "naver-blog"
              ? "#18a05e"
              : "#8a96a3";

    doc.fillColor(color).circle(point.x, point.y, radiusSize).fill();
  });

  doc
    .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
    .fontSize(8)
    .fillColor("#1f6f68")
    .text("Top TAG", tagPanelX + 8, y + 14, {
      lineBreak: false,
      width: tagPanelWidth - 16,
    });

  const rowHeight = 16;
  const maxRows = Math.max(1, Math.floor((height - 42) / rowHeight));
  topTagEntries.slice(0, maxRows).forEach(([tag, count], index) => {
    const rowY = y + 34 + index * rowHeight;

    doc.strokeColor("#dfe4df").lineWidth(0.35).moveTo(tagPanelX + 8, rowY + rowHeight - 3).lineTo(tagPanelX + tagPanelWidth - 8, rowY + rowHeight - 3).stroke();
    doc
      .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
      .fontSize(6.6)
      .fillColor("#27302d")
      .text(truncatePdfLabel(tag, 11), tagPanelX + 8, rowY, {
        lineBreak: false,
        width: tagPanelWidth - 36,
      });
    doc
      .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
      .fontSize(6.6)
      .fillColor("#1f6f68")
      .text(String(count), tagPanelX + tagPanelWidth - 28, rowY, {
        align: "right",
        lineBreak: false,
        width: 20,
      });
  });
  doc.restore();
}

function drawPostImages(doc: any, post: Record<string, any>, settings: Record<string, any>) {
  if (!Array.isArray(post.imageUrls) || post.imageUrls.length === 0 || !settings.pdfFields?.includes("images")) {
    return;
  }

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const imagePaths = pdfImagePathsFromPost(post);

  if (imagePaths.length === 0) {
    return;
  }

  drawHeading(doc, "Images");

  if (settings.imageLayout === "collage") {
    const columns = 2;
    const gap = 10;
    const cellWidth = (pageWidth - gap) / columns;
    const cellHeight = 150;

    imagePaths.forEach((imagePath: string, index: number) => {
      if (index % columns === 0) {
        ensurePdfSpace(doc, cellHeight + 12);
      }

      const x = doc.page.margins.left + (index % columns) * (cellWidth + gap);
      const y = doc.y;

      try {
        doc.image(imagePath, x, y, { fit: [cellWidth, cellHeight], align: "center", valign: "center" });
      } catch {
        const sampleImage = defaultPdfSampleImagePaths()[0];

        if (sampleImage) {
          doc.image(sampleImage, x, y, { fit: [cellWidth, cellHeight], align: "center", valign: "center" });
        }
      }

      if (index % columns === columns - 1 || index === imagePaths.length - 1) {
        doc.y = y + cellHeight + 12;
      }
    });
    return;
  }

  for (const imagePath of imagePaths) {
    const imageHeight = 360;

    ensurePdfSpace(doc, imageHeight + 16);
    try {
      doc.image(imagePath, doc.page.margins.left, doc.y, { fit: [pageWidth, imageHeight], align: "center", valign: "center" });
      doc.y += imageHeight + 16;
    } catch {
      const sampleImage = defaultPdfSampleImagePaths()[0];

      if (sampleImage) {
        doc.image(sampleImage, doc.page.margins.left, doc.y, { fit: [pageWidth, imageHeight], align: "center", valign: "center" });
        doc.y += imageHeight + 16;
      }
    }
  }
}

const compactPdfStyles: Record<string, Record<string, unknown>> = {
  title: { fontFamily: "Malgun Gothic", fontSize: 16, color: "#111111", colorDark: "#f5f5f0", bold: true, italic: false, underline: false, lineHeight: 1.18 },
  date: { fontFamily: "Malgun Gothic", fontSize: 8, color: "#666666", colorDark: "#b7bdb9", bold: false, italic: false, underline: false, lineHeight: 1.05 },
  body: { fontFamily: "Malgun Gothic", fontSize: 9.5, color: "#222222", colorDark: "#e8e6df", bold: false, italic: false, underline: false, lineHeight: 1.18 },
  comments: { fontFamily: "Malgun Gothic", fontSize: 8.5, color: "#555555", colorDark: "#c7ccc8", bold: false, italic: false, underline: false, lineHeight: 1.15 },
  summary: { fontFamily: "Malgun Gothic", fontSize: 8.8, color: "#333333", colorDark: "#d8d5cb", bold: false, italic: true, underline: false, lineHeight: 1.16 },
  tags: { fontFamily: "Malgun Gothic", fontSize: 8.5, color: "#1f6f68", colorDark: "#8ed8c8", bold: true, italic: false, underline: false, lineHeight: 1.12 },
};

const pdfBookColors = {
  coverBackground: "#fbfaf6",
  coverSpine: "#f1f0ea",
  collageFallbackA: "#f4f4f1",
  collageFallbackB: "#ecebe5",
};

const legacyPdfStyles: Record<string, Record<string, unknown>> = {
  title: { fontSize: 18, lineHeight: 1.25 },
  date: { fontSize: 9, lineHeight: 1.2 },
  body: { fontSize: 11, lineHeight: 1.55 },
  comments: { fontSize: 9, lineHeight: 1.4 },
  summary: { fontSize: 10, lineHeight: 1.4 },
  tags: { fontSize: 9, lineHeight: 1.25 },
};

function normalizePdfFontFamily(fontFamily: string) {
  return fontFamily === "Nanum Gothic" ? "NanumGothic" : fontFamily;
}

function resolvePdfFontCatalog(settings: Record<string, any>) {
  const fonts = Array.isArray(settings.pdfFonts) ? settings.pdfFonts : [];
  const entries: Array<[string, { family: string; regularPath: string; boldPath: string }]> = [];

  for (const font of fonts) {
    const family = normalizePdfFontFamily(String(font.fontFamily || font.label || "").trim());

    if (!family) {
      continue;
    }

    entries.push([
      family.toLowerCase(),
      {
        family,
        regularPath: String(font.regularPath || "").trim(),
        boldPath: String(font.boldPath || "").trim(),
      },
    ]);
  }

  return new Map(entries);
}

function normalizePdfStylesForBook(savedStyles: Record<string, any> = {}, requestStyles: Record<string, any> = {}, settings: Record<string, any> = {}) {
  const fontCatalog = resolvePdfFontCatalog(settings);

  return Object.fromEntries(
    Object.entries(compactPdfStyles).map(([target, defaultStyle]) => {
      const incomingStyle = { ...(savedStyles[target] ?? {}), ...(requestStyles[target] ?? {}) };
      const legacyStyle = legacyPdfStyles[target];
      const isLegacyDefault = Object.entries(legacyStyle).every(([key, value]) => incomingStyle[key] === value);
      const style = isLegacyDefault ? { ...defaultStyle } : { ...defaultStyle, ...incomingStyle };
      const fontFamily = normalizePdfFontFamily(String(style.fontFamily || ""));
      const font = fontCatalog.get(fontFamily.toLowerCase());

      // `style.color` (light) is what actually gets printed - the PDF page
      // background is always the same light cream regardless of the app's own
      // theme. `style.colorDark` only exists for the in-app style preview
      // (editing comfort while the app itself is in dark mode).
      return [
        target,
        {
          ...style,
          fontFamily,
          fontRegularPath: font?.regularPath || "",
          fontBoldPath: font?.boldPath || font?.regularPath || "",
        },
      ];
    })
  );
}

function resolvePdfCoverImagePath(settings: Record<string, any>) {
  const isLandscape = settings.pdfPageOrientation === "landscape";
  const orientedPath = isLandscape ? settings.pdfLandscapeCoverImagePath : settings.pdfPortraitCoverImagePath;
  const configuredPath = String(orientedPath || settings.pdfCoverImagePath || "").trim();
  const candidates = [
    configuredPath ? path.resolve(configuredPath) : "",
    configuredPath ? path.resolve(process.cwd(), configuredPath) : "",
    path.join(process.cwd(), "assets", isLandscape ? "Cover-Wide2.png" : "Cover-Long3.jpeg"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function writePdfBook(
  settingsFilePath: string,
  requestSettings: Record<string, any>,
  options: {
    cardsPayload?: MarkdownCardsPayload;
    posts?: Array<Record<string, any>>;
    range?: PdfBookRange;
    fileName?: string;
    volumeIndex?: number;
    volumeCount?: number;
  } = {}
) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const savedSettings = rawSettings ? JSON.parse(rawSettings) : {};
  const settings = {
    ...savedSettings,
    ...requestSettings,
  };
  settings.pdfStyles = normalizePdfStylesForBook(savedSettings.pdfStyles, requestSettings.pdfStyles, settings);
  const cardsPayload = options.cardsPayload ?? await buildMarkdownCards(settingsFilePath);
  const posts = options.posts ?? filterPdfPosts(cardsPayload.cards, settings);

  if (posts.length === 0) {
    throw new Error("PDF에 포함할 Markdown 카드가 없습니다.");
  }

  const baseRange = options.range ?? getPdfRange(settings, cardsPayload.cards);
  const testLabel = String(settings.pdfBookLabel || "").trim();
  const labelSuffix = testLabel ? ` ${testLabel}` : "";
  const pdfPageLayout = settings.pdfPageOrientation === "landscape" ? "landscape" : "portrait";
  const range = {
    ...baseRange,
    title: `${baseRange.title}${labelSuffix}`,
    label: baseRange.label,
  };
  const outputRoot = path.resolve(settings.pdfOutputFolder || path.join(process.cwd(), "exports", "pdf"));
  const fileName = String(options.fileName || pdfOutputFileName(baseRange));
  const pdfPath = path.join(outputRoot, fileName);
  const metaPath = pdfMetadataPath(pdfPath);
  const styles = settings.pdfStyles ?? {};

  await mkdir(outputRoot, { recursive: true });

  const doc = new PDFDocument({
    autoFirstPage: true,
    bufferPages: true,
    margin: 42,
    layout: pdfPageLayout,
    size: "A4",
    info: {
      Title: range.title,
      Author: "SNS Reader",
      Subject: range.label,
    },
  });
  doc.snsReaderPageLayout = pdfPageLayout;
  doc.snsReaderCornerPatternPath = String(settings.pdfCornerPatternPath || "");
  const stream = createWriteStream(pdfPath);
  const finished = new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  doc.pipe(stream);

  let rangeInfo: { start: number; count: number } = { start: 0, count: 0 };

  // If anything below throws (bad image, unexpected field, etc.) after piping has already
  // started, the partially-written file must not be left on disk looking like a finished book.
  try {

  await ensureHighQualityPdfImages(posts);

  const platforms = topEntries(countBy(posts, (post) => String(post.platformLabel || post.platform || "SNS")), 12);
  const allTags = posts.flatMap((post) => (Array.isArray(post.tags) ? post.tags : []));
  const tagCounts = topEntries(countBy(allTags, (tag) => String(tag).replace(/^#/, "")), 40);
  const summaryLines = buildPdfOverviewSummaryLines(posts, tagCounts);
  const bins = makePeriodBins(posts);
  const topPosts = posts
    .map((post) => ({ post, score: reactionScore(post) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  const allImagePaths = uniqueStrings(posts.flatMap(postImagePaths));
  const frontCollageImages = randomPdfCollageImages(allImagePaths, PDF_OVERVIEW_COLLAGE_IMAGE_COUNT);
  const backCollageImages = randomPdfCollageImages(allImagePaths, PDF_OVERVIEW_COLLAGE_IMAGE_COUNT);
  const monthCounts = countBy(posts, monthKeyFromPost);

  const coverStart = (range.from || "").replaceAll("-", "/");
  const coverEnd = (range.to || "").replaceAll("-", "/");
  const coverImagePath = resolvePdfCoverImagePath(settings);
  const coverPeriod = coverEnd && coverEnd !== coverStart ? `${coverStart} - ${coverEnd}` : coverStart || "ALL POSTS";
  const coverMarginX = 74;
  const coverImageWidth = Math.min(360, doc.page.width - 66 - coverMarginX * 2);
  const coverImageHeight = Math.min(560, doc.page.height - 210);
  const coverImageX = Math.max(coverMarginX, (doc.page.width - 66 - coverImageWidth) / 2);
  const coverImageY = Math.max(110, (doc.page.height - coverImageHeight) / 2 - 12);

  doc.rect(0, 0, doc.page.width, doc.page.height).fill(pdfBookColors.coverBackground);
  doc.rect(doc.page.width - 66, 0, 66, doc.page.height).fill(pdfBookColors.coverSpine);
  doc.strokeColor("#d9d7cf").lineWidth(0.8).moveTo(doc.page.width - 66, 0).lineTo(doc.page.width - 66, doc.page.height).stroke();

  doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(10).fillColor("#4b4f4d").text("SNS ARCHIVE", 74, 58, {
    characterSpacing: 1.2,
  });
  doc.strokeColor("#d8ded9").lineWidth(0.9).moveTo(74, 82).lineTo(312, 82).stroke();

  if (existsSync(coverImagePath)) {
    doc.image(coverImagePath, coverImageX, coverImageY, { fit: [coverImageWidth, coverImageHeight], align: "center", valign: "center" });
  } else {
    doc.roundedRect(coverImageX, coverImageY, coverImageWidth, coverImageHeight, 5).fill("#f4f4f1");
    doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(18).fillColor("#4b4f4d").text("SNS READER", coverImageX, coverImageY + coverImageHeight / 2 - 12, {
      align: "center",
      width: coverImageWidth,
    });
  }

  doc.font(resolvePdfFont({ fontFamily: "Malgun Gothic" })).fontSize(8.5).fillColor("#7a817d").text(`${posts.length} posts / ${platforms.map(([label]) => label).join(", ")}`, 74, doc.page.height - 116, {
    width: 360,
  });
  doc.fontSize(7.5).fillColor("#9a9f9b").text(`Created ${new Date().toLocaleString("ko-KR")}`, 74, doc.page.height - 100, {
    width: 360,
  });

  doc.save();
  doc.translate(doc.page.width - 33, doc.page.height / 2);
  doc.rotate(90);
  doc
    .font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" }))
    .fontSize(30)
    .fillColor("#4b4f4d")
    .text(coverPeriod, -doc.page.height * 0.42, -18, {
      align: "center",
      lineBreak: false,
      width: doc.page.height * 0.84,
    });
  doc.restore();

  addPdfPage(doc);
  const frontCollagePagesUsed = drawImageCollagePage(doc, frontCollageImages);

  addPdfPage(doc);
  drawPageDecoration(doc);
  doc.rect(0, 0, doc.page.width, 108).fill("#eef2e8");
  doc.font(resolvePdfFont({ bold: true, fontFamily: "Malgun Gothic" })).fontSize(20).fillColor("#1f6f68").text("POST SUMMARY", doc.page.margins.left, 48, {
    align: "center",
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });

  const overviewX = doc.page.margins.left;
  const overviewWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const panelTitleHeight = 22;
  const panelGap = 14;
  const overviewTop = 134;
  const overviewBottom = pdfContentBottom(doc);
  const summaryPanelLines = summaryLines.length
    ? [summaryLines.join(" ")]
    : ["Summary will be generated after Summary and TAG enrichment."];
  const isLandscapePdf = settings.pdfPageOrientation === "landscape";

  if (isLandscapePdf) {
    const columnGap = 22;
    const leftWidth = Math.round((overviewWidth - columnGap) * 0.42);
    const rightWidth = overviewWidth - columnGap - leftWidth;
    const rightX = overviewX + leftWidth + columnGap;
    const availableHeight = overviewBottom - overviewTop;
    const leftPanelTotal = availableHeight - panelTitleHeight * 2 - panelGap;
    const summaryPanelHeight = Math.round(leftPanelTotal * 0.36);
    const postingsPanelHeight = leftPanelTotal - summaryPanelHeight;
    const thinkingPanelHeight = availableHeight - panelTitleHeight;
    let leftY = overviewTop;

    drawPanelTitle(doc, "Summary", overviewX, leftY, leftWidth);
    leftY += panelTitleHeight;
    drawFixedTextPanel(doc, summaryPanelLines, styles, "summary", overviewX, leftY, leftWidth, summaryPanelHeight, "left");
    leftY += summaryPanelHeight + panelGap;

    drawPanelTitle(doc, "Postings", overviewX, leftY, leftWidth);
    leftY += panelTitleHeight;
    drawBarChart(doc, bins, overviewX, leftY, leftWidth, postingsPanelHeight);

    drawPanelTitle(doc, "Thinking", rightX, overviewTop, rightWidth);
    drawWordCloud(doc, tagCounts, rightX, overviewTop + panelTitleHeight, rightWidth, thinkingPanelHeight);
  } else {
    const overviewBoxTotal = overviewBottom - overviewTop - panelTitleHeight * 3 - panelGap * 2;
    const summaryPanelHeight = Math.round(overviewBoxTotal * 0.26);
    const thinkingPanelHeight = Math.round(overviewBoxTotal * 0.37);
    const postingsPanelHeight = overviewBoxTotal - summaryPanelHeight - thinkingPanelHeight;
    let overviewY = overviewTop;

    drawPanelTitle(doc, "Summary", overviewX, overviewY, overviewWidth);
    overviewY += panelTitleHeight;
    drawFixedTextPanel(doc, summaryPanelLines, styles, "summary", overviewX, overviewY, overviewWidth, summaryPanelHeight, "left");
    overviewY += summaryPanelHeight + panelGap;

    drawPanelTitle(doc, "Thinking", overviewX, overviewY, overviewWidth);
    overviewY += panelTitleHeight;
    drawWordCloud(doc, tagCounts, overviewX, overviewY, overviewWidth, thinkingPanelHeight);
    overviewY += thinkingPanelHeight + panelGap;

    drawPanelTitle(doc, "Postings", overviewX, overviewY, overviewWidth);
    overviewY += panelTitleHeight;
    drawBarChart(doc, bins, overviewX, overviewY, overviewWidth, postingsPanelHeight);
  }

  addPdfPage(doc);
  drawPageDecoration(doc);

  const insightX = doc.page.margins.left;
  const insightWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const insightTop = 70;
  const insightGap = 18;
  const insightBottom = pdfContentBottom(doc);
  const favoriteItems = topPosts.map(({ post, score }, index) => ({
    label: `${index + 1}. ${truncatePdfLabel(post.title || post.bodyPreview || "Untitled")}`,
    count: score,
    meta: String(post.platformLabel || post.platform || "SNS"),
  }));

  if (isLandscapePdf) {
    const columnGap = 22;
    const leftWidth = Math.round((insightWidth - columnGap) * 0.4);
    const rightWidth = insightWidth - columnGap - leftWidth;
    const panelHeight = insightBottom - insightTop - panelTitleHeight;
    const rightX = insightX + leftWidth + columnGap;

    drawPanelTitle(doc, "Favorite Posts", insightX, insightTop, leftWidth);
    drawHorizontalBarChart(doc, favoriteItems, insightX, insightTop + panelTitleHeight, leftWidth, panelHeight);

    drawPanelTitle(doc, "Mesh View", rightX, insightTop, rightWidth);
    drawMeshView(doc, posts, tagCounts, rightX, insightTop + panelTitleHeight, rightWidth, panelHeight);
  } else {
    const insightBoxTotal = insightBottom - insightTop - panelTitleHeight * 2 - insightGap;
    const favoritePanelHeight = Math.round(insightBoxTotal * 0.4);
    const meshPanelHeight = insightBoxTotal - favoritePanelHeight;
    let insightY = insightTop;

    drawPanelTitle(doc, "Favorite Posts", insightX, insightY, insightWidth);
    insightY += panelTitleHeight;
    drawHorizontalBarChart(doc, favoriteItems, insightX, insightY, insightWidth, favoritePanelHeight);
    insightY += favoritePanelHeight + insightGap;

    drawPanelTitle(doc, "Mesh View", insightX, insightY, insightWidth);
    insightY += panelTitleHeight;
    drawMeshView(doc, posts, tagCounts, insightX, insightY, insightWidth, meshPanelHeight);
  }

  let currentMonthKey = "";
  let monthSequence = 0;

  for (const post of posts) {
    const nextMonthKey = monthKeyFromPost(post);

    addPdfPage(doc);
    drawPageDecoration(doc, { patterns: true });

    if (nextMonthKey && nextMonthKey !== currentMonthKey) {
      currentMonthKey = nextMonthKey;
      monthSequence += 1;
      drawMonthHeader(doc, nextMonthKey, monthSequence, monthCounts.get(nextMonthKey) ?? 0);
    }

    if (isImageOnlyPdfPost(post) && drawImageOnlyPdfPostPage(doc, post, settings, styles)) {
      continue;
    }

    applyPdfTextStyle(doc, styles, "tags");
    doc.x = doc.page.margins.left;
    doc.text(String(post.platformLabel || post.platform || "SNS").toUpperCase(), doc.page.margins.left, doc.y, {
      align: "left",
      lineBreak: false,
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
    doc.moveDown(0.6);
    drawWrappedText(doc, post.title || "Untitled Post", styles, "title");
    drawWrappedText(doc, String(post.date || post.dateIso || ""), styles, "date", { align: "right" });
    doc.moveDown(0.8);
    drawPostContentColumns(doc, post, settings, styles);
  }

  addPdfPage(doc);
  const backCollagePagesUsed = drawImageCollagePage(doc, backCollageImages);

  rangeInfo = doc.bufferedPageRange();
  const frontCollageStart = rangeInfo.start + 1;
  const frontCollageEnd = frontCollageStart + frontCollagePagesUsed - 1;
  const backCollageEnd = rangeInfo.start + rangeInfo.count - 1;
  const backCollageStart = backCollageEnd - backCollagePagesUsed + 1;

  for (let index = rangeInfo.start + 1; index < rangeInfo.start + rangeInfo.count; index += 1) {
    const inFrontCollage = index >= frontCollageStart && index <= frontCollageEnd;
    const inBackCollage = index >= backCollageStart && index <= backCollageEnd;

    if (inFrontCollage || inBackCollage) {
      continue;
    }

    doc.switchToPage(index);
    doc.font(resolvePdfFont({ fontFamily: "Malgun Gothic" })).fontSize(8).fillColor("#7b8580").text(
      `SNS Reader - ${index + 1} / ${rangeInfo.count}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom - 12,
      {
        align: "center",
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      }
    );
  }

  doc.end();
  await finished;
  } catch (error) {
    stream.destroy();
    await rm(pdfPath, { force: true }).catch(() => {});
    throw error;
  }

  const book = {
    id: pdfPath,
    title: range.title,
    dateRange: range.label,
    pageCount: rangeInfo.count,
    postCount: posts.length,
    filePath: pdfPath,
    url: `/api/pdf-file?path=${encodeURIComponent(pdfPath)}`,
    createdAt: new Date().toLocaleDateString("ko-KR"),
  };

  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(book, null, 2)}\n`, "utf8");

  return book;
}

async function writePdfBooks(settingsFilePath: string, requestSettings: Record<string, any>) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const savedSettings = rawSettings ? JSON.parse(rawSettings) : {};
  const settings = {
    ...savedSettings,
    ...requestSettings,
    // File-system roots must only ever come from the persisted settings file (set via the
    // dedicated Settings screen / `/api/settings` PUT), never from this request body - otherwise
    // a PDF-creation request could redirect where files get written/read on disk.
    pdfOutputFolder: savedSettings.pdfOutputFolder,
    obsidianRootFolder: savedSettings.obsidianRootFolder,
  };
  settings.pdfStyles = normalizePdfStylesForBook(savedSettings.pdfStyles, requestSettings.pdfStyles, settings);
  // Build a fresh payload object rather than mutating the one buildMarkdownCards
  // returns - on a cache hit/miss it can be (or share `cards` with) the shared
  // markdown-cards cache, and other callers (like /api/markdown-cards) must
  // keep seeing every platform regardless of this book's platform filter.
  const rawCardsPayload = await buildMarkdownCards(settingsFilePath);
  const cardsPayload = { ...rawCardsPayload, cards: filterCardsByPlatform(rawCardsPayload.cards, settings) };

  if (settings.pdfSplitMode === "year") {
    const ranges = parsePdfYearRanges(settings.pdfYear);
    const rangedPosts = ranges
      .map((range) => ({ range, posts: filterCardsByRange(cardsPayload.cards, range) }))
      .filter((entry) => entry.posts.length > 0);
    const books = [];

    for (const { range, posts } of rangedPosts) {
      books.push(
        await writePdfBook(settingsFilePath, settings, {
          cardsPayload,
          posts,
          range,
          volumeCount: rangedPosts.length,
          volumeIndex: books.length + 1,
        })
      );
    }

    if (books.length === 0) {
      throw new Error("선택한 연도 범위에 포함할 Markdown 카드가 없습니다.");
    }

    return books;
  }

  if (settings.pdfSplitMode === "page-count") {
    const range = getPdfRange(settings, cardsPayload.cards);
    const posts = filterCardsByRange(cardsPayload.cards, range);
    const chunks = chunkPostsByTargetPages(posts, settings);
    const books = [];
    const usedFileNames = new Set<string>();

    if (chunks.length === 0) {
      throw new Error("PDF에 포함할 Markdown 카드가 없습니다.");
    }

    for (const chunk of chunks) {
      const chunkRange = pdfRangeFromPosts(chunk);

      books.push(
        await writePdfBook(settingsFilePath, settings, {
          cardsPayload,
          posts: chunk,
          range: chunkRange,
          fileName: pdfOutputFileNameForRange(chunkRange, usedFileNames),
          volumeCount: chunks.length,
          volumeIndex: books.length + 1,
        })
      );
    }

    return books;
  }

  return [await writePdfBook(settingsFilePath, settings, { cardsPayload })];
}

async function walkPdfFiles(root: string, files: string[] = []) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith("_")) {
        continue;
      }

      await walkPdfFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function buildPdfBooks(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const root = path.resolve(settings.pdfOutputFolder || path.join(process.cwd(), "exports", "pdf"));
  const files = await walkPdfFiles(root);
  const books = [];

  for (const filePath of files) {
    const metadata = await readFile(pdfMetadataPath(filePath), "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => readFile(filePath.replace(/\.pdf$/i, ".json"), "utf8").then((raw) => JSON.parse(raw)))
      .catch(() => ({}));
    const fileStat = await stat(filePath).catch(() => null);
    const fileNameMatch = path.basename(filePath, ".pdf").match(/^SNS\s+(\d{4})\.(\d{2})-(\d{4})\.(\d{2})/);
    const parsedDateRange = fileNameMatch
      ? `${fileNameMatch[1]}.${fileNameMatch[2]}.01 - ${fileNameMatch[3]}.${fileNameMatch[4]}.31`
      : "";

    books.push({
      id: filePath,
      title: metadata.title || path.basename(filePath, ".pdf"),
      dateRange: metadata.dateRange || parsedDateRange,
      pageCount: Number(metadata.pageCount || 0),
      postCount: Number(metadata.postCount || 0),
      filePath,
      url: `/api/pdf-file?path=${encodeURIComponent(filePath)}`,
      coverUrl: `/api/pdf-page?path=${encodeURIComponent(filePath)}&page=1&dpi=70`,
      createdAt: metadata.createdAt || (fileStat ? fileStat.mtime.toLocaleDateString("ko-KR") : ""),
    });
  }

  return {
    books: books.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
    root,
  };
}

function getPdftoppmPath() {
  const candidates = [
    process.env.SNS_READER_PDFTOPPM_PATH || "",
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "poppler", "Library", "bin", "pdftoppm.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "pdftoppm";
}

async function renderPdfPagePreview(settingsFilePath: string, filePath: string, page: number, dpi: number) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const root = path.resolve(settings.pdfOutputFolder || path.join(process.cwd(), "exports", "pdf"));
  const resolvedFilePath = path.resolve(filePath);

  if (!resolvedFilePath.toLowerCase().endsWith(".pdf") || !isPathInside(resolvedFilePath, root)) {
    throw new Error("PDF path is outside the configured PDF folder.");
  }

  const fileStat = await stat(resolvedFilePath);
  const pageNumber = Math.min(9999, Math.max(1, Math.floor(Number(page) || 1)));
  const renderDpi = Math.min(180, Math.max(45, Math.floor(Number(dpi) || 90)));
  const cacheRoot = path.join(process.cwd(), "data", "runtime", "pdf-preview-cache");
  const cacheKey = createHash("sha1")
    .update(`${resolvedFilePath}:${fileStat.size}:${fileStat.mtimeMs}:${pageNumber}:${renderDpi}`)
    .digest("hex");
  const outputPrefix = path.join(cacheRoot, cacheKey);
  const outputPath = `${outputPrefix}.png`;

  if (existsSync(outputPath)) {
    return outputPath;
  }

  await mkdir(cacheRoot, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(getPdftoppmPath(), [
      "-png",
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-singlefile",
      "-r",
      String(renderDpi),
      resolvedFilePath,
      outputPrefix,
    ]);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `pdftoppm failed with exit code ${code}`));
    });
  });

  return outputPath;
}

async function runSnsReadPipeline(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  const enabledFacebookAccounts = accounts.filter(
    (account: { platform?: string; exportToObsidian?: boolean }) =>
      account.platform === "facebook" && account.exportToObsidian !== false
  );

  if (enabledFacebookAccounts.length === 0) {
    return {
      ok: false,
      message: "No enabled Facebook account is configured for SNS Read.",
      output: ""
    };
  }

  const importResult = await runNodeScript(path.resolve(process.cwd(), "tools/import-facebook-export.mjs"));
  const dedupeResult = await runDedupeMarkdown("facebook");
  const validateResult = await runNodeScript(path.resolve(process.cwd(), "tools/validate-sns-markdown.mjs"));
  const enrichResult = await runNodeScript(path.resolve(process.cwd(), "tools/enrich-sns-markdown.mjs"), [
    "--platform",
    "all",
    "--skip-any-existing"
  ]);
  invalidateMarkdownCardsCache();
  const cardsPayload = await buildMarkdownCards(settingsFilePath);

  return {
    ok: true,
    message: `SNS Read complete. ${cardsPayload.cards.length} Markdown cards are available.`,
    cards: cardsPayload.cards.length,
    output: [
      importResult.stdout,
      importResult.stderr,
      dedupeResult.stdout,
      dedupeResult.stderr,
      validateResult.stdout,
      validateResult.stderr,
      enrichResult.stdout,
      enrichResult.stderr
    ]
      .filter(Boolean)
      .join("\n")
      .trim()
  };
}

async function runMarkdownEnrichment(
  settingsFilePath: string,
  options: { platform?: string; limit?: string; year?: string; dateFrom?: string; dateTo?: string } = {}
) {
  const enrichArgs = ["--platform", options.platform || "all", "--skip-any-existing"];

  if (options.limit) {
    enrichArgs.push("--limit", options.limit);
  }

  if (options.year) {
    enrichArgs.push("--year", options.year);
  }

  if (options.dateFrom) {
    enrichArgs.push("--date-from", options.dateFrom);
  }

  if (options.dateTo) {
    enrichArgs.push("--date-to", options.dateTo);
  }

  const enrichResult = await runNodeScript(path.resolve(process.cwd(), "tools/enrich-sns-markdown.mjs"), enrichArgs);
  const validateResult = await runNodeScript(path.resolve(process.cwd(), "tools/validate-sns-markdown.mjs"));
  const cardsPayload = await buildMarkdownCards(settingsFilePath);
  const scope = [
    options.platform && options.platform !== "all" ? options.platform : "all platforms",
    options.year ? `${options.year}년` : "",
    options.dateFrom || options.dateTo ? `${options.dateFrom || "first"} - ${options.dateTo || "latest"}` : "",
    options.limit ? `${options.limit}개 배치` : ""
  ].filter(Boolean).join(", ");

  return {
    ok: true,
    message: `Summary and TAG enrichment complete (${scope}). ${cardsPayload.cards.length} Markdown cards are available.`,
    cards: cardsPayload.cards.length,
    output: [enrichResult.stdout, enrichResult.stderr, validateResult.stdout, validateResult.stderr]
      .filter(Boolean)
      .join("\n")
      .trim()
  };
}

async function runSnsUpdatePlan(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  const enabledAccounts = accounts.filter(
    (account: { exportToObsidian?: boolean; platform?: string; label?: string }) =>
      account.exportToObsidian !== false && account.platform && account.platform !== "other"
  );
  const cardsPayload = await buildMarkdownCards(settingsFilePath);

  if (enabledAccounts.length === 0) {
    return {
      ok: false,
      message: "Update 대상 SNS가 없습니다. Setting에서 Import to Obsidian을 체크하세요.",
      targets: []
    };
  }

  const targets = enabledAccounts.map((account: { id?: string; label?: string; platform?: string; url?: string }) => {
    const accountCards = cardsPayload.cards.filter(
      (card: { accountId?: string; platform?: string }) =>
        (account.id && card.accountId === account.id) || card.platform === account.platform
    );
    const latestDate =
      accountCards
        .map((card: { dateIso?: string }) => card.dateIso ?? "")
        .filter(Boolean)
        .sort()
        .at(-1) ?? "";

    return {
      id: account.id ?? "",
      label: account.label || account.platform || "SNS",
      platform: account.platform ?? "",
      url: account.url ?? "",
      latestDate,
      nextFrom: latestDate || "first-import",
      existingCards: accountCards.length
    };
  });
  const targetSummary = targets
    .map((target: { label: string; latestDate: string; existingCards: number }) =>
      `${target.label}: ${target.latestDate || "처음부터"} (${target.existingCards} files)`
    )
    .join(" / ");

  return {
    ok: true,
    message: `Update 대상 확인 완료. ${targetSummary}. Crawling connector는 다음 단계에서 연결됩니다.`,
    targets,
    cards: cardsPayload.cards.length
  };
}

function todayInputDate() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// `sinceDate` is already lookback-adjusted by the caller (a few days before the last known post,
// not the last known post's date itself) so that a post edited after publish - e.g. an image
// added to an existing blog entry - gets rediscovered. `allowForce` gates `--force`: only set
// once there's a real prior latestDate to narrow around, so a first-ever import of an account
// (nothing to refresh yet) doesn't pointlessly delete-and-rewrite everything it just wrote.
function updateScriptForAccount(
  account: { platform?: string; url?: string; label?: string },
  sinceDate: string,
  allowForce: boolean,
  runtimeEnv: Record<string, string | undefined>
) {
  const forceArgs = allowForce && sinceDate ? ["--force"] : [];

  switch (account.platform) {
    case "naver-blog": {
      const args = account.url ? ["--url", account.url] : [];

      if (sinceDate) {
        args.push("--date-from", sinceDate, "--date-to", todayInputDate(), "--limit", "200", ...forceArgs);
      } else {
        args.push("--limit", "20");
      }

      return {
        script: path.resolve(process.cwd(), "tools/import-naver-blog.mjs"),
        args,
        label: account.label || "Naver Blog"
      };
    }
    case "facebook": {
      if (runtimeEnv.FACEBOOK_ACCESS_TOKEN) {
        const args = ["--limit", "50"];

        if (sinceDate) {
          args.push("--since", sinceDate);
        }

        return {
          script: path.resolve(process.cwd(), "tools/import-facebook.mjs"),
          args,
          label: account.label || "Facebook"
        };
      }

      const args = ["--platform", "facebook", "--limit", runtimeEnv.FACEBOOK_IMPORT_LIMIT || "3"];

      if (account.url) {
        args.push("--url", account.url);
      }

      if (sinceDate) {
        args.push("--since", sinceDate, ...forceArgs);
      }

      return {
        script: path.resolve(process.cwd(), "tools/import-browser-session.mjs"),
        args,
        label: account.label || "Facebook"
      };
    }
    case "youtube": {
      const args = ["--limit", "25"];

      if (account.url) {
        args.push("--url", account.url);
      }

      if (sinceDate) {
        args.push("--since", sinceDate, ...forceArgs);
      }

      return {
        script: path.resolve(process.cwd(), "tools/import-youtube-community.mjs"),
        args,
        label: account.label || "YouTube"
      };
    }
    case "instagram": {
      const args = ["--platform", "instagram", "--limit", runtimeEnv.INSTAGRAM_IMPORT_LIMIT || "3"];

      if (account.url) {
        args.push("--url", account.url);
      }

      if (sinceDate) {
        args.push("--since", sinceDate, ...forceArgs);
      }

      return {
        script: path.resolve(process.cwd(), "tools/import-browser-session.mjs"),
        args,
        label: account.label || "Instagram"
      };
    }
    case "threads": {
      const args = ["--platform", "threads", "--limit", runtimeEnv.THREADS_IMPORT_LIMIT || "3"];

      if (account.url) {
        args.push("--url", account.url);
      }

      if (sinceDate) {
        args.push("--since", sinceDate, ...forceArgs);
      }

      return {
        script: path.resolve(process.cwd(), "tools/import-browser-session.mjs"),
        args,
        label: account.label || "Threads"
      };
    }
    default:
      return null;
  }
}

// Re-checking a post's own publish date can never catch a post that was edited later (e.g. an
// image added to an old blog entry) without rescanning everything ever published. Instead,
// Update rewinds `sinceDate` a few days before the last known post so recent posts get rechecked
// (and refreshed via --force, see updateScriptForAccount) without re-scanning the full history.
function computeSnsUpdateSinceDate(latestDate: string, lookbackDays: number) {
  if (!latestDate) {
    return "";
  }

  const parsed = new Date(`${latestDate}T00:00:00`);

  if (!Number.isFinite(parsed.getTime())) {
    return latestDate;
  }

  parsed.setDate(parsed.getDate() - Math.max(0, lookbackDays));

  const pad = (value: number) => String(value).padStart(2, "0");

  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

async function runSnsUpdatePipeline(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  const lookbackDaysSetting = Number(settings.snsUpdateLookbackDays);
  const lookbackDays = Number.isFinite(lookbackDaysSetting) ? Math.max(0, lookbackDaysSetting) : 3;
  const updatePlatforms = new Set(["facebook", "instagram", "threads", "youtube", "naver-blog"]);
  const enabledAccounts = accounts.filter(
    (account: { exportToObsidian?: boolean; platform?: string }) =>
      account.exportToObsidian !== false && account.platform && updatePlatforms.has(account.platform)
  );
  const cardsPayload = await buildMarkdownCards(settingsFilePath);

  if (enabledAccounts.length === 0) {
    return {
      ok: false,
      message: "Update 대상 SNS가 없습니다. Setting에서 Facebook, Instagram, Threads, YouTube, Naver Blog 중 Import to Obsidian을 체크하세요.",
      targets: []
    };
  }

  const runtimeEnv = await loadRuntimeEnv();
  const targets = enabledAccounts.map((account: { id?: string; label?: string; platform?: string; url?: string }) => {
    const accountCards = cardsPayload.cards.filter(
      (card: { accountId?: string; platform?: string }) =>
        (account.id && card.accountId === account.id) || card.platform === account.platform
    );
    const latestDate =
      accountCards
        .map((card: { dateIso?: string }) => card.dateIso ?? "")
        .filter(Boolean)
        .sort()
        .at(-1) ?? "";
    const sinceDate = computeSnsUpdateSinceDate(latestDate, lookbackDays);

    return {
      id: account.id ?? "",
      label: account.label || account.platform || "SNS",
      platform: account.platform ?? "",
      url: account.url ?? "",
      latestDate,
      sinceDate,
      nextFrom: sinceDate || "first-import",
      existingCards: accountCards.length
    };
  });
  const outputs: string[] = [];
  const completed: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const providerResults: Array<{
    platform: string;
    label: string;
    status: "updated" | "skipped" | "failed";
    message: string;
    latestDate: string;
    existingCards: number;
  }> = [];

  for (const target of targets) {
    const updateConfig = updateScriptForAccount(target, target.sinceDate, Boolean(target.latestDate), runtimeEnv);

    if (!updateConfig) {
      warnings.push(`${target.label}: Update connector가 아직 없습니다.`);
      providerResults.push({
        platform: target.platform,
        label: target.label,
        status: "skipped",
        message: "Update connector가 아직 없습니다.",
        latestDate: target.latestDate,
        existingCards: target.existingCards
      });
      continue;
    }

    if ("warning" in updateConfig) {
      warnings.push(String(updateConfig.warning ?? ""));
      providerResults.push({
        platform: target.platform,
        label: target.label,
        status: "skipped",
        message: String(updateConfig.warning ?? ""),
        latestDate: target.latestDate,
        existingCards: target.existingCards
      });
      continue;
    }

    try {
      const result = await runNodeScript(updateConfig.script, updateConfig.args);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

      completed.push(`${updateConfig.label}: ${target.latestDate || "first import"} 이후 확인`);
      providerResults.push({
        platform: target.platform,
        label: updateConfig.label,
        status: "updated",
        message: `${target.latestDate || "first import"} 이후 확인 완료`,
        latestDate: target.latestDate,
        existingCards: target.existingCards
      });
      if (output) {
        outputs.push(output);
      }
    } catch (error) {
      failures.push(`${updateConfig.label}: ${error instanceof Error ? error.message : "update failed"}`);
      providerResults.push({
        platform: target.platform,
        label: updateConfig.label,
        status: "failed",
        message: error instanceof Error ? error.message : "update failed",
        latestDate: target.latestDate,
        existingCards: target.existingCards
      });
    }
  }

  let dedupeOutput = "";
  let validateOutput = "";

  if (completed.length > 0) {
    const dedupeResult = await runDedupeMarkdown("all");
    const validateResult = await runNodeScript(path.resolve(process.cwd(), "tools/validate-sns-markdown.mjs"));
    dedupeOutput = [dedupeResult.stdout, dedupeResult.stderr].filter(Boolean).join("\n").trim();
    validateOutput = [validateResult.stdout, validateResult.stderr].filter(Boolean).join("\n").trim();
    invalidateMarkdownCardsCache();
  }

  const updatedCardsPayload = await buildMarkdownCards(settingsFilePath);
  const messageParts = [
    completed.length ? `Update 완료: ${completed.join(" / ")}.` : "",
    warnings.length ? `경고: ${warnings.join(" / ")}` : "",
    failures.length ? `실패: ${failures.join(" / ")}` : "",
    `현재 Markdown 카드 ${updatedCardsPayload.cards.length}개를 사용할 수 있습니다.`
  ].filter(Boolean);

  return {
    ok: failures.length === 0 || completed.length > 0 || warnings.length > 0,
    message: messageParts.join(" "),
    targets,
    providerResults,
    cards: updatedCardsPayload.cards.length,
    output: [...outputs, dedupeOutput, validateOutput].filter(Boolean).join("\n").trim()
  };
}

export default defineConfig(() => {
  const settingsFilePath = path.resolve(
    process.cwd(),
    process.env.SNS_READER_SETTINGS_FILE ?? "data/runtime/app-settings.json"
  );

  return {
    plugins: [
      react(),
      {
        name: "sns-reader-settings-api",
        configureServer(server) {
          server.middlewares.use("/api/markdown-cards", async (request, response) => {
            try {
              if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const payload = await buildMarkdownCards(settingsFilePath);

              // The grid only ever shows bodyPreview/summary - body and commentsText can be
              // long (full post text) and get re-sent on every 5s poll across ~thousands of
              // cards. Build a fresh array/objects rather than mutating the cached payload's
              // cards (buildMarkdownCards can return the same object it stores in its cache).
              sendJson(response, 200, {
                ...payload,
                cards: payload.cards.map(({ body, commentsText, ...listCard }: Record<string, any>) => listCard)
              });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/markdown-card-detail", async (request, response) => {
            try {
              if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const settings = await readCachedSettings(settingsFilePath);
              const root = path.resolve(settings.obsidianRootFolder || process.env.SNS_READER_OBSIDIAN_FOLDER || "data/sample-md");
              const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
              const url = new URL(request.url ?? "", "http://localhost");
              const relativePath = url.searchParams.get("path") ?? "";
              const filePath = path.resolve(root, relativePath.replaceAll("/", path.sep));

              if (!filePath.toLowerCase().endsWith(".md") || !isPathInside(filePath, root)) {
                sendJson(response, 403, { error: "Markdown path is outside the configured SNS folder." });
                return;
              }

              const card = await buildMarkdownCard(root, accounts, filePath);

              if (!card) {
                sendJson(response, 404, { error: "Post not found." });
                return;
              }

              sendJson(response, 200, card);
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/markdown-card", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "DELETE") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
              const settings = rawSettings ? JSON.parse(rawSettings) : {};
              const root = path.resolve(settings.obsidianRootFolder || process.env.SNS_READER_OBSIDIAN_FOLDER || "data/sample-md");
              const url = new URL(request.url ?? "", "http://localhost");
              const relativePath = url.searchParams.get("path") ?? "";
              const filePath = path.resolve(root, relativePath.replaceAll("/", path.sep));

              if (!filePath.toLowerCase().endsWith(".md") || !isPathInside(filePath, root)) {
                sendJson(response, 403, { error: "Markdown path is outside the configured SNS folder." });
                return;
              }

              const markdown = await readFile(filePath, "utf8").catch(() => "");
              const properties = parseSimpleFrontmatter(markdown);
              const mediaFolder = readProperty(properties, "media_folder");
              const mediaPath = mediaFolder ? path.resolve(path.dirname(filePath), mediaFolder.replaceAll("/", path.sep)) : "";

              await rm(filePath, { force: true });

              if (mediaPath && isPathInside(mediaPath, root)) {
                await rm(mediaPath, { force: true, recursive: true });
              }

              invalidateMarkdownCardsCache();
              sendJson(response, 200, { ok: true });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/media", async (request, response) => {
            try {
              if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const settings = await readCachedSettings(settingsFilePath);
              const root = path.resolve(settings.obsidianRootFolder || process.env.SNS_READER_OBSIDIAN_FOLDER || "data/sample-md");
              const url = new URL(request.url ?? "", "http://localhost");
              const filePath = path.resolve(url.searchParams.get("path") ?? "");

              if (!isPathInside(filePath, root)) {
                sendJson(response, 403, { error: "Media path is outside the configured SNS folder." });
                return;
              }

              await stat(filePath);
              response.statusCode = 200;
              response.setHeader("Content-Type", `image/${path.extname(filePath).slice(1).replace("jpg", "jpeg") || "jpeg"}`);
              createReadStream(filePath).pipe(response);
            } catch (error) {
              sendJson(response, 404, { error: error instanceof Error ? error.message : "Media not found" });
            }
          });

          server.middlewares.use("/api/system-fonts", async (request, response) => {
            try {
              if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const fonts = await scanSystemFonts();
              sendJson(response, 200, { fonts });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to list system fonts." });
            }
          });

          server.middlewares.use("/api/pdf-books", async (request, response) => {
            try {
              if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              sendJson(response, 200, await buildPdfBooks(settingsFilePath));
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "PDF scan failed." });
            }
          });

          server.middlewares.use("/api/pdf-page", async (request, response) => {
            try {
              if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const url = new URL(request.url ?? "", "http://localhost");
              const filePath = url.searchParams.get("path") ?? "";
              const page = Number(url.searchParams.get("page") || 1);
              const dpi = Number(url.searchParams.get("dpi") || 90);
              const imagePath = await renderPdfPagePreview(settingsFilePath, filePath, page, dpi);

              response.statusCode = 200;
              response.setHeader("Content-Type", "image/png");
              response.setHeader("Cache-Control", "private, max-age=86400");
              createReadStream(imagePath).pipe(response);
            } catch (error) {
              sendJson(response, 404, { error: error instanceof Error ? error.message : "PDF page preview not found" });
            }
          });

          server.middlewares.use("/api/create-pdf", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const body = await readRequestBody(request);
              const parsed = body ? JSON.parse(body) : {};
              const books = await writePdfBooks(settingsFilePath, parsed.settings ?? {});
              const book = books[0];

              sendJson(response, 200, {
                ok: true,
                book,
                books,
                message: books.length > 1 ? `${books.length}권의 PDF 생성이 완료되었습니다.` : `${book.title} PDF 생성이 완료되었습니다.`
              });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "PDF creation failed." });
            }
          });
          server.middlewares.use("/api/pdf-file", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "GET" && request.method !== "DELETE") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const settings = await readCachedSettings(settingsFilePath);
              const root = path.resolve(settings.pdfOutputFolder || path.join(process.cwd(), "exports", "pdf"));
              const url = new URL(request.url ?? "", "http://localhost");
              const filePath = path.resolve(url.searchParams.get("path") ?? "");

              if (!filePath.toLowerCase().endsWith(".pdf") || !isPathInside(filePath, root)) {
                sendJson(response, 403, { error: "PDF path is outside the configured PDF folder." });
                return;
              }

              if (request.method === "DELETE") {
                await rm(filePath, { force: true });
                await rm(pdfMetadataPath(filePath), { force: true });
                await rm(filePath.replace(/\.pdf$/i, ".json"), { force: true });
                sendJson(response, 200, { ok: true });
                return;
              }

              await stat(filePath);
              response.statusCode = 200;
              response.setHeader("Content-Type", "application/pdf");
              response.setHeader("Content-Disposition", `inline; filename="${path.basename(filePath).replace(/"/g, "")}"`);
              createReadStream(filePath).pipe(response);
            } catch (error) {
              sendJson(response, 404, { error: error instanceof Error ? error.message : "PDF not found" });
            }
          });

          server.middlewares.use("/api/settings", async (request, response) => {
            try {
              if (request.method !== "GET" && !isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method === "GET") {
                const raw = await readFile(settingsFilePath, "utf8").catch(() => null);

                sendJson(response, 200, raw ? JSON.parse(raw) : null);
                return;
              }

              if (request.method === "PUT") {
                const body = await readRequestBody(request);
                const parsed = JSON.parse(body);

                for (const key of ["obsidianRootFolder", "pdfOutputFolder"]) {
                  const value = parsed[key];

                  if (typeof value === "string" && value && isFilesystemRoot(value)) {
                    sendJson(response, 400, { error: `${key} cannot be a drive/filesystem root folder.` });
                    return;
                  }
                }

                await mkdir(path.dirname(settingsFilePath), { recursive: true });
                await writeFile(settingsFilePath, JSON.stringify(parsed, null, 2), "utf8");
                invalidateMarkdownCardsCache();
                invalidateSettingsCache();
                sendJson(response, 200, { ok: true });
                return;
              }

              if (request.method === "DELETE") {
                await rm(settingsFilePath, { force: true });
                invalidateMarkdownCardsCache();
                invalidateSettingsCache();
                sendJson(response, 200, { ok: true });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed" });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/env", async (request, response) => {
            const envPath = path.resolve(process.cwd(), ".env");
            const visibleValueKeys = new Set([
              "VITE_LLM_OPENAI_FRONTIER_MODEL",
              "VITE_LLM_GEMINI_FLASH_MODEL",
              "VITE_LLM_OLLAMA_MODEL",
              "VITE_LLM_OLLAMA_GEMMA_MODEL",
              "VITE_LLM_CUSTOM_PROVIDER_LABEL",
              "VITE_LLM_CUSTOM_MODEL",
              "SNS_READER_LLM_MODEL",
              "SNS_READER_LLM_BASE_URL",
              "OLLAMA_BASE_URL",
              "OPENAI_BASE_URL"
            ]);
            const allowedWriteKeys = new Set([
              ...visibleValueKeys,
              "OPENAI_API_KEY",
              "GEMINI_API_KEY",
              "ANTHROPIC_API_KEY",
              "DEEPSEEK_API_KEY",
              "MISTRAL_API_KEY",
              "QWEN_API_KEY",
              "SNS_READER_LLM_PROVIDER",
              "SNS_READER_LLM_API_KEY"
            ]);

            try {
              if (request.method !== "GET" && !isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method === "GET") {
                const raw = await readFile(envPath, "utf8").catch(() => "");
                const env = parseEnv(raw);

                sendJson(response, 200, {
                  keys: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, Boolean(value)])),
                  values: Object.fromEntries(
                    Object.entries(env).filter(([key]) => visibleValueKeys.has(key))
                  )
                });
                return;
              }

              if (request.method === "PUT") {
                const body = await readRequestBody(request);
                const parsed = JSON.parse(body) as { updates?: Record<string, string> };
                const updates = Object.fromEntries(
                  Object.entries(parsed.updates ?? {})
                    .filter(([key]) => allowedWriteKeys.has(key))
                    .map(([key, value]) => [key, String(value ?? "").trim()])
                );

                if (Object.keys(updates).length === 0) {
                  sendJson(response, 400, { error: "No allowed env fields were provided." });
                  return;
                }

                const raw = await readFile(envPath, "utf8").catch(() => "");

                await writeFile(envPath, upsertEnv(raw, updates), "utf8");
                Object.assign(process.env, updates);
                sendJson(response, 200, { ok: true });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed" });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/server/restart", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              sendJson(response, 200, { ok: true, message: "Restarting local server." });
              setTimeout(() => {
                void server.restart();
              }, 150);
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/import-archive", async (request, response) => {
            let tempRoot = "";
            let pipelineStarted = false;

            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              const url = new URL(request.url ?? "", "http://localhost");
              const platform = url.searchParams.get("platform") ?? "";
              const fileName = sanitizeUploadName(url.searchParams.get("fileName") ?? "");
              const enrich = url.searchParams.get("enrich") !== "false";
              const importConfig = scriptArgsForArchiveImport(platform, "");

              if (!importConfig) {
                sendJson(response, 400, { error: "This SNS provider is not connected to archive import yet." });
                return;
              }

              if (!tryBeginVaultPipeline("Import Archive")) {
                sendJson(response, 409, { error: `${activeVaultPipelineLabel} 작업이 진행 중입니다. 완료 후 다시 시도해주세요.` });
                return;
              }
              pipelineStarted = true;

              tempRoot = await mkdtemp(path.join(os.tmpdir(), "sns-reader-archive-upload-"));
              const zipPath = path.join(tempRoot, fileName);

              await saveRequestBody(request, zipPath);

              const detectedPlatform = detectPlatformFromZipEntries(await listZipEntries(zipPath));

              if (detectedPlatform && detectedPlatform !== platform) {
                sendJson(response, 400, {
                  error: `Selected provider is ${platform}, but the zip contents look like ${detectedPlatform}. Please choose the matching SNS Provider.`
                });
                return;
              }

              const importArgs = scriptArgsForArchiveImport(platform, zipPath);

              if (!importArgs) {
                sendJson(response, 400, { error: "This SNS provider is not connected to archive import yet." });
                return;
              }

              const importResult = await runNodeScript(importArgs.script, importArgs.args);
              const dedupeResult = await runDedupeMarkdown(platform);
              const validateResult = await runNodeScript(path.resolve(process.cwd(), "tools/validate-sns-markdown.mjs"));
              const enrichResult = enrich
                ? await runNodeScript(path.resolve(process.cwd(), "tools/enrich-sns-markdown.mjs"), [
                    "--platform",
                    "all",
                    "--skip-any-existing"
                  ])
                : { stdout: "", stderr: "" };
              invalidateMarkdownCardsCache();
              const cardsPayload = await buildMarkdownCards(settingsFilePath);
              const output = [
                importResult.stdout,
                importResult.stderr,
                dedupeResult.stdout,
                dedupeResult.stderr,
                validateResult.stdout,
                validateResult.stderr,
                enrichResult.stdout,
                enrichResult.stderr
              ]
                .filter(Boolean)
                .join("\n")
                .trim();

              sendJson(response, 200, {
                ok: true,
                cards: cardsPayload.cards.length,
                message: `${importArgs.label} archive import complete. ${cardsPayload.cards.length} Markdown cards are available.`,
                output
              });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Archive import failed." });
            } finally {
              if (pipelineStarted) {
                endVaultPipeline();
              }
              if (tempRoot) {
              await rm(tempRoot, { recursive: true, force: true });
              }
            }
          });

          server.middlewares.use("/api/enrich-markdown", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              if (!tryBeginVaultPipeline("Enrich Markdown")) {
                sendJson(response, 409, { error: `${activeVaultPipelineLabel} 작업이 진행 중입니다. 완료 후 다시 시도해주세요.` });
                return;
              }

              try {
                const url = new URL(request.url ?? "", "http://localhost");
                const result = await runMarkdownEnrichment(settingsFilePath, {
                  dateFrom: url.searchParams.get("dateFrom") || "",
                  dateTo: url.searchParams.get("dateTo") || "",
                  limit: url.searchParams.get("limit") || "",
                  platform: url.searchParams.get("platform") || "all",
                  year: url.searchParams.get("year") || ""
                });
                invalidateMarkdownCardsCache();
                sendJson(response, 200, result);
              } finally {
                endVaultPipeline();
              }
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Markdown enrichment failed." });
            }
          });

          server.middlewares.use("/api/login-browser", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              runDetachedNodeScript(path.resolve(process.cwd(), "tools/open-login-browser.mjs"));
              sendJson(response, 200, {
                ok: true,
                message: "로그인 브라우저를 열었습니다. 필요한 SNS에 로그인한 뒤 브라우저 창을 닫아주세요."
              });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "로그인 브라우저를 열지 못했습니다." });
            }
          });

          server.middlewares.use("/api/sns-update", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              if (!tryBeginVaultPipeline("SNS Update")) {
                sendJson(response, 409, { error: `${activeVaultPipelineLabel} 작업이 진행 중입니다. 완료 후 다시 시도해주세요.` });
                return;
              }

              try {
                const result = await runSnsUpdatePipeline(settingsFilePath);
                invalidateMarkdownCardsCache();
                sendJson(response, 200, result);
              } finally {
                endVaultPipeline();
              }
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "SNS Update failed." });
            }
          });

          server.middlewares.use("/api/sns-read", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              if (!tryBeginVaultPipeline("SNS Read")) {
                sendJson(response, 409, { error: `${activeVaultPipelineLabel} 작업이 진행 중입니다. 완료 후 다시 시도해주세요.` });
                return;
              }

              try {
                const result = await runSnsReadPipeline(settingsFilePath);
                invalidateMarkdownCardsCache();
                sendJson(response, 200, result);
              } finally {
                endVaultPipeline();
              }
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "SNS Read failed." });
            }
          });
        }
      }
    ],
    server: {
      host: "127.0.0.1",
      port: 5173
    }
  };
});
