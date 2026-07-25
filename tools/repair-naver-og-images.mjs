import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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

function readProperty(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"));

  return match?.[1]?.trim() ?? "";
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

function extractOpenGraphImageUrl(html) {
  const text = String(html || "");
  const match =
    text.match(/<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    text.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["'][^>]*>/i);
  const url = decodeHtml(match?.[1] || "");

  if (!/^https?:\/\//i.test(url)) {
    return "";
  }

  if (
    url.includes("ssl.pstatic.net/static") ||
    url.includes("blogpfthumb-phinf.pstatic.net") ||
    url.includes("img_ani_blogid") ||
    url.includes("/favicon")
  ) {
    return "";
  }

  return url;
}

function sourceUrlCandidates(sourceUrl, postId) {
  const urls = [sourceUrl];

  try {
    const parsed = new URL(sourceUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const blogId = pathParts[0];
    const logNo = postId || pathParts[1];

    if (blogId && logNo) {
      urls.unshift(`https://m.blog.naver.com/${blogId}/${logNo}`);
    }
  } catch {
    return urls.filter(Boolean);
  }

  return [...new Set(urls.filter(Boolean))];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: "https://blog.naver.com/",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}`);
  }

  return response.text();
}

async function findOpenGraphImage(sourceUrl, postId) {
  for (const url of sourceUrlCandidates(sourceUrl, postId)) {
    try {
      const html = await fetchText(url);
      const imageUrl = extractOpenGraphImageUrl(html);

      if (imageUrl) {
        return imageUrl;
      }
    } catch {
      continue;
    }
  }

  return "";
}

function extensionFromUrl(url) {
  const parsed = new URL(url);
  const extension = path.extname(parsed.pathname).toLowerCase();

  return extension && extension.length <= 6 ? extension : ".jpg";
}

async function downloadImage(url, targetPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 SNS-Reader/0.1",
      Referer: "https://blog.naver.com/",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, bytes);

  return bytes.length;
}

function replaceImagesSection(markdown, mediaFolder, imageFileName) {
  const replacement = `## Images\n\n![[${mediaFolder}/${imageFileName}]]`;

  if (/\n## Images\s*\r?\n[\s\S]*?\r?\n## Videos\s*\r?\n/i.test(markdown)) {
    return markdown.replace(/\n## Images\s*\r?\n[\s\S]*?\r?\n## Videos\s*\r?\n/i, `\n${replacement}\n\n## Videos\n`);
  }

  return `${markdown.trim()}\n\n${replacement}\n`;
}

function updateMarkdown(markdown, mediaFolder, imageFileName) {
  return replaceImagesSection(
    markdown
      .replace(/^has_images:\s*false\s*$/m, "has_images: true")
      .replace(/^image_count:\s*0\s*$/m, "image_count: 1"),
    mediaFolder,
    imageFileName
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadSettings(env);
  const root = path.resolve(args.root || settings.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);
  const naverRoot = path.join(root, "Naver Blog");
  const limit = args.limit ? Number(args.limit) : 0;
  const delayMs = args["delay-ms"] ? Number(args["delay-ms"]) : 120;
  const files = await walkMarkdownFiles(naverRoot);
  const candidates = files.filter((filePath) => {
    const markdown = readFileSyncSafe(filePath);

    return (
      /^platform:\s*naver-blog/m.test(markdown) &&
      /^image_count:\s*0\s*$/m.test(markdown) &&
      /^source_url:\s*"?https?:\/\/blog\.naver\.com/m.test(markdown)
    );
  });
  const selectedCandidates = limit ? candidates.slice(0, limit) : candidates;
  let checked = 0;
  let repaired = 0;
  let skippedNoOgImage = 0;
  let failed = 0;

  for (const filePath of selectedCandidates) {
    checked += 1;
    const markdown = await readFile(filePath, "utf8");
    const sourceUrl = readProperty(markdown, "source_url");
    const postId = readProperty(markdown, "post_id");
    const mediaFolder = readProperty(markdown, "media_folder");

    if (!sourceUrl || !mediaFolder) {
      skippedNoOgImage += 1;
      continue;
    }

    try {
      const imageUrl = await findOpenGraphImage(sourceUrl, postId);

      if (!imageUrl) {
        skippedNoOgImage += 1;
        continue;
      }

      const extension = extensionFromUrl(imageUrl);
      const imageFileName = `image-001${extension}`;
      const mediaDir = path.resolve(path.dirname(filePath), mediaFolder.replaceAll("/", path.sep));
      const imagePath = path.join(mediaDir, imageFileName);
      const metaPath = path.join(mediaDir, "meta.json");

      await mkdir(mediaDir, { recursive: true });
      const imageBytes = await downloadImage(imageUrl, imagePath);
      await writeFile(filePath, updateMarkdown(markdown, mediaFolder, imageFileName), "utf8");
      await writeFile(
        metaPath,
        JSON.stringify(
          {
            sourcePost: sourceUrl,
            imageUrls: [imageUrl],
            copiedImages: [imageFileName],
            repairSource: "naver-og-image",
            repairedAt: new Date().toISOString(),
            imageBytes,
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      repaired += 1;
      console.log(`Repaired ${path.relative(naverRoot, filePath)} <- ${imageUrl}`);
    } catch (error) {
      failed += 1;
      console.warn(`Failed ${path.relative(naverRoot, filePath)}: ${error.message}`);
    }

    if (delayMs) {
      await sleep(delayMs);
    }
  }

  console.log(`Checked Naver Blog Markdown files: ${checked}`);
  console.log(`Repaired missing images: ${repaired}`);
  console.log(`Skipped without usable og:image: ${skippedNoOgImage}`);
  console.log(`Failed repairs: ${failed}`);
  console.log(`Output folder: ${naverRoot}`);
}

function readFileSyncSafe(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
