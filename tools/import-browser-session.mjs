import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

function normalizeLines(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

// Facebook only ever shows relative time ("1일", "2일") in the feed, with no exact machine-
// readable timestamp exposed anywhere in the DOM (unlike Instagram/Threads' <time datetime>) -
// so the computed calendar date can drift by a day between two runs of the same post depending
// on exactly when each run happens relative to Facebook's own relative-time rounding. Since the
// default postId is date-derived, that drift alone used to produce duplicate files across runs.
// The permalink's pfbid/story_fbid/video id segment is stable regardless of when it's read, so
// it's used as the postId whenever a permalink was found, exactly like Instagram/Threads already
// do with their own shortcodes.
function facebookPostIdFromPermalink(permalink) {
  if (!permalink) {
    return "";
  }

  const match =
    permalink.match(/\/posts\/([^/?#]+)/) ||
    permalink.match(/\/videos\/([^/?#]+)/) ||
    permalink.match(/\/reel\/([^/?#]+)/) ||
    permalink.match(/[?&]story_fbid=([^&]+)/);

  return match ? `facebook_${match[1]}` : "";
}

function extractFacebookArticles(articles, limit) {
  const posts = [];

  for (const article of articles) {
    const lines = normalizeLines(article.text);
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
      permalink: article.permalink || "",
      postId: facebookPostIdFromPermalink(article.permalink || ""),
    });

    if (posts.length >= limit) {
      break;
    }
  }

  return posts;
}

// This is only ever called for Facebook now - Instagram/Threads both moved to dedicated
// per-post-permalink capture functions (captureInstagramPosts / captureThreadsPosts).
function extractPosts({ platform, articles = [], limit }) {
  return platform === "facebook" ? extractFacebookArticles(articles, limit) : [];
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

        function articlePermalink(article) {
          const link = Array.from(article.querySelectorAll('a[href*="/posts/"], a[href*="/videos/"], a[href*="story_fbid"], a[href*="/reel/"]'))[0];
          return link ? link.href : '';
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
            articles: visibleArticles()
              .map((node) => ({ text: node.innerText || '', permalink: articlePermalink(node) }))
              .filter((article) => article.text)
              .slice(0, ${Number(limit) + 2}),
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
    articles: [],
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

          function articlePermalink(article) {
            const link = article.querySelector(
              'a[href*="/posts/"], a[href*="/videos/"], a[href*="story_fbid"], a[href*="/reel/"]'
            );

            return link ? link.href : "";
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
            articles: visibleArticles()
              .map((node) => ({ text: node.innerText || "", permalink: articlePermalink(node) }))
              .filter((article) => article.text)
              .slice(0, postLimit + 2),
          };
        },
        Number(limit)
      );
    }

    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));

    return {
      text,
      articles: [],
    };
  } finally {
    await context.close();
  }
}

export function extensionFromUrl(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();

    return extension && extension.length <= 6 ? extension : ".jpg";
  } catch {
    return ".jpg";
  }
}

// Real post photos don't all come from one predictable CDN bucket - e.g. a Threads reel used
// "t51.71878-15" instead of the usual "t51.82787-15", which a bucket allowlist wrongly rejected
// as "not a real photo" even though it was one. Instagram/Threads tag every served image with a
// base64-encoded "efg" query param describing its purpose (e.g. `{"efg_tag":"FEED.best_image_
// urlgen.C3"}` for a real post photo vs `{"efg_tag":"profile_pic.django.180.c1"}` for the
// og:image fallback shown on text-only posts) - reading that tag directly is far more reliable
// than guessing which bucket IDs mean what.
export function isRealContentImageUrl(url) {
  if (typeof url !== "string" || !url) {
    return false;
  }

  try {
    const efg = new URL(url).searchParams.get("efg");

    if (efg) {
      return !Buffer.from(efg, "base64").toString("utf8").toLowerCase().includes("profile_pic");
    }
  } catch {
    // Not a parseable URL or no efg param - fall through to the bucket-based fallback below.
  }

  return !url.includes("/t51.82787-19/");
}

// These CDN URLs are meant to be fetched by link-preview crawlers (Facebook's own bot, Slack,
// etc.) with no login, so a plain fetch works - no need to keep the Playwright browser context
// (and its cookies) alive just to download images after the capture pass has already finished.
// One exception: Facebook's crawler-facing og:image sometimes points at
// lookaside.fbsbx.com/lookaside/crawler/media/?media_id=... - a proxy endpoint that only returns
// actual image bytes for the same crawler user-agent used to discover it; any other UA gets back
// an HTML page that client-side-redirects a real browser to a photo viewer, not raw bytes. Reusing
// that UA there (and verifying the response is actually image/* before saving, since silently
// writing that redirect HTML into a ".jpg" file is worse than not downloading anything) fixes it.
export async function downloadPostImages(imageUrls, mediaDir) {
  await mkdir(mediaDir, { recursive: true });

  const copied = [];
  let index = 0;

  for (const imageUrl of imageUrls) {
    index += 1;

    try {
      const isFacebookLookaside = /(?:^|\.)fbsbx\.com$/.test(new URL(imageUrl).hostname);
      const userAgent = isFacebookLookaside
        ? "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
        : "Mozilla/5.0 SNS-Reader/0.1";
      const response = await fetch(imageUrl, { headers: { "User-Agent": userAgent } });

      if (!response.ok || !(response.headers.get("content-type") || "").startsWith("image/")) {
        continue;
      }

      const fileName = `image-${String(index).padStart(3, "0")}${extensionFromUrl(imageUrl)}`;

      await writeFile(path.join(mediaDir, fileName), Buffer.from(await response.arrayBuffer()));
      copied.push(fileName);
    } catch (error) {
      console.warn(`Skipping image after fetch error: ${imageUrl}`);
    }
  }

  return copied;
}

// A logged-in browser session gets empty og:* meta tags on a Facebook post permalink, and
// navigating there directly renders the general feed around the post rather than a focused
// single-post view - scraping any <img> found that way turned out to pick up unrelated
// suggested-content thumbnails, not the post's own photo (confirmed by inspecting a downloaded
// file). Requesting the exact same permalink with Facebook's own crawler user-agent - the one
// it uses to generate its own link previews for Messenger/WhatsApp/etc. - needs no login at all
// and reliably returns a real og:image for a public post with a photo, and none at all for a
// text-only post (no ambiguous fallback image to filter out, unlike Instagram/Threads).
export async function fetchFacebookOgImage(permalinkUrl) {
  try {
    const response = await fetch(permalinkUrl, {
      headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
    });

    if (!response.ok) {
      return "";
    }

    const html = await response.text();
    const match = html.match(/<meta property="og:image" content="([^"]+)"/);

    return match ? match[1].replaceAll("&amp;", "&") : "";
  } catch (error) {
    console.warn(`Facebook og:image fetch failed for ${permalinkUrl}: ${error instanceof Error ? error.message : "unknown error"}`);
    return "";
  }
}

async function attachFacebookImages(posts) {
  for (const post of posts) {
    if (!post.permalink) {
      continue;
    }

    const imageUrl = await fetchFacebookOgImage(post.permalink);

    if (imageUrl) {
      post.imageUrls = [imageUrl];
    }
  }

  return posts;
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
          ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
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
          imageUrls: isRealContentImageUrl(data.ogImage) ? [data.ogImage] : [],
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

// Threads has the same problem as Instagram, but a cleaner fix is available: its post permalinks
// ("/@handle/post/{id}") are collectible from the profile feed the same way, and its individual
// post pages expose the caption directly via og:description (no prefix to strip, unlike
// Instagram's og:title) plus the same og:image/<time> pair - so this replaces the old raw-text
// line-scanning extractor (extractThreadsBlocks) entirely for the primary capture path.
async function collectThreadsPostUrls(page, limit) {
  const hrefs = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/post/"]'));

    return [...new Set(anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean))];
  });

  return hrefs.slice(0, limit).map((href) => new URL(href, "https://www.threads.com").toString());
}

async function captureThreadsPosts({ env, args, url, limit }) {
  const { context } = await launchPersistentBrowser({ env, args, headless: Boolean(args.headless) });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    const postUrls = await collectThreadsPostUrls(page, limit);
    const posts = [];

    for (const postUrl of postUrls) {
      try {
        await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1200);

        const data = await page.evaluate(() => ({
          ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "",
          ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
          datetime: document.querySelector("time")?.getAttribute("datetime") || "",
        }));

        const body = data.ogDescription.trim();
        const date = data.datetime ? new Date(data.datetime) : null;

        if (!body || !date || !Number.isFinite(date.getTime())) {
          continue;
        }

        const postCode = postUrl.match(/\/post\/([^/?#]+)/)?.[1] || "";

        posts.push({
          date: formatDateParts(date).date,
          body,
          sourceUrl: postUrl,
          postId: postCode ? `threads_${postCode}` : "",
          imageUrls: isRealContentImageUrl(data.ogImage) ? [data.ogImage] : [],
        });
      } catch (error) {
        console.warn(
          `Threads post capture failed for ${postUrl}: ${error instanceof Error ? error.message : "unknown error"}`
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

async function readExistingPostEntries(root) {
  const files = await walkMarkdownFiles(root);
  const entries = new Map();

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");
    const postId = markdown.match(/^post_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

    if (postId) {
      entries.set(postId, filePath);
    }
  }

  return entries;
}

function buildMarkdown({ platform, config, account, post, copiedImages = [], mediaFolder = "" }) {
  const date = new Date(`${post.date}T00:00:00`);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const parts = formatDateParts(safeDate);
  const title = post.body.split(/\n+/).find(Boolean)?.slice(0, 80) || `Untitled ${config.label} Post`;
  // A permalink-derived shortcode (post.postId, e.g. Instagram's /p/{code}/) stays stable even
  // if the caption text is later edited, so it dedupes correctly on re-runs; platforms without a
  // stable ID in scraped text (Facebook/Threads) fall back to a content hash.
  const postId = post.postId || `${platform}_browser_${parts.date}_${hashText(post.body)}`;
  const sourceUrl = post.sourceUrl || post.permalink || account?.url || "";

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
      `has_images: ${copiedImages.length > 0}`,
      `image_count: ${copiedImages.length}`,
      "has_comments: false",
      "comment_count: 0",
      "has_summary: false",
      "tags:",
      `  - ${config.label.replace(/\s+/g, "")}`,
      "  - SNS",
      `media_folder: "${escapeYaml(mediaFolder)}"`,
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
      copiedImages.length
        ? copiedImages.map((fileName) => `![[${mediaFolder}/${fileName}]]`).join("\n")
        : "No images captured.",
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
  const force = Boolean(args.force);
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
    } else if (platform === "threads") {
      extractedPosts = (await captureThreadsPosts({ env, args, url, limit })).filter(sinceFilter);
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
        articles: capture.articles,
        account,
        limit,
      }).filter(sinceFilter);

      if (platform === "facebook") {
        extractedPosts = await attachFacebookImages(extractedPosts);
      }
    }

    if (extractedPosts.length === 0) {
      console.log(`${config.label} browser page opened, but no safe post blocks were extracted.`);
      return;
    }

    const existingPostEntries = await readExistingPostEntries(path.join(outputRoot, config.outputFolder));
    const written = [];
    let skippedDuplicates = 0;
    let refreshed = 0;

    for (const post of extractedPosts) {
      const meta = buildMarkdown({ platform, config, account, post });
      const existingPath = existingPostEntries.get(meta.postId);

      if (existingPath) {
        // --force is only set for the small "lookback" window at the front of an Update run
        // (see updateScriptForAccount), so this only re-writes the handful of most recent posts
        // - not the whole history - letting an edited caption/body get picked up.
        if (!force) {
          skippedDuplicates += 1;
          continue;
        }

        await rm(existingPath, { force: true });
        refreshed += 1;
      }

      const stem = `${meta.parts.fileDate}_${platform}-browser_${slugify(post.body.slice(0, 36)) || meta.postId}`;
      const monthDir = path.join(outputRoot, config.outputFolder, meta.parts.month);
      const mdPath = path.join(monthDir, `${stem}.md`);
      const mediaFolder = `assets/${stem}`;
      const mediaDir = path.join(monthDir, "assets", stem);
      const imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : [];
      const copiedImages = imageUrls.length > 0 ? await downloadPostImages(imageUrls, mediaDir) : [];
      const built = buildMarkdown({
        platform,
        config,
        account,
        post,
        copiedImages,
        mediaFolder: copiedImages.length > 0 ? mediaFolder : "",
      });

      await mkdir(monthDir, { recursive: true });
      await writeFile(mdPath, built.markdown, "utf8");
      existingPostEntries.set(built.postId, mdPath);
      written.push(mdPath);
    }

    console.log(`${config.label} browser-session URL: ${url}`);
    console.log(`Capture source: ${captureSource}`);
    console.log(`Extracted posts: ${extractedPosts.length}`);
    console.log(`Written Markdown files: ${written.length}`);
    console.log(`Refreshed existing posts: ${refreshed}`);
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
