import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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

async function loadSettings(env) {
  const settingsPath = path.resolve(workspaceRoot, env.SNS_READER_SETTINGS_FILE || DEFAULT_SETTINGS_FILE);

  return readFile(settingsPath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/\u200b/g, "")
    .trim();
}

function extractBlogId(accountUrl) {
  const text = String(accountUrl || "");
  const direct = text.match(/blog\.naver\.com\/([^/?#]+)/i)?.[1];
  const query = text.match(/[?&]blogId=([^&#]+)/i)?.[1];

  return decodeURIComponent(query || direct || "madwind");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchText(url) {
  let response;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://blog.naver.com/",
      },
    });

    if (response.status !== 429) {
      break;
    }

    await sleep(2500 * (attempt + 1));
  }

  if (!response?.ok) {
    throw new Error(`${url} failed with HTTP ${response?.status ?? "unknown"}`);
  }

  return response.text();
}

function parseNaverDate(value) {
  const match = String(value ?? "").match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(?:(\d{1,2}):(\d{1,2}))?/);

  if (!match) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }

  const [, year, month, day, hour = "0", minute = "0"] = match;

  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractBalancedElement(html, startIndex, tagName = "div") {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");

  let depth = 0;

  for (const match of html.slice(startIndex).matchAll(tagPattern)) {
    const absoluteIndex = startIndex + match.index;
    const tag = match[0];

    if (tag.startsWith("</")) {
      depth -= 1;

      if (depth === 0) {
        return html.slice(startIndex, absoluteIndex + tag.length);
      }
    } else if (!tag.endsWith("/>")) {
      depth += 1;
    }
  }

  return html.slice(startIndex);
}

function extractElementById(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<div\\b[^>]*id=["']${escapedId}["'][^>]*>`, "i"));

  if (!match || typeof match.index !== "number") {
    return "";
  }

  return extractBalancedElement(html, match.index, "div");
}

function extractElementByClass(html, className) {
  const tagPattern = /<div\b[^>]*class=["']([^"']+)["'][^>]*>/gi;

  for (const match of html.matchAll(tagPattern)) {
    const classes = match[1].split(/\s+/);

    if (classes.includes(className) && typeof match.index === "number") {
      return extractBalancedElement(html, match.index, "div");
    }
  }

  return "";
}

function htmlToText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split(/\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTextByClass(html, className) {
  const match = html.match(new RegExp(`<[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));

  return htmlToText(match?.[1] || "");
}

function readOgTitle(html) {
  const match = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i);

  return decodeHtml(match?.[1] || "");
}

function extractCategory(html) {
  const match = html.match(/<span\b[^>]*class=["'][^"']*\bcate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);

  return htmlToText(match?.[1] || "");
}

function extractDate(html) {
  const match = html.match(/<p\b[^>]*class=["'][^"']*_postAddDate[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);

  return parseNaverDate(htmlToText(match?.[1] || ""));
}

function extractBody(html, logNo) {
  const direct = extractElementById(html, `post-view${logNo}`);

  if (direct) {
    return htmlToText(extractElementByClass(direct, "view") || direct);
  }

  const postViewArea = extractElementById(html, "postViewArea");

  return htmlToText(extractElementByClass(postViewArea, "view") || postViewArea);
}

function isBlockedScrapBody(value) {
  const text = String(value || "");

  return text.includes("재스크랩이 불가능합니다");
}

function extractImageUrls(containerHtml) {
  const urls = [];

  for (const match of containerHtml.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const candidates = [
      tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
    ];

    for (const candidate of candidates) {
      const url = decodeHtml(candidate || "");

      if (
        /^https?:\/\//i.test(url) &&
        !url.includes("ssl.pstatic.net/static") &&
        !url.includes("blogimgs.pstatic.net") &&
        !url.includes("spc.gif")
      ) {
        urls.push(url.replace(/\?type=.*$/, ""));
        break;
      }
    }
  }

  return unique(urls);
}

async function downloadImage(url, targetPath) {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
        Referer: "https://blog.naver.com/",
      },
    });
  } catch {
    console.warn(`Skipping image after fetch error: ${url}`);
    return false;
  }

  if (!response.ok) {
    return false;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, bytes);
  return true;
}

function extensionFromUrl(url) {
  const parsed = new URL(url);
  const extension = path.extname(parsed.pathname).toLowerCase();

  return extension && extension.length <= 6 ? extension : ".jpg";
}

async function copyPostImages(imageUrls, mediaDir) {
  await mkdir(mediaDir, { recursive: true });

  const copiedImages = [];
  let imageIndex = 0;

  for (const imageUrl of imageUrls) {
    imageIndex += 1;
    const extension = extensionFromUrl(imageUrl);
    const fileName = `image-${String(imageIndex).padStart(3, "0")}${extension}`;
    const targetPath = path.join(mediaDir, fileName);

    if (await downloadImage(imageUrl, targetPath)) {
      copiedImages.push(fileName);
    }
  }

  return copiedImages;
}

async function walkMarkdownFiles(root, files = []) {
  if (!existsSync(root)) {
    return files;
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
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

async function readExistingMemologIds(root) {
  const files = await walkMarkdownFiles(root);
  const ids = new Set();

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");
    const platform = markdown.match(/^platform:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const sourceType = markdown.match(/^source_type:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const importSource = markdown.match(/^import_source:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const postId = markdown.match(/^post_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

    if (platform === "naver-blog" && postId && (sourceType === "memolog" || importSource === "naver-memolog-crawl")) {
      ids.add(postId);
    }
  }

  return ids;
}

function parseMemologList(html, blogId, page) {
  const posts = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=["']([^"']*MemologPostView\.naver[^"']*logNo=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const [, href, logNo, innerHtml] = match;

    if (seen.has(logNo)) {
      continue;
    }

    seen.add(logNo);
    posts.push({
      blogId,
      category: "",
      date: null,
      link: `https://blog.naver.com/madwind/memo/${logNo}`,
      logNo,
      page,
      sourceUrl: `https://blog.naver.com/${blogId}/memo/${logNo}`,
      tags: ["MemoLog"],
      title: htmlToText(innerHtml),
      viewUrl: `https://blog.naver.com${decodeHtml(href).startsWith("/") ? "" : "/"}${decodeHtml(href)}`,
    });
  }

  return posts;
}

function discoverPages(html) {
  return [...new Set([...html.matchAll(/currentPage=(\d+)/g)].map((match) => Number(match[1])).filter(Boolean))];
}

async function fetchMemologListPage(blogId, page) {
  const params = new URLSearchParams({
    blogId,
    Redirect: "MemoList",
    currentPage: String(page),
  });
  const url = `https://blog.naver.com/memo/MemologPostList.naver?${params.toString()}`;
  const html = await fetchText(url);

  return {
    html,
    page,
    posts: parseMemologList(html, blogId, page),
    visiblePages: discoverPages(html),
  };
}

async function discoverMemologPosts({ blogId, limit, pageFrom, pageTo, pageDelayMs }) {
  const posts = [];
  const seen = new Set();
  let page = pageFrom || 1;
  let maxPage = pageTo || page;
  let stalePages = 0;

  while (page <= maxPage || (!pageTo && stalePages < 2)) {
    const pageData = await fetchMemologListPage(blogId, page);
    const visibleMax = Math.max(0, ...pageData.visiblePages);

    if (!pageTo && visibleMax > maxPage) {
      maxPage = visibleMax;
    }

    let newCount = 0;

    for (const post of pageData.posts) {
      if (!post.logNo || seen.has(post.logNo)) {
        continue;
      }

      seen.add(post.logNo);
      posts.push(post);
      newCount += 1;

      if (limit && posts.length >= limit) {
        return posts;
      }
    }

    console.log(`Discovered memolog page ${page}: ${newCount} new / ${pageData.posts.length} listed`);
    stalePages = newCount === 0 ? stalePages + 1 : 0;
    page += 1;

    if (pageDelayMs) {
      await sleep(pageDelayMs);
    }
  }

  return posts;
}

async function fetchMemologPost(post) {
  const html = await fetchText(post.viewUrl);
  const title = extractTextByClass(html, "itemSubjectBoldfont") || readOgTitle(html) || post.title;
  const category = extractCategory(html);
  const date = extractDate(html);
  const body = extractBody(html, post.logNo);
  const container = extractElementById(html, `post-view${post.logNo}`) || extractElementById(html, "postViewArea");
  const imageUrls = extractImageUrls(container);

  return {
    ...post,
    body,
    category,
    date,
    imageUrls,
    title,
  };
}

function buildMarkdown({ post, account, mediaFolder, copiedImages }) {
  const parts = formatDateParts(post.date);
  const tags = unique(["NaverBlog", "MemoLog", "SNS", ...post.tags]);

  return [
    "---",
    "type: sns-post",
    "platform: naver-blog",
    `account: "${escapeYaml(account?.label || "Naver Blog")}"`,
    `account_url: "${escapeYaml(account?.url || "")}"`,
    `source_url: "${escapeYaml(post.sourceUrl)}"`,
    `post_id: "${escapeYaml(post.logNo)}"`,
    `created: "${parts.dateTime}"`,
    `date: "${parts.date}"`,
    `year: ${parts.date.slice(0, 4)}`,
    `month: "${parts.month}"`,
    `title: "${escapeYaml(post.title)}"`,
    `category: "${escapeYaml(post.category)}"`,
    "source_type: \"memolog\"",
    `has_images: ${copiedImages.length > 0}`,
    `image_count: ${copiedImages.length}`,
    "has_comments: false",
    "comment_count: 0",
    "has_summary: false",
    "tags:",
    ...tags.map((tag) => `  - ${escapeYaml(tag)}`),
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    "import_source: \"naver-memolog-crawl\"",
    "---",
    "",
    `# ${post.title || "Untitled Naver MemoLog Post"}`,
    "",
    "## Date",
    "",
    parts.dateTime,
    "",
    "## Body",
    "",
    post.body || "No post body captured.",
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
    "No comments mapped from this crawl yet.",
    "",
    "## Summary",
    "",
    "Summary will be generated after the LLM summarizer is connected.",
    "",
    "## Source",
    "",
    `[Naver Blog memo](${post.sourceUrl})`,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadSettings(env);
  const account = (settings.accounts ?? []).find((item) => item.platform === "naver-blog");
  const blogId = args.blogId || extractBlogId(account?.url || args.url);
  const limit = args.limit ? Number(args.limit) : 0;
  const outputRoot = path.resolve(args.out || settings.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);
  const pageFrom = args["page-from"] ? Number(args["page-from"]) : 0;
  const pageTo = args["page-to"] ? Number(args["page-to"]) : 0;
  const pageDelayMs = args["page-delay-ms"] ? Number(args["page-delay-ms"]) : 400;
  const postDelayMs = args["post-delay-ms"] ? Number(args["post-delay-ms"]) : 300;
  const listPosts = await discoverMemologPosts({ blogId, limit, pageFrom, pageTo, pageDelayMs });
  const written = [];
  const existingPostIds = await readExistingMemologIds(path.join(outputRoot, "Naver Blog"));
  let skipped = 0;
  let skippedDuplicates = 0;

  for (const item of listPosts) {
    if (existingPostIds.has(item.logNo)) {
      skippedDuplicates += 1;
      console.log(`Skipping duplicate Naver MemoLog post: ${item.logNo} ${item.title}`);
      continue;
    }

    console.log(`Importing ${written.length + skipped + 1}/${listPosts.length}: ${item.logNo} ${item.title}`);
    let post;

    try {
      post = await fetchMemologPost(item);
    } catch (error) {
      console.warn(`Skipping memolog after fetch error: ${item.logNo} ${item.title}`);
      skipped += 1;
      continue;
    }

    if (isBlockedScrapBody(post.body)) {
      console.log(`Skipping blocked scrap memolog: ${post.logNo} ${post.title}`);
      skipped += 1;
      continue;
    }

    if (!post.body) {
      console.log(
        post.imageUrls.length > 0
          ? `Skipping image-only memolog: ${post.logNo} ${post.title}`
          : `Skipping bodyless memolog: ${post.logNo} ${post.title}`
      );
      skipped += 1;
      continue;
    }

    const parts = formatDateParts(post.date);
    const stem = `${parts.fileDate}_naver-memolog_${post.logNo}_${slugify(post.title) || post.logNo}`;
    const monthDir = path.join(outputRoot, "Naver Blog", parts.month);
    const mediaFolder = `assets/${stem}`;
    const mediaDir = path.join(monthDir, "assets", stem);
    const copiedImages = await copyPostImages(post.imageUrls, mediaDir);
    const mdPath = path.join(monthDir, `${stem}.md`);
    const metaPath = path.join(mediaDir, "meta.json");

    await mkdir(monthDir, { recursive: true });
    await writeFile(mdPath, buildMarkdown({ post, account, mediaFolder, copiedImages }), "utf8");
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          sourcePost: post.sourceUrl,
          sourceView: post.viewUrl,
          imageUrls: post.imageUrls,
          copiedImages,
          capturedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    written.push(mdPath);
    existingPostIds.add(post.logNo);

    if (postDelayMs) {
      await sleep(postDelayMs);
    }
  }

  console.log(`Naver Blog MemoLog: https://blog.naver.com/memo/MemologPostList.naver?blogId=${blogId}`);
  console.log(`Discovered memolog posts: ${listPosts.length}`);
  console.log(`Written Markdown files: ${written.length}`);
  console.log(`Skipped memolog posts: ${skipped}`);
  console.log(`Skipped duplicate memolog posts: ${skippedDuplicates}`);
  console.log(`Output folder: ${path.join(outputRoot, "Naver Blog")}`);
  written.forEach((filePath) => console.log(filePath));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
