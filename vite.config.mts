import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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

async function saveRequestBody(request: import("node:http").IncomingMessage, filePath: string) {
  await pipeline(request, createWriteStream(filePath));
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

async function buildMarkdownCards(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const root = path.resolve(settings.obsidianRootFolder || process.env.SNS_READER_OBSIDIAN_FOLDER || "data/sample-md");
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  const files = await walkMarkdownFiles(root);
  const cards = [];

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");

    if (!markdown.includes("type: sns-post") && !markdown.includes("platform:")) {
      continue;
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

    cards.push({
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
      commentAuthors: [],
      tags,
      imageUrls,
      sourceUrl: readProperty(properties, "source_url") || readProperty(properties, "source"),
      thumbnailUrl: firstImageUrl
    });
  }

  return {
    cards: cards.sort((left, right) => String(right.dateIso).localeCompare(String(left.dateIso))),
    root,
  };
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

async function runMarkdownEnrichment(settingsFilePath: string) {
  const enrichResult = await runNodeScript(path.resolve(process.cwd(), "tools/enrich-sns-markdown.mjs"), [
    "--platform",
    "all",
    "--skip-any-existing"
  ]);
  const validateResult = await runNodeScript(path.resolve(process.cwd(), "tools/validate-sns-markdown.mjs"));
  const cardsPayload = await buildMarkdownCards(settingsFilePath);

  return {
    ok: true,
    message: `Summary and TAG enrichment complete. ${cardsPayload.cards.length} Markdown cards are available.`,
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

function updateScriptForAccount(
  account: { platform?: string; url?: string; label?: string },
  latestDate: string,
  runtimeEnv: Record<string, string | undefined>
) {
  const sinceDate = latestDate || "";

  switch (account.platform) {
    case "naver-blog": {
      const args = account.url ? ["--url", account.url] : [];

      if (sinceDate) {
        args.push("--date-from", sinceDate, "--date-to", todayInputDate(), "--limit", "200");
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
        args.push("--since", sinceDate);
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
        args.push("--since", sinceDate);
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
        args.push("--since", sinceDate);
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
        args.push("--since", sinceDate);
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

async function runSnsUpdatePipeline(settingsFilePath: string) {
  const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
  const settings = rawSettings ? JSON.parse(rawSettings) : {};
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
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
  const outputs: string[] = [];
  const completed: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  for (const target of targets) {
    const updateConfig = updateScriptForAccount(target, target.latestDate, runtimeEnv);

    if (!updateConfig) {
      warnings.push(`${target.label}: Update connector가 아직 없습니다.`);
      continue;
    }

    if ("warning" in updateConfig) {
      warnings.push(String(updateConfig.warning ?? ""));
      continue;
    }

    try {
      const result = await runNodeScript(updateConfig.script, updateConfig.args);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

      completed.push(`${updateConfig.label}: ${target.latestDate || "first import"} 이후 확인`);
      if (output) {
        outputs.push(output);
      }
    } catch (error) {
      failures.push(`${updateConfig.label}: ${error instanceof Error ? error.message : "update failed"}`);
    }
  }

  let dedupeOutput = "";
  let validateOutput = "";

  if (completed.length > 0) {
    const dedupeResult = await runDedupeMarkdown("all");
    const validateResult = await runNodeScript(path.resolve(process.cwd(), "tools/validate-sns-markdown.mjs"));
    dedupeOutput = [dedupeResult.stdout, dedupeResult.stderr].filter(Boolean).join("\n").trim();
    validateOutput = [validateResult.stdout, validateResult.stderr].filter(Boolean).join("\n").trim();
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

              sendJson(response, 200, await buildMarkdownCards(settingsFilePath));
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
            }
          });

          server.middlewares.use("/api/markdown-card", async (request, response) => {
            try {
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

              const rawSettings = await readFile(settingsFilePath, "utf8").catch(() => "");
              const settings = rawSettings ? JSON.parse(rawSettings) : {};
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

          server.middlewares.use("/api/settings", async (request, response) => {
            try {
              if (request.method === "GET") {
                const raw = await readFile(settingsFilePath, "utf8").catch(() => null);

                sendJson(response, 200, raw ? JSON.parse(raw) : null);
                return;
              }

              if (request.method === "PUT") {
                const body = await readRequestBody(request);
                const parsed = JSON.parse(body);

                await mkdir(path.dirname(settingsFilePath), { recursive: true });
                await writeFile(settingsFilePath, JSON.stringify(parsed, null, 2), "utf8");
                sendJson(response, 200, { ok: true });
                return;
              }

              if (request.method === "DELETE") {
                await rm(settingsFilePath, { force: true });
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

            try {
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
              if (tempRoot) {
              await rm(tempRoot, { recursive: true, force: true });
              }
            }
          });

          server.middlewares.use("/api/enrich-markdown", async (request, response) => {
            try {
              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              sendJson(response, 200, await runMarkdownEnrichment(settingsFilePath));
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "Markdown enrichment failed." });
            }
          });

          server.middlewares.use("/api/login-browser", async (request, response) => {
            try {
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
              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              sendJson(response, 200, await runSnsUpdatePipeline(settingsFilePath));
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : "SNS Update failed." });
            }
          });

          server.middlewares.use("/api/sns-read", async (request, response) => {
            try {
              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
              }

              sendJson(response, 200, await runSnsReadPipeline(settingsFilePath));
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
