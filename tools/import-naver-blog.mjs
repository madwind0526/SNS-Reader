import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_MARKDOWN_ROOT = "./data/sample-md";
const NAVER_BLOG_RSS_BASE = "https://rss.blog.naver.com";

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

async function fetchText(url) {
  let response;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readXmlTag(value, tagName) {
  const match = value.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));

  return decodeHtml(match?.[1] ?? "");
}

function parseRssItems(rssXml) {
  return [...rssXml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const itemXml = match[1];
    const guid = readXmlTag(itemXml, "guid");
    const link = readXmlTag(itemXml, "link");
    const sourceUrl = guid || link.replace(/\?.*$/, "");
    const logNo = sourceUrl.match(/\/(\d+)(?:\?|$)/)?.[1] || "";

    return {
      author: readXmlTag(itemXml, "author"),
      category: readXmlTag(itemXml, "category"),
      description: readXmlTag(itemXml, "description"),
      link,
      logNo,
      pubDate: readXmlTag(itemXml, "pubDate"),
      sourceUrl,
      tags: readXmlTag(itemXml, "tag")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      title: readXmlTag(itemXml, "title"),
    };
  });
}

function decodeNaverTitle(value) {
  try {
    return decodeURIComponent(String(value ?? "").replace(/\+/g, " "));
  } catch {
    return decodeHtml(value);
  }
}

function parsePostListArray(responseText) {
  const keyIndex = responseText.indexOf('"postList"');

  if (keyIndex < 0) {
    return [];
  }

  const start = responseText.indexOf("[", keyIndex);

  if (start < 0) {
    return [];
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < responseText.length; index += 1) {
    const char = responseText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(responseText.slice(start, index + 1));
      }
    }
  }

  return [];
}

function readPostListTotalCount(responseText) {
  const match = responseText.match(/"totalCount"\s*:\s*"(\d+)"/);

  return match ? Number(match[1]) : 0;
}

function parseNaverListDate(value) {
  const match = String(value ?? "").match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);

  if (!match) {
    return parseNaverDate(value);
  }

  const [, year, month, day] = match.map(Number);

  return new Date(year, month - 1, day, 0, 0, 0);
}

function parseNaverDate(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return new Date();
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractPostContainer(html) {
  const seMatch = html.match(/<div\b[^>]*class="[^"]*se-main-container[^"]*"[^>]*>/i);
  const oldMobileMatch = html.match(/<div\b[^>]*class="[^"]*post_ct[^"]*"[^>]*id="viewTypeSelector"[^>]*>/i);
  const oldPcMatch = html.match(/<div\b[^>]*id="postViewArea"[^>]*>/i);
  const match = seMatch || oldMobileMatch || oldPcMatch;
  const start = typeof match?.index === "number" ? match.index : -1;

  if (start < 0) {
    return "";
  }

  const socialPluginIndex = html.indexOf('<div class="social_plugin_property"', start);
  const socialPluginJsonIndex = html.indexOf('<div id="socialPluginInfoJson"', start);
  const footerIndex = html.indexOf('<div id="post_footer_contents"', start);
  const endCandidates = [socialPluginIndex, socialPluginJsonIndex, footerIndex].filter((index) => index > start);
  const end = endCandidates.length ? Math.min(...endCandidates) : html.indexOf("</body>", start);

  return html.slice(start, end > start ? end : undefined);
}

function extractTextFromContainer(containerHtml) {
  let paragraphMatches = [...containerHtml.matchAll(/<p\b[^>]*class="[^"]*se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)];

  if (!paragraphMatches.length) {
    paragraphMatches = [...containerHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  }

  if (!paragraphMatches.length) {
    return decodeHtml(
      containerHtml
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/div>\s*<div\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
      .split(/\n/)
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const paragraphs = paragraphMatches
    .map((match) => {
      const withLinkText = match[1].replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");

      return decodeHtml(
        withLinkText
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/div>\s*<div\b[^>]*>/gi, "\n")
          .replace(/<[^>]+>/g, "")
      );
    })
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs.join("\n\n").replace(/\n{4,}/g, "\n\n").trim();
}

function isBlockedScrapBody(value) {
  return /스크랩된 글은 재스크랩이 불가능합니다/.test(String(value || ""));
}

function extractImageUrls(containerHtml) {
  const urls = [];

  for (const match of containerHtml.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const candidates = [
      tag.match(/\bdata-lazy-src="([^"]+)"/i)?.[1],
      tag.match(/\bdata-src="([^"]+)"/i)?.[1],
      tag.match(/\bsrc="([^"]+)"/i)?.[1],
    ];

    for (const candidate of candidates) {
      const url = decodeHtml(candidate || "");

      if (/^https?:\/\//i.test(url) && !url.includes("ssl.pstatic.net/static")) {
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
  } catch (error) {
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

async function readExistingPostIds(root) {
  const files = await walkMarkdownFiles(root);
  const ids = new Set();

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");
    const platform = markdown.match(/^platform:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const postId = markdown.match(/^post_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

    if (platform === "naver-blog" && postId) {
      ids.add(postId);
    }
  }

  return ids;
}

async function fetchTitleListPage(blogId, page, countPerPage = 30) {
  const params = new URLSearchParams({
    blogId,
    viewdate: "",
    currentPage: String(page),
    categoryNo: "0",
    parentCategoryNo: "",
    countPerPage: String(countPerPage),
  });
  const url = `https://blog.naver.com/PostTitleListAsync.naver?${params.toString()}`;
  const text = await fetchText(url);
  const postList = parsePostListArray(text).map((item) => {
    const date = parseNaverListDate(item.addDate);

    return {
      author: "",
      category: item.categoryName || item.categoryNo || "",
      categoryNo: item.categoryNo || "",
      commentCount: Number(item.commentCount) || 0,
      date,
      description: "",
      link: `https://blog.naver.com/${blogId}/${item.logNo}`,
      logNo: item.logNo,
      pubDate: item.addDate,
      sourceUrl: `https://blog.naver.com/${blogId}/${item.logNo}`,
      tags: [],
      title: decodeNaverTitle(item.title),
    };
  });

  return {
    page,
    postList,
    totalCount: readPostListTotalCount(text),
  };
}

function isDateInRange(date, dateFrom, dateTo) {
  return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
}

async function discoverDateRangePosts({ blogId, dateFrom, dateTo, limit, pageFrom, pageTo, pageDelayMs }) {
  const firstPage = pageFrom ? null : await fetchTitleListPage(blogId, 1);
  const totalPages = pageTo || Math.max(1, Math.ceil((firstPage?.totalCount ?? 0) / 30));
  const startPage = pageFrom || 1;
  const found = [];
  const seen = new Set();

  for (let page = startPage; page <= totalPages; page += 1) {
    const pageData = page === 1 && firstPage ? firstPage : await fetchTitleListPage(blogId, page);

    for (const item of pageData.postList) {
      if (!item.logNo || seen.has(item.logNo)) {
        continue;
      }

      seen.add(item.logNo);

      if (isDateInRange(item.date, dateFrom, dateTo)) {
        found.push(item);

        if (limit && found.length >= limit) {
          return found;
        }
      }
    }

    const oldestDate = pageData.postList.at(-1)?.date;

    if (dateFrom && oldestDate && oldestDate < dateFrom) {
      break;
    }

    if (pageDelayMs) {
      await sleep(pageDelayMs);
    }
  }

  return found;
}

async function fetchPostHtml(blogId, logNo) {
  const mobileHtml = await fetchText(`https://m.blog.naver.com/${blogId}/${logNo}`);
  const mobileBody = extractTextFromContainer(extractPostContainer(mobileHtml));

  if (mobileBody) {
    return mobileHtml;
  }

  return fetchText(
    `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(
      logNo
    )}&redirect=Dlog&widgetTypeCall=true&directAccess=false`
  );
}

function buildMarkdown({ post, account, body, mediaFolder, copiedImages }) {
  const parts = formatDateParts(post.date);
  const sourceUrl = post.sourceUrl || `https://blog.naver.com/${post.blogId}/${post.logNo}`;
  const tags = unique(["NaverBlog", "SNS", ...post.tags]);

  return [
    "---",
    "type: sns-post",
    "platform: naver-blog",
    `account: "${escapeYaml(account?.label || "Naver Blog")}"`,
    `account_url: "${escapeYaml(account?.url || "")}"`,
    `source_url: "${escapeYaml(sourceUrl)}"`,
    `post_id: "${escapeYaml(post.logNo)}"`,
    `created: "${parts.dateTime}"`,
    `date: "${parts.date}"`,
    `year: ${parts.date.slice(0, 4)}`,
    `month: "${parts.month}"`,
    `title: "${escapeYaml(post.title)}"`,
    `category: "${escapeYaml(post.category)}"`,
    `has_images: ${copiedImages.length > 0}`,
    `image_count: ${copiedImages.length}`,
    "has_comments: false",
    "comment_count: 0",
    "has_summary: false",
    "tags:",
    ...tags.map((tag) => `  - ${escapeYaml(tag)}`),
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    "import_source: \"naver-blog-crawl\"",
    "---",
    "",
    `# ${post.title || "Untitled Naver Blog Post"}`,
    "",
    "## Date",
    "",
    parts.dateTime,
    "",
    "## Body",
    "",
    body || post.description || "No post body captured.",
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
    `[Naver Blog post](${sourceUrl})`,
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
  const dateFrom = args["date-from"] ? new Date(`${args["date-from"]}T00:00:00`) : null;
  const dateTo = args["date-to"] ? new Date(`${args["date-to"]}T23:59:59`) : null;
  const rssUrl = `${NAVER_BLOG_RSS_BASE}/${blogId}.xml`;
  const pageFrom = args["page-from"] ? Number(args["page-from"]) : 0;
  const pageTo = args["page-to"] ? Number(args["page-to"]) : 0;
  const pageDelayMs = args["page-delay-ms"] ? Number(args["page-delay-ms"]) : 400;
  const postDelayMs = args["post-delay-ms"] ? Number(args["post-delay-ms"]) : 300;
  const existingPostIds = await readExistingPostIds(path.join(outputRoot, "Naver Blog"));
  let skippedDuplicates = 0;
  const rssItems =
    dateFrom || dateTo
      ? await discoverDateRangePosts({ blogId, dateFrom, dateTo, limit, pageFrom, pageTo, pageDelayMs })
      : parseRssItems(await fetchText(rssUrl))
          .filter((item) => item.logNo)
          .slice(0, limit || 1);
  const written = [];

  for (const item of rssItems) {
    if (existingPostIds.has(item.logNo)) {
      skippedDuplicates += 1;
      console.log(`Skipping duplicate Naver Blog post: ${item.logNo} ${item.title}`);
      continue;
    }

    console.log(`Importing ${written.length + 1}/${rssItems.length}: ${item.pubDate} ${item.title}`);
    let postHtml;

    try {
      postHtml = await fetchPostHtml(blogId, item.logNo);
    } catch (error) {
      console.warn(`Skipping post after fetch error: ${item.pubDate} ${item.title}`);
      continue;
    }

    const container = extractPostContainer(postHtml);
    const body = extractTextFromContainer(container) || item.description.replace(/<[^>]+>/g, "").trim();

    if (isBlockedScrapBody(body)) {
      console.log(`Skipping blocked scrap: ${item.pubDate} ${item.title}`);
      continue;
    }

    const imageUrls = extractImageUrls(container);

    if (!body) {
      console.log(
        imageUrls.length > 0
          ? `Skipping image-only post: ${item.pubDate} ${item.title}`
          : `Skipping bodyless post: ${item.pubDate} ${item.title}`
      );
      continue;
    }

    const date = item.date || parseNaverDate(item.pubDate);
    const parts = formatDateParts(date);
    const stem = `${parts.fileDate}_naver-blog_${item.logNo}_${slugify(item.title) || item.logNo}`;
    const monthDir = path.join(outputRoot, "Naver Blog", parts.month);
    const mediaFolder = `assets/${stem}`;
    const mediaDir = path.join(monthDir, "assets", stem);
    const copiedImages = await copyPostImages(imageUrls, mediaDir);
    const mdPath = path.join(monthDir, `${stem}.md`);
    const metaPath = path.join(mediaDir, "meta.json");
    const post = {
      ...item,
      blogId,
      date,
    };

    await mkdir(monthDir, { recursive: true });
    await writeFile(mdPath, buildMarkdown({ post, account, body, mediaFolder, copiedImages }), "utf8");
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          sourceRss: rssUrl,
          sourcePost: `https://blog.naver.com/${blogId}/${item.logNo}`,
          imageUrls,
          copiedImages,
          capturedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    written.push(mdPath);
    existingPostIds.add(item.logNo);

    if (postDelayMs) {
      await sleep(postDelayMs);
    }
  }

  console.log(`Naver Blog RSS: ${rssUrl}`);
  if (dateFrom || dateTo) {
    console.log(`Date range: ${args["date-from"] || "beginning"} to ${args["date-to"] || "latest"}`);
  }
  console.log(`Discovered posts: ${rssItems.length}`);
  console.log(`Written Markdown files: ${written.length}`);
  console.log(`Skipped duplicate posts: ${skippedDuplicates}`);
  console.log(`Output folder: ${path.join(outputRoot, "Naver Blog")}`);
  written.forEach((filePath) => console.log(filePath));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
