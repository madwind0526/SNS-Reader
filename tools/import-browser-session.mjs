import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { launchPersistentBrowser } from "./playwright-session.mjs";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_MARKDOWN_ROOT = "./data/sample-md";

const platformConfigs = {
  facebook: {
    label: "Facebook",
    outputFolder: "facebook",
    urlPattern: /facebook\.com/i,
  },
  instagram: {
    label: "Instagram",
    outputFolder: "instagram",
    urlPattern: /instagram\.com/i,
  },
  threads: {
    label: "Threads",
    outputFolder: "Threads",
    urlPattern: /threads\.(?:com|net)/i,
  },
};

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

function normalizeCdpBaseUrl(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  return text.replace(/\/+$/, "");
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
    this.events = [];

    this.opened = new Promise((resolve, reject) => {
      this.webSocket.addEventListener("open", resolve, { once: true });
      this.webSocket.addEventListener("error", reject, { once: true });
    });

    this.webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));

      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message || "CDP command failed"));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }

      this.events.push(message);
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

async function connectToBrowser(cdpBaseUrl) {
  const version = await readJson(`${cdpBaseUrl}/json/version`);

  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP endpoint does not expose webSocketDebuggerUrl.");
  }

  return new CdpClient(version.webSocketDebuggerUrl);
}

async function openBrowserPage(client, url) {
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

  return {
    targetId: created.targetId,
    sessionId,
  };
}

async function waitForPageReady(client, sessionId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const readyState = await evaluate(client, sessionId, "document.readyState").catch(() => "");

    if (readyState === "complete" || readyState === "interactive") {
      await sleep(1200);
      return;
    }

    await sleep(300);
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

function extractHandleFromUrl(value) {
  const text = String(value ?? "").trim();
  const match =
    text.match(/@([A-Za-z0-9._-]+)/) ||
    text.match(/(?:facebook\.com|instagram\.com|threads\.(?:net|com))\/([^/?#]+)/i);

  return match?.[1]?.replace(/^@/, "").toLowerCase() ?? "";
}

function normalizeLines(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanPostLines(lines, handle) {
  const lowerHandle = handle.toLowerCase();

  return lines.filter((line) => {
    const lower = line.toLowerCase();

    if (lower === lowerHandle) return false;
    if (parseKoreanTimestamp(line) !== null) return false;
    if (/^\d+\s*\/\s*\d+$/.test(line)) return false;
    if (/^(좋아요|답글|리포스트|공유|보기|번역 보기|댓글 달기|팔로우)$/i.test(line)) return false;

    return true;
  });
}

function extractThreadsBlocks(text, account, limit) {
  const handle = extractHandleFromUrl(account?.url) || String(account?.label || "").toLowerCase();
  const lines = normalizeLines(text);
  const blocks = [];

  for (let index = 0; index < lines.length - 2; index += 1) {
    if (handle && lines[index].toLowerCase() !== handle) {
      continue;
    }

    // Threads shows relative time ("1시간", "3일") for anything posted recently and only
    // switches to an absolute date later, so both forms have to be accepted here.
    const timestamp = parseKoreanTimestamp(lines[index + 1]);

    if (!timestamp) {
      continue;
    }

    let end = index + 2;

    while (end < lines.length) {
      const nextStartsBlock =
        handle &&
        lines[end].toLowerCase() === handle &&
        parseKoreanTimestamp(lines[end + 1] || "") !== null;

      if (nextStartsBlock) {
        break;
      }

      end += 1;
    }

    const postLines = cleanPostLines(lines.slice(index, end), handle);
    const body = postLines.join("\n").trim();

    if (body) {
      blocks.push({
        date: formatDateParts(timestamp).date,
        body,
      });
    }

    index = end - 1;
  }

  return mergeThreadsContinuations(blocks).slice(0, limit);
}

const RELATIVE_KOREAN_TIME_UNIT_MS = {
  초: 1000,
  분: 60 * 1000,
  시간: 60 * 60 * 1000,
  일: 24 * 60 * 60 * 1000,
  주: 7 * 24 * 60 * 60 * 1000,
  개월: 30 * 24 * 60 * 60 * 1000,
  년: 365 * 24 * 60 * 60 * 1000,
};

// Facebook/Threads only show an absolute "N월 N일" date once a post is old enough - anything
// posted within roughly the last day or two is rendered as relative time ("3시간", "1일" etc.),
// which the absolute-only matcher below never recognized, so today's posts were silently
// dropped entirely (not just mis-dated).
function parseRelativeKoreanTimestamp(text, now) {
  const trimmed = String(text || "").trim();

  if (/^(방금|방금\s*전|지금)$/.test(trimmed)) {
    return new Date(now);
  }

  const relative = trimmed.match(/^(\d+)\s*(초|분|시간|일|주|개월|년)\s*(전)?$/);

  if (!relative) {
    return null;
  }

  const unitMs = RELATIVE_KOREAN_TIME_UNIT_MS[relative[2]];

  return new Date(now.getTime() - Number(relative[1]) * unitMs);
}

function parseAbsoluteKoreanTimestamp(text, now) {
  const trimmed = String(text || "").trim();
  const monthDay = trimmed.match(/(\d{1,2})월\s*(\d{1,2})일(?:\s*(오전|오후)\s*(\d{1,2}):(\d{2}))?/);

  if (!monthDay) {
    return null;
  }

  const [, month, day, period, hourText, minuteText] = monthDay;
  let hour = Number(hourText || 0);

  if (period === "오후" && hour < 12) {
    hour += 12;
  } else if (period === "오전" && hour === 12) {
    hour = 0;
  }

  return new Date(now.getFullYear(), Number(month) - 1, Number(day), hour, Number(minuteText || 0), 0);
}

// Returns null (not a Date) when the line isn't a recognizable timestamp at all, so callers can
// tell "this line is a timestamp" apart from "this line is ordinary post text".
function parseKoreanTimestamp(text, now = new Date()) {
  return parseRelativeKoreanTimestamp(text, now) ?? parseAbsoluteKoreanTimestamp(text, now);
}

function cleanFacebookLines(lines) {
  const stopPatterns = [
    /^인사이트 및 광고 보기$/,
    /^모든 공감:$/,
    /^좋아요$/,
    /^댓글 달기$/,
    /^공유하기$/,
    /^댓글을 입력하세요/,
  ];
  const bodyLines = [];

  for (const line of lines) {
    if (stopPatterns.some((pattern) => pattern.test(line))) {
      break;
    }

    if (/^공유 대상:/.test(line)) {
      continue;
    }

    if (line === "·" || line === "더 보기" || line === "적게 보기") {
      continue;
    }

    bodyLines.push(line.replace(/\s*적게 보기$/, "").trim());
  }

  return bodyLines.filter(Boolean);
}

function extractFacebookArticles(articleTexts, limit) {
  const posts = [];

  for (const articleText of articleTexts) {
    const lines = normalizeLines(articleText);
    const authorIndex = lines.findIndex((line) => line === "미친바람");
    const dateIndex = lines.findIndex((line) => parseKoreanTimestamp(line) !== null);

    if (authorIndex < 0 || dateIndex < 0 || dateIndex <= authorIndex) {
      continue;
    }

    const body = cleanFacebookLines(lines.slice(dateIndex + 1)).join("\n").trim();

    if (!body) {
      continue;
    }

    const date = parseKoreanTimestamp(lines[dateIndex]) ?? new Date();

    posts.push({
      date: formatDateParts(date).date,
      body,
    });

    if (posts.length >= limit) {
      break;
    }
  }

  return posts;
}

function mergeThreadsContinuations(blocks) {
  const merged = [];

  for (const block of blocks) {
    const firstLine = block.body.split(/\n/).find(Boolean) || "";
    const continuationMatch = firstLine.match(/^(\d+)\.\s+/);
    const previous = merged.at(-1);

    if (previous && previous.date === block.date && continuationMatch) {
      previous.body = `${previous.body}\n\n${block.body}`.trim();
      continue;
    }

    merged.push({ ...block });
  }

  return merged;
}

function extractGenericBlocks(text, account, limit) {
  const handle = extractHandleFromUrl(account?.url);
  const lines = normalizeLines(text);
  const startIndex = handle ? lines.findIndex((line) => line.toLowerCase() === handle) : -1;
  const bodyLines = lines
    .slice(Math.max(0, startIndex + 1))
    .filter((line) => !/^(홈|검색|탐색|알림|메시지|프로필|더 보기|로그인|가입하기)$/i.test(line))
    .slice(0, 80);
  const body = bodyLines.join("\n").trim();

  return body
    ? [
        {
          date: new Date().toISOString().slice(0, 10),
          body,
        },
      ].slice(0, limit)
    : [];
}

function extractPosts({ platform, text, articleTexts = [], account, limit }) {
  if (platform === "facebook") {
    return extractFacebookArticles(articleTexts, limit);
  }

  if (platform === "threads") {
    return extractThreadsBlocks(text, account, limit);
  }

  return extractGenericBlocks(text, account, limit);
}

async function captureBrowserPage(client, sessionId, platform, limit) {
  if (platform === "facebook") {
    return evaluate(
      client,
      sessionId,
      `new Promise((resolve) => {
        function visibleArticles() {
          return Array.from(document.querySelectorAll('[role="article"], article'))
            .filter((node) => (node.innerText || '').includes('미친바람'));
        }

        function clickMore(articles) {
          for (const article of articles) {
            const controls = Array.from(article.querySelectorAll('[role="button"], span, div'));
            const more = controls.find((node) => (node.innerText || node.textContent || '').trim() === '더 보기');

            if (more && typeof more.click === 'function') {
              more.click();
            }
          }
        }

        async function run() {
          window.scrollTo(0, 0);
          await new Promise((innerResolve) => setTimeout(innerResolve, 1200));
          let articles = visibleArticles();
          clickMore(articles);
          await new Promise((innerResolve) => setTimeout(innerResolve, 900));

          for (let attempt = 0; attempt < 4 && visibleArticles().length < ${Number(limit) + 1}; attempt += 1) {
            window.scrollBy(0, 900);
            await new Promise((innerResolve) => setTimeout(innerResolve, 1400));
            articles = visibleArticles();
            clickMore(articles);
            await new Promise((innerResolve) => setTimeout(innerResolve, 700));
          }

          resolve({
            text: document.body ? document.body.innerText : '',
            articleTexts: visibleArticles().map((node) => node.innerText || '').filter(Boolean).slice(0, ${Number(limit) + 2}),
          });
        }

        run();
      })`,
      true
    );
  }

  const text = await evaluate(client, sessionId, "document.body ? document.body.innerText : ''");

  return {
    text,
    articleTexts: [],
  };
}

async function capturePlaywrightPage({ env, args, platform, url, limit }) {
  const { context } = await launchPersistentBrowser({ env, args, headless: Boolean(args.headless) });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);

    if (platform === "facebook") {
      return await page.evaluate(
        async (postLimit) => {
          function visibleArticles() {
            return Array.from(document.querySelectorAll('[role="article"], article')).filter((node) =>
              (node.innerText || "").includes("미친바람")
            );
          }

          function clickMore(articles) {
            for (const article of articles) {
              const controls = Array.from(article.querySelectorAll('[role="button"], span, div'));
              const more = controls.find((node) => (node.innerText || node.textContent || "").trim() === "더 보기");

              if (more && typeof more.click === "function") {
                more.click();
              }
            }
          }

          window.scrollTo(0, 0);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          clickMore(visibleArticles());
          await new Promise((resolve) => setTimeout(resolve, 900));

          for (let attempt = 0; attempt < 4 && visibleArticles().length < postLimit + 1; attempt += 1) {
            window.scrollBy(0, 900);
            await new Promise((resolve) => setTimeout(resolve, 1400));
            clickMore(visibleArticles());
            await new Promise((resolve) => setTimeout(resolve, 700));
          }

          return {
            text: document.body ? document.body.innerText : "",
            articleTexts: visibleArticles()
              .map((node) => node.innerText || "")
              .filter(Boolean)
              .slice(0, postLimit + 2),
          };
        },
        Number(limit)
      );
    }

    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));

    return {
      text,
      articleTexts: [],
    };
  } finally {
    await context.close();
  }
}

// Instagram's profile grid renders only thumbnail images - post captions don't exist anywhere
// in the profile page's text at all, so scraping document.body.innerText (like the other
// platforms) can never find real post content. Each individual post page does carry the caption
// in a reliable, structured place though: the og:title meta tag ("Instagram의 {user}님 : "caption"")
// and a <time datetime="ISO-8601"> element - both meant for link previews/SEO, so they're much
// less likely to break on a UI redesign than scraping rendered DOM text would be.
function parseInstagramCaption(ogTitle) {
  const match = String(ogTitle || "").match(/:\s*"([\s\S]*)"$/);

  return match ? match[1].trim() : "";
}

async function collectInstagramPostUrls(page, limit) {
  const hrefs = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));

    return [...new Set(anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean))];
  });

  return hrefs.slice(0, limit).map((href) => new URL(href, "https://www.instagram.com").toString());
}

async function captureInstagramPosts({ env, args, url, limit }) {
  const { context } = await launchPersistentBrowser({ env, args, headless: Boolean(args.headless) });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    const postUrls = await collectInstagramPostUrls(page, limit);
    const posts = [];

    for (const postUrl of postUrls) {
      try {
        await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1200);

        const data = await page.evaluate(() => ({
          ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "",
          datetime: document.querySelector("time")?.getAttribute("datetime") || "",
        }));

        const body = parseInstagramCaption(data.ogTitle);
        const date = data.datetime ? new Date(data.datetime) : null;

        if (!body || !date || !Number.isFinite(date.getTime())) {
          continue;
        }

        const shortcode = postUrl.match(/\/(?:p|reel)\/([^/?#]+)/)?.[1] || "";

        posts.push({
          date: formatDateParts(date).date,
          body,
          sourceUrl: postUrl,
          postId: shortcode ? `instagram_${shortcode}` : "",
        });
      } catch (error) {
        console.warn(
          `Instagram post capture failed for ${postUrl}: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    }

    return posts;
  } finally {
    await context.close();
  }
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

function hashText(value) {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
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

async function readExistingPostIds(root) {
  const files = await walkMarkdownFiles(root);
  const ids = new Set();

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");
    const postId = markdown.match(/^post_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

    if (postId) {
      ids.add(postId);
    }
  }

  return ids;
}

function buildMarkdown({ platform, config, account, post }) {
  const date = new Date(`${post.date}T00:00:00`);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const parts = formatDateParts(safeDate);
  const title = post.body.split(/\n+/).find(Boolean)?.slice(0, 80) || `Untitled ${config.label} Post`;
  // A permalink-derived shortcode (post.postId, e.g. Instagram's /p/{code}/) stays stable even
  // if the caption text is later edited, so it dedupes correctly on re-runs; platforms without a
  // stable ID in scraped text (Facebook/Threads) fall back to a content hash.
  const postId = post.postId || `${platform}_browser_${parts.date}_${hashText(post.body)}`;
  const sourceUrl = post.sourceUrl || account?.url || "";

  return {
    postId,
    parts,
    markdown: [
      "---",
      "type: sns-post",
      `platform: ${platform}`,
      `account: "${escapeYaml(account?.label || config.label)}"`,
      `account_url: "${escapeYaml(account?.url || "")}"`,
      `source_url: "${escapeYaml(sourceUrl)}"`,
      `post_id: "${escapeYaml(postId)}"`,
      `created: "${parts.dateTime}"`,
      `date: "${parts.date}"`,
      `year: ${parts.date.slice(0, 4)}`,
      `month: "${parts.month}"`,
      `title: "${escapeYaml(title)}"`,
      "has_images: false",
      "image_count: 0",
      "has_comments: false",
      "comment_count: 0",
      "has_summary: false",
      "tags:",
      `  - ${config.label.replace(/\s+/g, "")}`,
      "  - SNS",
      "media_folder: \"\"",
      `imported_at: "${new Date().toISOString()}"`,
      `import_source: "${platform}-browser-session"`,
      "---",
      "",
      `# ${title}`,
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
      "No comments mapped from this browser-session crawl yet.",
      "",
      "## Summary",
      "",
      "Summary will be generated after the LLM summarizer is connected.",
      "",
      "## Source",
      "",
      sourceUrl ? `[${config.label} post](${sourceUrl})` : `${config.label} browser session`,
      "",
    ].join("\n"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = String(args.platform || "").toLowerCase();
  const config = platformConfigs[platform];

  if (!config) {
    throw new Error("Use --platform facebook, instagram, or threads.");
  }

  const env = await loadEnv();
  const cdpBaseUrl = normalizeCdpBaseUrl(args.cdp || env.SNS_READER_CDP_URL);
  const settings = await loadAppSettings(env);
  const account = (settings?.accounts ?? []).find(
    (item) => item.platform === platform && item.exportToObsidian !== false
  );
  const url = args.url || account?.url;
  const limit = Math.max(1, Math.min(Number(args.limit || 3), 10));
  const since = args.since ? new Date(`${args.since}T00:00:00`) : null;
  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);

  if (!url || !config.urlPattern.test(url)) {
    throw new Error(`${config.label} account URL is not configured.`);
  }

  let client = null;
  let captureSource = "playwright";

  try {
    const sinceFilter = (post) => {
      if (!since) {
        return true;
      }

      const date = new Date(`${post.date}T00:00:00`);

      return Number.isFinite(date.getTime()) && date >= since;
    };

    let extractedPosts;

    if (platform === "instagram") {
      // Instagram has no usable text on the profile page itself (see captureInstagramPosts) -
      // it always needs its own per-post navigation, CDP fallback included.
      extractedPosts = (await captureInstagramPosts({ env, args, url, limit })).filter(sinceFilter);
    } else {
      let capture = null;

      if (cdpBaseUrl) {
        try {
          client = await connectToBrowser(cdpBaseUrl);
          const page = await openBrowserPage(client, url);

          await evaluate(
            client,
            page.sessionId,
            "new Promise((resolve) => { window.scrollTo(0, 0); setTimeout(resolve, 1200); })",
            true
          );

          capture = await captureBrowserPage(client, page.sessionId, platform, limit);
          captureSource = "chrome-cdp";
        } catch (error) {
          console.warn(
            `Chrome CDP capture failed, falling back to Playwright profile: ${
              error instanceof Error ? error.message : "CDP connection failed"
            }`
          );
        }
      }

      if (!capture) {
        capture = await capturePlaywrightPage({ env, args, platform, url, limit });
      }

      extractedPosts = extractPosts({
        platform,
        text: capture.text,
        articleTexts: capture.articleTexts,
        account,
        limit,
      }).filter(sinceFilter);
    }

    if (extractedPosts.length === 0) {
      console.log(`${config.label} browser page opened, but no safe post blocks were extracted.`);
      return;
    }

    const existingPostIds = await readExistingPostIds(path.join(outputRoot, config.outputFolder));
    const written = [];
    let skippedDuplicates = 0;

    for (const post of extractedPosts) {
      const built = buildMarkdown({ platform, config, account, post });

      if (existingPostIds.has(built.postId)) {
        skippedDuplicates += 1;
        continue;
      }

      const stem = `${built.parts.fileDate}_${platform}-browser_${slugify(post.body.slice(0, 36)) || built.postId}`;
      const monthDir = path.join(outputRoot, config.outputFolder, built.parts.month);
      const mdPath = path.join(monthDir, `${stem}.md`);

      await mkdir(monthDir, { recursive: true });
      await writeFile(mdPath, built.markdown, "utf8");
      existingPostIds.add(built.postId);
      written.push(mdPath);
    }

    console.log(`${config.label} browser-session URL: ${url}`);
    console.log(`Capture source: ${captureSource}`);
    console.log(`Extracted posts: ${extractedPosts.length}`);
    console.log(`Written Markdown files: ${written.length}`);
    console.log(`Skipped duplicate posts: ${skippedDuplicates}`);
    written.forEach((filePath) => console.log(filePath));
  } finally {
    client?.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
