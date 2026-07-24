import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".avif"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv"]);

const platformConfigs = {
  instagram: {
    zipPattern: /instagram/i,
    accountMatch: (account) => account.platform === "instagram",
    defaultLabel: "Instagram",
    jsonPaths: ["your_instagram_activity/media/posts_1.json", "your_instagram_activity/media/posts.json", "your_instagram_activity/media/reels.json"],
    outputFolder: "instagram",
    importSource: "instagram-export",
  },
  threads: {
    zipPattern: /threads/i,
    accountMatch: (account) => account.label?.toLowerCase() === "threads" || /threads\./i.test(account.url || ""),
    defaultLabel: "Threads",
    jsonPaths: ["threads/threads_and_replies.json"],
    outputFolder: "Threads",
    importSource: "threads-export",
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

async function findLatestZip(platform) {
  const config = platformConfigs[platform];
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const zipFiles = await walkFiles(
    downloadsDir,
    (filePath, name) => path.extname(name).toLowerCase() === ".zip" && config.zipPattern.test(name)
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

  const looksMojibake = /[\u00c0-\u00ff]{2,}|[\u00ec\u00eb\u00ea][\u0080-\u00bf]/.test(text);
  const hasKorean = /[\uac00-\ud7af]/.test(text);

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

function collectMediaUris(value, uris = []) {
  if (!value || typeof value !== "object") {
    return uris;
  }

  if (typeof value.uri === "string" && value.uri.trim()) {
    uris.push(value.uri.trim());
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      nested.forEach((item) => collectMediaUris(item, uris));
    } else if (nested && typeof nested === "object") {
      collectMediaUris(nested, uris);
    }
  }

  return uris;
}

function collectText(value, texts = []) {
  if (!value || typeof value !== "object") {
    return texts;
  }

  for (const key of ["title", "text", "caption", "description", "message"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      texts.push(repairText(value[key]));
    }
  }

  if (Array.isArray(value.media)) {
    for (const item of value.media) {
      collectText(item, texts);
    }
  }

  return texts;
}

function getEntryTimestamp(entry) {
  const timestamps = [];

  if (entry.creation_timestamp) timestamps.push(entry.creation_timestamp);
  if (entry.timestamp) timestamps.push(entry.timestamp);

  for (const media of Array.isArray(entry.media) ? entry.media : []) {
    if (media.creation_timestamp) timestamps.push(media.creation_timestamp);
    if (media.timestamp) timestamps.push(media.timestamp);
  }

  return timestamps.find((timestamp) => Number.isFinite(Number(timestamp)));
}

async function readJsonIfExists(extractRoot, relativePath) {
  const filePath = path.join(extractRoot, relativePath.replaceAll("/", path.sep));

  if (!existsSync(filePath)) {
    return null;
  }

  return {
    filePath,
    payload: JSON.parse(await readFile(filePath, "utf8")),
  };
}

function getPayloadEntries(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const value of Object.values(payload ?? {})) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function extractHandleFromUrl(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/@([A-Za-z0-9._-]+)/) || text.match(/(?:facebook\.com|instagram\.com|threads\.(?:net|com))\/([^/?#]+)/i);

  return match?.[1]?.replace(/^@/, "").toLowerCase() ?? "";
}

function getThreadsPostInfo(entry) {
  const mediaItems = Array.isArray(entry?.media) ? entry.media : [];

  for (const item of mediaItems) {
    if (item?.text_app_post) {
      return item.text_app_post;
    }
  }

  return {};
}

function getThreadsReplyTarget(entry) {
  return String(getThreadsPostInfo(entry).in_reply_to_username ?? "").replace(/^@/, "").toLowerCase();
}

function mergeThreadsContinuations(posts, account) {
  const continuationWindowMs = 30 * 60 * 1000;
  const accountHandle = extractHandleFromUrl(account?.url);
  const parents = posts
    .filter((post) => !post.isReply)
    .map((post) => ({
      ...post,
      continuations: [],
    }));
  for (const reply of posts.filter((post) => post.isReply)) {
    const parent = parents
      .filter((candidate) => {
        const diff = reply.date.getTime() - candidate.date.getTime();
        const replyTargetMatchesAccount = !reply.replyTarget || !accountHandle || reply.replyTarget === accountHandle;

        return replyTargetMatchesAccount && diff >= 0 && diff <= continuationWindowMs;
      })
      .sort((left, right) => {
        const leftDiff = reply.date.getTime() - left.date.getTime();
        const rightDiff = reply.date.getTime() - right.date.getTime();

        return leftDiff - rightDiff;
      })[0];

    if (!parent) {
      continue;
    }

    parent.continuations.push(reply);
  }

  return parents.map((parent) => {
    const continuationTexts = parent.continuations
      .sort((left, right) => left.date.getTime() - right.date.getTime())
      .map((reply) => reply.text);
    const textParts = unique([parent.text, ...continuationTexts]);

    return {
      ...parent,
      text: textParts.join("\n\n").trim(),
      mediaUris: unique([...parent.mediaUris, ...parent.continuations.flatMap((reply) => reply.mediaUris)]),
      continuationCount: parent.continuations.length,
      continuationIndexes: parent.continuations.map((reply) => reply.index),
      continuationTargets: unique(parent.continuations.map((reply) => reply.replyTarget)),
    };
  });
}

async function discoverPosts(extractRoot, platform, options = {}) {
  const config = platformConfigs[platform];
  const posts = [];
  const seen = new Set();

  for (const relativePath of config.jsonPaths) {
    const loaded = await readJsonIfExists(extractRoot, relativePath);

    if (!loaded) {
      continue;
    }

    const entries = getPayloadEntries(loaded.payload);

    entries.forEach((entry, index) => {
      const timestamp = getEntryTimestamp(entry);
      const date = normalizeDateFromTimestamp(timestamp);
      const text = unique(collectText(entry)).join("\n\n").trim();
      const mediaUris = unique(collectMediaUris(entry));
      const postInfo = getThreadsPostInfo(entry);
      const isReply = Boolean(postInfo.is_reply);

      if (!date || !text) {
        return;
      }

      const dedupeKey = JSON.stringify([timestamp, text, mediaUris]);

      if (seen.has(dedupeKey)) {
        return;
      }

      seen.add(dedupeKey);

      posts.push({
        entry,
        index,
        jsonPath: loaded.filePath,
        date,
        text,
        mediaUris,
        isReply,
        replyTarget: getThreadsReplyTarget(entry),
        continuationCount: 0,
        continuationIndexes: [],
        continuationTargets: [],
      });
    });
  }

  const sortedPosts = posts.sort((a, b) => a.date.getTime() - b.date.getTime());

  if (platform === "threads" && !options.includeReplies) {
    return mergeThreadsContinuations(sortedPosts, options.account).sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  return sortedPosts;
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
      silent: true,
    });
    return existsSync(posterPath);
  } catch {
    return false;
  }
}

async function detectMediaKind(sourcePath, fallbackExtension) {
  const header = await readFile(sourcePath).then((buffer) => buffer.subarray(0, 32)).catch(() => Buffer.alloc(0));
  const headerText = header.toString("latin1");

  if (header[0] === 0xff && header[1] === 0xd8) {
    return { kind: "image", extension: ".jpg" };
  }

  if (header[0] === 0x89 && header.toString("ascii", 1, 4) === "PNG") {
    return { kind: "image", extension: ".png" };
  }

  if (headerText.startsWith("GIF8")) {
    return { kind: "image", extension: ".gif" };
  }

  if (headerText.includes("ftyp")) {
    return { kind: "video", extension: ".mp4" };
  }

  if (videoExtensions.has(fallbackExtension)) {
    return { kind: "video", extension: fallbackExtension };
  }

  if (imageExtensions.has(fallbackExtension)) {
    return { kind: "image", extension: fallbackExtension };
  }

  return { kind: "unknown", extension: fallbackExtension || "" };
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

    const fallbackExtension = path.extname(sourcePath).toLowerCase();
    const { kind, extension } = await detectMediaKind(sourcePath, fallbackExtension);

    if (kind === "video") {
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

    if (kind !== "image") {
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

function buildMarkdown({ post, platform, account, mediaFolder, copiedImages, copiedVideos }) {
  const config = platformConfigs[platform];
  const parts = formatDateParts(post.date);
  const title = post.text.split(/\n+/).find(Boolean)?.slice(0, 80) || `Untitled ${config.defaultLabel} Post`;
  const sourceUrl = account?.url || "";
  const postId = `${platform}_export_${parts.fileDate}_${post.index}`;

  return [
    "---",
    "type: sns-post",
    `platform: ${platform}`,
    `account: "${escapeYaml(account?.label || config.defaultLabel)}"`,
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
    `is_reply: ${post.isReply}`,
    post.replyTarget ? `reply_target: "${escapeYaml(post.replyTarget)}"` : "reply_target: \"\"",
    `continuation_count: ${post.continuationCount ?? 0}`,
    "continuation_targets:",
    ...((post.continuationTargets ?? []).length
      ? post.continuationTargets.map((target) => `  - ${escapeYaml(target)}`)
      : ["  - none"]),
    "tags:",
    `  - ${config.defaultLabel.replace(/\s+/g, "")}`,
    "  - SNS",
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    `import_source: "${config.importSource}"`,
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
    sourceUrl ? `[${config.defaultLabel} profile](${sourceUrl})` : `${config.defaultLabel} export archive`,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = String(args.platform || "").toLowerCase();
  const config = platformConfigs[platform];

  if (!config) {
    throw new Error("Use --platform instagram or --platform threads.");
  }

  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const account = (settings?.accounts ?? []).find(config.accountMatch);
  const discoveredZipPath = args.zip || (await findLatestZip(platform));

  if (!discoveredZipPath) {
    console.log(`No ${config.defaultLabel} export zip was found in Downloads.`);
    return;
  }

  const zipPath = path.resolve(discoveredZipPath);

  if (!existsSync(zipPath)) {
    console.log(`${config.defaultLabel} export zip was not found: ${zipPath}`);
    return;
  }

  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || "./data/sample-md");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `sns-reader-${platform}-export-`));

  try {
    await extractZip(zipPath, tempRoot);

    const posts = await discoverPosts(tempRoot, platform, {
      includeReplies: Boolean(args["include-replies"]),
      account,
    });
    const written = [];

    for (const post of posts) {
      const parts = formatDateParts(post.date);
      const sequence = String(written.length + 1).padStart(5, "0");
      const stem = `${parts.fileDate}_${platform}_${sequence}_${slugify(post.text.slice(0, 36)) || post.index}`;
      const monthDir = path.join(outputRoot, config.outputFolder, parts.month);
      const mediaFolder = `assets/${stem}`;
      const mediaDir = path.join(monthDir, "assets", stem);
      const { copiedImages, copiedVideos } = await copyPostMedia({ extractRoot: tempRoot, mediaUris: post.mediaUris, mediaDir });
      const markdown = buildMarkdown({ post, platform, account, mediaFolder, copiedImages, copiedVideos });
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
            continuationIndexes: post.continuationIndexes ?? [],
            continuationTargets: post.continuationTargets ?? [],
            replyTarget: post.replyTarget ?? "",
            mediaUris: post.mediaUris,
            copiedImages,
            copiedVideos,
            isReply: post.isReply,
            capturedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      written.push(mdPath);
    }

    console.log(`${config.defaultLabel} export archive: ${zipPath}`);
    if (platform === "threads" && !args["include-replies"]) {
      console.log("Threads continuation replies were merged into their parent posts. Use --include-replies to import replies as standalone Markdown files.");
    }
    console.log(`Discovered posts: ${posts.length}`);
    console.log(`Written Markdown files: ${written.length}`);
    console.log(`Output folder: ${path.join(outputRoot, config.outputFolder)}`);
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
