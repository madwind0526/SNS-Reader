import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".avif"]);

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
  const settingsPath = path.resolve(workspaceRoot, env.SNS_READER_SETTINGS_FILE || "./data/runtime/app-settings.json");

  return readFile(settingsPath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

async function walkFiles(root, predicate = () => true, files = []) {
  if (!existsSync(root)) {
    return files;
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      await walkFiles(fullPath, predicate, files);
    } else if (predicate(fullPath, entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function findLatestTakeoutZip() {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const zipFiles = await walkFiles(
    downloadsDir,
    (filePath, name) => path.extname(name).toLowerCase() === ".zip" && /takeout/i.test(name)
  );
  const candidates = [];

  for (const filePath of zipFiles) {
    const fileStat = await stat(filePath);
    candidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath ?? "";
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.silent ? "ignore" : "inherit", windowsHide: true });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function extractZip(zipPath, targetDir) {
  const psCommand = [
    "$ErrorActionPreference='Stop';",
    "Expand-Archive",
    "-LiteralPath",
    `'${zipPath.replace(/'/g, "''")}'`,
    "-DestinationPath",
    `'${targetDir.replace(/'/g, "''")}'`,
    "-Force",
  ].join(" ");

  await runCommand("powershell.exe", ["-NoProfile", "-Command", psCommand]);
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((item) => item.some((fieldValue) => fieldValue.trim()));
}

function rowsToObjects(rows) {
  const [headers = [], ...dataRows] = rows;

  return dataRows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header.replace(/^\ufeff/, ""), row[index] ?? ""]))
  );
}

function parseYoutubeText(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return { body: "", links: [] };
  }

  try {
    const payload = JSON.parse(`[${text}]`);
    const bodyParts = [];
    const links = [];

    for (const item of payload) {
      if (typeof item?.text === "string") {
        bodyParts.push(item.text);
      }

      if (typeof item?.link?.linkUrl === "string") {
        links.push(item.link.linkUrl);
      }
    }

    return {
      body: bodyParts.join("").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim(),
      links: [...new Set(links)],
    };
  } catch {
    return {
      body: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      links: [],
    };
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

function findCsvPath(files, expectedName) {
  return files.find((filePath) => path.basename(filePath) === expectedName) ?? "";
}

function buildMediaIndex(files) {
  const index = new Map();

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();

    if (!imageExtensions.has(extension)) {
      continue;
    }

    const stem = path.basename(filePath, extension);
    index.set(stem, filePath);
  }

  return index;
}

function collectImageNames(row) {
  return Object.entries(row)
    .filter(([key, value]) => /^이미지 \d+ 이름$/.test(key) && value.trim())
    .map(([, value]) => value.trim());
}

async function copyImages({ imageNames, mediaIndex, mediaDir }) {
  await mkdir(mediaDir, { recursive: true });

  const copiedImages = [];
  let imageIndex = 0;

  for (const imageName of imageNames) {
    const sourcePath = mediaIndex.get(imageName);

    if (!sourcePath) {
      continue;
    }

    const extension = path.extname(sourcePath).toLowerCase() || ".jpg";
    imageIndex += 1;

    const targetName = `image-${String(imageIndex).padStart(3, "0")}${extension}`;
    const targetPath = path.join(mediaDir, targetName);

    await copyFile(sourcePath, targetPath);
    copiedImages.push(targetName);
  }

  return copiedImages;
}

function buildMarkdown({ post, account, mediaFolder, copiedImages }) {
  const parts = formatDateParts(post.date);
  const title = post.title || "Untitled YouTube Post";
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
    `title: "${escapeYaml(title)}"`,
    `post_type: "${escapeYaml(post.type)}"`,
    `has_images: ${copiedImages.length > 0}`,
    `image_count: ${copiedImages.length}`,
    "has_comments: false",
    "comment_count: 0",
    "has_summary: false",
    "tags:",
    "  - YouTube",
    "  - SNS",
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    "import_source: \"youtube-takeout\"",
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
    "No comments mapped from this export yet.",
    "",
    "## Summary",
    "",
    "Summary will be generated after the LLM summarizer is connected.",
    "",
    "## Source",
    "",
    `[YouTube post](${sourceUrl})`,
    ...(post.links.length ? ["", ...post.links.map((link) => `- ${link}`)] : []),
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const account = (settings?.accounts ?? []).find((item) => item.platform === "youtube");
  const discoveredZipPath = args.zip || (await findLatestTakeoutZip());

  if (!discoveredZipPath) {
    console.log("No YouTube Takeout zip was found in Downloads.");
    return;
  }

  const zipPath = path.resolve(discoveredZipPath);

  if (!existsSync(zipPath)) {
    console.log(`YouTube Takeout zip was not found: ${zipPath}`);
    return;
  }

  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || "./data/sample-md");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sns-reader-youtube-takeout-"));

  try {
    await extractZip(zipPath, tempRoot);

    const files = await walkFiles(tempRoot);
    const postsCsvPath = findCsvPath(files, "게시물.csv");

    if (!postsCsvPath) {
      throw new Error("YouTube community posts CSV was not found in the Takeout archive.");
    }

    const mediaIndex = buildMediaIndex(files);
    const postsText = await readFile(postsCsvPath, "utf8");
    const rows = rowsToObjects(parseCsv(postsText));
    const posts = rows
      .map((row, index) => {
        const id = row["게시물 ID"]?.trim();
        const date = new Date(row["게시물 게시 타임스탬프"] || row["게시물 생성 타임스탬프"] || row["게시물 업데이트 타임스탬프"]);
        const parsedText = parseYoutubeText(row["게시물 텍스트"]);
        const title = parsedText.body.split(/\n+/).find(Boolean)?.slice(0, 80) || `YouTube post ${id}`;

        return {
          id,
          index,
          date,
          type: row["게시물 유형"] || "",
          body: parsedText.body,
          links: parsedText.links,
          title,
          imageNames: collectImageNames(row),
        };
      })
      .filter((post) => post.id && Number.isFinite(post.date.getTime()) && (post.body || post.imageNames.length));
    const written = [];

    for (const post of posts.sort((left, right) => left.date.getTime() - right.date.getTime())) {
      const parts = formatDateParts(post.date);
      const sequence = String(written.length + 1).padStart(5, "0");
      const stem = `${parts.fileDate}_youtube_${sequence}_${slugify(post.title) || post.index}`;
      const monthDir = path.join(outputRoot, "YouTube", parts.month);
      const mediaFolder = `assets/${stem}`;
      const mediaDir = path.join(monthDir, "assets", stem);
      const copiedImages = await copyImages({ imageNames: post.imageNames, mediaIndex, mediaDir });
      const markdown = buildMarkdown({ post, account, mediaFolder, copiedImages });
      const mdPath = path.join(monthDir, `${stem}.md`);
      const metaPath = path.join(mediaDir, "meta.json");

      await mkdir(monthDir, { recursive: true });
      await writeFile(mdPath, markdown, "utf8");
      await writeFile(
        metaPath,
        JSON.stringify(
          {
            sourceArchive: zipPath,
            sourceCsv: path.relative(tempRoot, postsCsvPath),
            sourceIndex: post.index,
            imageNames: post.imageNames,
            copiedImages,
            capturedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      written.push(mdPath);
    }

    console.log(`YouTube Takeout archive: ${zipPath}`);
    console.log(`Discovered posts: ${posts.length}`);
    console.log(`Written Markdown files: ${written.length}`);
    console.log(`Output folder: ${path.join(outputRoot, "YouTube")}`);
    written.slice(0, 5).forEach((filePath) => console.log(filePath));
  } finally {
    if (!args["keep-temp"]) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`Kept extracted files at: ${tempRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
