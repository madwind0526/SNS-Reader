import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { hasCollapsedFacebookText } from "./facebook-post-text.mjs";

const workspaceRoot = process.cwd();
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".avif"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv"]);

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];

      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
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

async function findLatestFacebookZip() {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const zipFiles = await walkFiles(
    downloadsDir,
    (filePath, name) =>
      path.extname(name).toLowerCase() === ".zip" &&
      /(facebook|meta|information|download|your_.*information|내보내기|정보)/i.test(name)
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

function repairText(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();

  if (!text) {
    return "";
  }

  const looksMojibake = /[ÃÂìíëêîï][\x80-\xBF]|\u00ec|\u00eb|\u00ea|\u00c3/.test(text);
  const hasKorean = /[가-힣]/.test(text);

  if (looksMojibake && !hasKorean) {
    try {
      return Buffer.from(text, "latin1").toString("utf8");
    } catch {
      return text;
    }
  }

  return text;
}

function normalizeDateFromTimestamp(timestamp) {
  const numberValue = Number(timestamp);

  if (!Number.isFinite(numberValue)) {
    return null;
  }

  return new Date(numberValue > 10_000_000_000 ? numberValue : numberValue * 1000);
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
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function escapeYaml(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectPostText(entry) {
  const candidates = [];

  if (Array.isArray(entry.data)) {
    for (const item of entry.data) {
      if (item?.post) candidates.push(item.post);
      if (item?.text) candidates.push(item.text);
      if (item?.comment?.comment) candidates.push(item.comment.comment);
    }
  }

  if (entry.post) candidates.push(entry.post);
  if (entry.message) candidates.push(entry.message);
  if (entry.text) candidates.push(entry.text);
  if (entry.description) candidates.push(entry.description);

  return unique(candidates.map(repairText)).join("\n\n").trim();
}

function collectMediaUris(value, uris = []) {
  if (!value || typeof value !== "object") {
    return uris;
  }

  if (
    typeof value.uri === "string" &&
    (imageExtensions.has(path.extname(value.uri).toLowerCase()) ||
      videoExtensions.has(path.extname(value.uri).toLowerCase()))
  ) {
    uris.push(value.uri);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaUris(item, uris));
  } else {
    Object.values(value).forEach((item) => collectMediaUris(item, uris));
  }

  return unique(uris);
}

function looksLikePost(entry, filePath) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const lowerPath = filePath.toLowerCase();
  const hasTimestamp = entry.timestamp || entry.creation_timestamp || entry.created_timestamp;
  const hasPostText = Boolean(collectPostText(entry));
  const pathSuggestsPost = /post|timeline|activity|게시/.test(lowerPath);

  return Boolean(hasTimestamp && hasPostText && pathSuggestsPost);
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function discoverPosts(extractRoot) {
  const jsonFiles = await walkFiles(extractRoot, (filePath, name) => {
    const lower = filePath.toLowerCase();
    return name.toLowerCase().endsWith(".json") && /(post|timeline|activity|게시)/.test(lower);
  });
  const posts = [];

  for (const jsonPath of jsonFiles) {
    let payload;

    try {
      payload = await readJson(jsonPath);
    } catch {
      continue;
    }

    const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.posts) ? payload.posts : [];

    entries.forEach((entry, index) => {
      if (looksLikePost(entry, jsonPath)) {
        const timestamp = entry.timestamp ?? entry.creation_timestamp ?? entry.created_timestamp;
        const date = normalizeDateFromTimestamp(timestamp) ?? new Date();
        posts.push({
          entry,
          index,
          jsonPath,
          date,
          text: collectPostText(entry),
          mediaUris: collectMediaUris(entry),
        });
      }
    });
  }

  return posts.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function resolveExportPath(extractRoot, relativePath) {
  const normalized = relativePath.replaceAll("/", path.sep).replaceAll("\\", path.sep);
  const direct = path.join(extractRoot, normalized);

  if (existsSync(direct)) {
    return direct;
  }

  return "";
}

async function createVideoPoster(videoPath, posterPath) {
  try {
    await runCommand("ffmpeg", ["-y", "-i", videoPath, "-ss", "00:00:01", "-frames:v", "1", posterPath], {
      silent: true
    });
    return existsSync(posterPath);
  } catch {
    return false;
  }
}

async function copyPostMedia({ extractRoot, mediaUris, mediaDir }) {
  await mkdir(mediaDir, { recursive: true });

  const copiedImages = [];
  const copiedVideos = [];
  let imageIndex = 0;
  let videoIndex = 0;

  for (const uri of mediaUris) {
    const sourcePath = resolveExportPath(extractRoot, uri);

    if (!sourcePath) {
      continue;
    }

    const extension = path.extname(sourcePath).toLowerCase() || ".jpg";

    if (videoExtensions.has(extension)) {
      videoIndex += 1;
      imageIndex += 1;

      const videoName = `video-${String(videoIndex).padStart(3, "0")}${extension}`;
      const posterName = `image-${String(imageIndex).padStart(3, "0")}-video-poster.jpg`;
      const videoPath = path.join(mediaDir, videoName);
      const posterPath = path.join(mediaDir, posterName);

      await copyFile(sourcePath, videoPath);
      copiedVideos.push(videoName);

      if (await createVideoPoster(videoPath, posterPath)) {
        copiedImages.push(posterName);
      }

      continue;
    }

    imageIndex += 1;

    const targetName = `image-${String(imageIndex).padStart(3, "0")}${extension}`;
    const targetPath = path.join(mediaDir, targetName);

    await copyFile(sourcePath, targetPath);
    copiedImages.push(targetName);
  }

  return { copiedImages, copiedVideos };
}

function buildMarkdown({ post, account, mediaFolder, copiedImages, copiedVideos }) {
  if (hasCollapsedFacebookText(post.text)) {
    throw new Error(`Collapsed Facebook body detected in export item ${post.index}. Re-export or repair before writing Markdown.`);
  }

  const parts = formatDateParts(post.date);
  const title = post.text.split(/\n+/).find(Boolean)?.slice(0, 80) || "Untitled Facebook Post";
  const sourceUrl = account?.url || "";
  const postId = `facebook_export_${parts.fileDate}_${post.index}`;

  return [
    "---",
    "type: sns-post",
    "platform: facebook",
    `account: "${escapeYaml(account?.label || "Facebook")}"`,
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
    "  - Facebook",
    "  - SNS",
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    'import_source: "facebook-export"',
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
    post.text || "No post body captured.",
    "",
    "## Images",
    "",
    copiedImages.length
      ? copiedImages.map((fileName) => `![[${mediaFolder}/${fileName}]]`).join("\n")
      : "No images captured.",
    "",
    "## Videos",
    "",
    copiedVideos.length
      ? copiedVideos.map((fileName) => `![[${mediaFolder}/${fileName}]]`).join("\n")
      : "No videos captured.",
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
    sourceUrl ? `[Facebook profile](${sourceUrl})` : "Facebook export archive",
    "",
  ].join("\n");
}

function isOneLineBirthdayGreeting(text) {
  const normalized = String(text || "").trim();
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  return lines.length === 1 && /(생일|birthday)/i.test(normalized) && /(축하|생축|happy birthday)/i.test(normalized);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const account = (settings?.accounts ?? []).find(
    (item) => item.platform === "facebook" && item.exportToObsidian !== false
  );
  const discoveredZipPath = args.zip || (await findLatestFacebookZip());

  if (!discoveredZipPath) {
    console.log("No Facebook/Meta export zip was found in Downloads.");
    console.log("Facebook export may still be preparing. Check Accounts Center current activity.");
    return;
  }

  const zipPath = path.resolve(discoveredZipPath);

  if (!existsSync(zipPath)) {
    console.log(`Facebook/Meta export zip was not found: ${zipPath}`);
    return;
  }

  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || "./data/sample-md");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sns-reader-facebook-export-"));

  try {
    await extractZip(zipPath, tempRoot);

    const posts = await discoverPosts(tempRoot);
    const written = [];

    for (const post of posts) {
      if (isOneLineBirthdayGreeting(post.text)) {
        console.log(`Skipping one-line birthday greeting: ${formatDateParts(post.date).date} ${post.text.slice(0, 80)}`);
        continue;
      }

      const parts = formatDateParts(post.date);
      const sequence = String(written.length + 1).padStart(5, "0");
      const stem = `${parts.fileDate}_facebook_${sequence}_${slugify(post.text.slice(0, 36)) || post.index}`;
      const monthDir = path.join(outputRoot, "facebook", parts.month);
      const mediaFolder = `assets/${stem}`;
      const mediaDir = path.join(monthDir, "assets", stem);
      const { copiedImages, copiedVideos } = await copyPostMedia({ extractRoot: tempRoot, mediaUris: post.mediaUris, mediaDir });
      const markdown = buildMarkdown({ post, account, mediaFolder, copiedImages, copiedVideos });
      const mdPath = path.join(monthDir, `${stem}.md`);
      const metaPath = path.join(mediaDir, "meta.json");

      await mkdir(monthDir, { recursive: true });
      await writeFile(mdPath, markdown, "utf8");
      await writeFile(
        metaPath,
        JSON.stringify(
          {
            sourceArchive: zipPath,
            sourceJson: path.relative(tempRoot, post.jsonPath),
            sourceIndex: post.index,
            mediaUris: post.mediaUris,
            copiedImages,
            copiedVideos,
            capturedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      written.push(mdPath);
    }

    console.log(`Facebook export archive: ${zipPath}`);
    console.log(`Discovered posts: ${posts.length}`);
    console.log(`Written Markdown files: ${written.length}`);
    console.log(`Output folder: ${path.join(outputRoot, "facebook")}`);
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
