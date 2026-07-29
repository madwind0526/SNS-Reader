import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { launchPersistentBrowser } from "./playwright-session.mjs";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_MARKDOWN_ROOT = "./data/sample-md";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }

  return args;
}

function parseEnv(content) {
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

async function loadEnv() {
  const fileEnv = await readFile(path.join(workspaceRoot, ".env"), "utf8")
    .then(parseEnv)
    .catch(() => ({}));

  return {
    ...fileEnv,
    ...process.env,
  };
}

async function loadAppSettings(env) {
  const settingsPath = path.resolve(workspaceRoot, env.SNS_READER_SETTINGS_FILE || DEFAULT_SETTINGS_FILE);

  return readFile(settingsPath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function normalizeChannelUrl(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  const url = text.endsWith("/") ? text.slice(0, -1) : text;

  if (url.endsWith("/community")) {
    return url;
  }

  return `${url}/community`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}`);
  }

  return response.text();
}

function normalizeCdpBaseUrl(value) {
  const text = String(value || "").trim();

  return text ? text.replace(/\/+$/, "") : "";
}

async function readJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}`);
  }

  return response.json();
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.webSocket.addEventListener("open", resolve, { once: true });
      this.webSocket.addEventListener("error", reject, { once: true });
    });

    this.webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));

      if (!message.id || !this.pending.has(message.id)) {
        return;
      }

      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP command failed"));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  async send(method, params = {}, sessionId = "") {
    await this.opened;

    const id = this.nextId;
    this.nextId += 1;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.webSocket.send(JSON.stringify(payload));
    });
  }

  close() {
    this.webSocket.close();
  }
}

async function evaluate(client, sessionId, expression, awaitPromise = false) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise,
      returnByValue: true,
    },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }

  return result.result?.value;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPageReady(client, sessionId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const readyState = await evaluate(client, sessionId, "document.readyState").catch(() => "");

    if (readyState === "complete" || readyState === "interactive") {
      await sleep(1800);
      return;
    }

    await sleep(300);
  }
}

async function fetchTextFromBrowser(cdpBaseUrl, url) {
  const version = await readJson(`${cdpBaseUrl}/json/version`);

  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP endpoint does not expose webSocketDebuggerUrl.");
  }

  const client = new CdpClient(version.webSocketDebuggerUrl);

  try {
    const created = await client.send("Target.createTarget", { url: "about:blank" });
    const attached = await client.send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;

    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.navigate", { url }, sessionId);
    await waitForPageReady(client, sessionId);
    await evaluate(
      client,
      sessionId,
      "new Promise((resolve) => { window.scrollBy(0, 1200); setTimeout(resolve, 1800); })",
      true
    );

    return evaluate(client, sessionId, "document.documentElement ? document.documentElement.outerHTML : ''");
  } finally {
    client.close();
  }
}

async function fetchTextFromPlaywright({ env, args, url }) {
  const { context } = await launchPersistentBrowser({ env, args, headless: Boolean(args.headless) });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1800);

    return await page.evaluate(() => (document.documentElement ? document.documentElement.outerHTML : ""));
  } finally {
    await context.close();
  }
}

function extractInitialData(html) {
  const marker = "var ytInitialData = ";
  const start = html.indexOf(marker);

  if (start < 0) {
    return null;
  }

  const jsonStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = jsonStart; index < html.length; index += 1) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(html.slice(jsonStart, index + 1));
      }
    }
  }

  return null;
}

function collectRuns(value) {
  if (!value) {
    return "";
  }

  if (typeof value.simpleText === "string") {
    return value.simpleText;
  }

  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => run.text || "").join("");
  }

  return "";
}

function walk(value, visitor) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor));
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  visitor(value);
  Object.values(value).forEach((item) => walk(item, visitor));
}

function isUnavailableCommunityPage(initialData) {
  const text = JSON.stringify(initialData || "");

  return (
    text.includes("커뮤니티를 사용할 수 없습니다") ||
    text.includes("Community is unavailable") ||
    text.includes("This channel does not have any content")
  );
}

function parseRelativeDate(value) {
  const text = String(value || "");
  const now = new Date();
  const match = text.match(/(\d+)\s*(분|시간|일|주|개월|년|minute|hour|day|week|month|year)/i);

  if (!match) {
    return now;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const date = new Date(now);

  if (unit.startsWith("분") || unit.startsWith("minute")) {
    date.setMinutes(date.getMinutes() - amount);
  } else if (unit.startsWith("시간") || unit.startsWith("hour")) {
    date.setHours(date.getHours() - amount);
  } else if (unit.startsWith("일") || unit.startsWith("day")) {
    date.setDate(date.getDate() - amount);
  } else if (unit.startsWith("주") || unit.startsWith("week")) {
    date.setDate(date.getDate() - amount * 7);
  } else if (unit.startsWith("개월") || unit.startsWith("month")) {
    date.setMonth(date.getMonth() - amount);
  } else if (unit.startsWith("년") || unit.startsWith("year")) {
    date.setFullYear(date.getFullYear() - amount);
  }

  return date;
}

function formatDateParts(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());

  return {
    date: `${year}-${month}-${day}`,
    dateTime: `${year}-${month}-${day}T${hour}:${minute}:00`,
    fileDate: `${year}-${month}-${day}_${hour}${minute}`,
    month: `${year}-${month}`,
  };
}

function slugify(value) {
  return String(value || Date.now())
    .replace(/[^\w\uac00-\ud7af-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function escapeYaml(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function walkMarkdownFiles(root, files = []) {
  if (!existsSync(root)) {
    return files;
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      await walkMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readExistingPostEntries(root) {
  const files = await walkMarkdownFiles(root);
  const entries = new Map();

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");
    const platform = markdown.match(/^platform:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const postId = markdown.match(/^post_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

    if (platform === "youtube" && postId) {
      entries.set(postId, filePath);
    }
  }

  return entries;
}

function extractCommunityPosts(initialData) {
  const posts = [];
  const seen = new Set();

  walk(initialData, (node) => {
    const renderer = node.backstagePostRenderer || node.postRenderer;

    if (!renderer) {
      return;
    }

    const id = renderer.postId || renderer.post?.postId || renderer.publishedTimeText?.accessibility?.accessibilityData?.label;
    const body = collectRuns(renderer.contentText || renderer.content || renderer.title).trim();
    const publishedText = collectRuns(renderer.publishedTimeText || renderer.publishedTime).trim();

    if (!id || seen.has(id) || !body) {
      return;
    }

    seen.add(id);
    posts.push({
      id,
      body,
      date: parseRelativeDate(publishedText),
      imageUrls: [],
      links: [],
      publishedText,
      title: body.split(/\n+/).find(Boolean)?.slice(0, 80) || `YouTube post ${id}`,
    });
  });

  return posts;
}

function buildMarkdown({ post, account }) {
  const parts = formatDateParts(post.date);
  const sourceUrl = `https://www.youtube.com/post/${post.id}`;

  return [
    "---",
    "type: sns-post",
    "platform: youtube",
    `account: "${escapeYaml(account?.label || "YouTube")}"`,
    `account_url: "${escapeYaml(account?.url || "")}"`,
    `source_url: "${escapeYaml(sourceUrl)}"`,
    `post_id: "${escapeYaml(post.id)}"`,
    `created: "${parts.dateTime}"`,
    `date: "${parts.date}"`,
    `year: ${parts.date.slice(0, 4)}`,
    `month: "${parts.month}"`,
    `title: "${escapeYaml(post.title)}"`,
    "post_type: \"community\"",
    "has_images: false",
    "image_count: 0",
    "has_comments: false",
    "comment_count: 0",
    "has_summary: false",
    "tags:",
    "  - YouTube",
    "  - SNS",
    "media_folder: \"\"",
    `imported_at: "${new Date().toISOString()}"`,
    "import_source: \"youtube-community-crawl\"",
    "---",
    "",
    `# ${post.title}`,
    "",
    "## Date",
    "",
    parts.dateTime,
    "",
    "## Body",
    "",
    post.body,
    "",
    "## Images",
    "",
    "No images captured.",
    "",
    "## Videos",
    "",
    "No videos captured.",
    "",
    "## Comments",
    "",
    "No comments mapped from this crawl yet.",
    "",
    "## Summary",
    "",
    "Summary will be generated after the LLM summarizer is connected.",
    "",
    "## Source",
    "",
    `[YouTube post](${sourceUrl})`,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const account = (settings?.accounts ?? []).find((item) => item.platform === "youtube");
  const communityUrl = normalizeChannelUrl(args.url || account?.url);
  const latestDate = args.since ? new Date(`${args.since}T00:00:00`) : null;
  const limit = args.limit ? Number(args.limit) : 25;
  const force = Boolean(args.force);
  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);

  if (!communityUrl) {
    console.log("No YouTube channel URL is configured.");
    return;
  }

  let html = await fetchText(communityUrl);
  let initialData = extractInitialData(html);
  let captureSource = "public-html";
  const cdpBaseUrl = normalizeCdpBaseUrl(args.cdp || env.SNS_READER_CDP_URL);

  if ((!initialData || isUnavailableCommunityPage(initialData)) && cdpBaseUrl) {
    try {
      html = await fetchTextFromBrowser(cdpBaseUrl, communityUrl);
      initialData = extractInitialData(html);
      captureSource = "chrome-cdp";
    } catch (error) {
      console.log(
        `YouTube CDP fallback failed: ${error instanceof Error ? error.message : "CDP connection failed"}`
      );
    }
  }

  if (!initialData || isUnavailableCommunityPage(initialData)) {
    try {
      html = await fetchTextFromPlaywright({ env, args, url: communityUrl });
      initialData = extractInitialData(html);
      captureSource = "playwright";
    } catch (error) {
      console.log(
        `YouTube Playwright fallback failed: ${
          error instanceof Error ? error.message : "Playwright browser session failed"
        }`
      );
    }
  }

  if (!initialData) {
    console.log("YouTube Community initial data was not found.");
    return;
  }

  if (isUnavailableCommunityPage(initialData)) {
    console.log("YouTube Community page is not available without a logged-in browser session.");
    return;
  }

  const posts = extractCommunityPosts(initialData)
    .filter((post) => !latestDate || post.date >= latestDate)
    .slice(0, limit);
  const written = [];
  const existingPostEntries = await readExistingPostEntries(path.join(outputRoot, "YouTube"));
  let skippedDuplicates = 0;
  let refreshed = 0;

  for (const post of posts.sort((left, right) => left.date.getTime() - right.date.getTime())) {
    const existingPath = existingPostEntries.get(post.id);

    if (existingPath) {
      if (!force) {
        skippedDuplicates += 1;
        continue;
      }

      await rm(existingPath, { force: true });
      refreshed += 1;
    }

    const parts = formatDateParts(post.date);
    const stem = `${parts.fileDate}_youtube-community_${post.id}_${slugify(post.title) || post.id}`;
    const monthDir = path.join(outputRoot, "YouTube", parts.month);
    const mdPath = path.join(monthDir, `${stem}.md`);

    await mkdir(monthDir, { recursive: true });
    await writeFile(mdPath, buildMarkdown({ post, account }), "utf8");
    existingPostEntries.set(post.id, mdPath);
    written.push(mdPath);
  }

  console.log(`YouTube Community URL: ${communityUrl}`);
  console.log(`Capture source: ${captureSource}`);
  console.log(`Discovered posts: ${posts.length}`);
  console.log(`Written Markdown files: ${written.length}`);
  console.log(`Refreshed existing posts: ${refreshed}`);
  console.log(`Skipped duplicate posts: ${skippedDuplicates}`);
  written.forEach((filePath) => console.log(filePath));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
