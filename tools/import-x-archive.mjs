import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm"]);

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

async function findLatestXZip() {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const zipFiles = await walkFiles(
    downloadsDir,
    (filePath, name) => path.extname(name).toLowerCase() === ".zip" && /(twitter|x-archive)/i.test(name)
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

function readYtdPayload(raw, key) {
  const json = String(raw)
    .replace(new RegExp(`^window\\.YTD\\.${key}\\.part\\d+\\s*=\\s*`), "")
    .replace(/;\s*$/, "")
    .trim();

  return JSON.parse(json);
}

async function readYtdParts(extractRoot, key) {
  const dataDir = path.join(extractRoot, "data");
  const files = await readdir(dataDir).catch(() => []);
  const pattern = new RegExp(`^${key}(?:-part\\d+)?\\.js$`, "i");
  const partFiles = files.filter((fileName) => pattern.test(fileName) || fileName.toLowerCase() === `${key}.js`);
  const entries = [];

  for (const fileName of partFiles.sort()) {
    const payload = readYtdPayload(await readFile(path.join(dataDir, fileName), "utf8"), key.replace(/-part.*$/i, ""));
    entries.push(...(Array.isArray(payload) ? payload : []));
  }

  return entries;
}

function parseTwitterDate(value) {
  const date = new Date(String(value || ""));

  if (!Number.isNaN(date.getTime())) {
    return date;
  }

  return null;
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

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function collectUrls(tweet) {
  const urls = [];

  for (const url of tweet.entities?.urls ?? []) {
    if (url.expanded_url) {
      urls.push({ short: url.url, expanded: url.expanded_url });
    }
  }

  for (const media of tweet.entities?.media ?? []) {
    if (media.expanded_url) {
      urls.push({ short: media.url, expanded: media.expanded_url });
    }
  }

  return urls;
}

function expandTweetText(tweet) {
  let text = String(tweet.full_text || tweet.text || "").replace(/\r\n/g, "\n").trim();

  for (const { short, expanded } of collectUrls(tweet)) {
    if (short && expanded) {
      text = text.replaceAll(short, expanded);
    }
  }

  return text;
}

function isReply(tweet) {
  return Boolean(tweet.in_reply_to_status_id_str || tweet.in_reply_to_user_id_str || tweet.in_reply_to_screen_name);
}

function isRetweet(tweet) {
  return Boolean(tweet.retweeted || /^RT @/.test(tweet.full_text || ""));
}

function mediaFileCandidates(tweet, media) {
  const candidates = [];
  const tweetId = String(tweet.id_str || tweet.id || "");
  const mediaUrl = String(media.media_url_https || media.media_url || "");
  const mediaName = mediaUrl ? path.basename(new URL(mediaUrl).pathname) : "";

  if (tweetId && mediaName) {
    candidates.push(path.join("data", "tweets_media", `${tweetId}-${mediaName}`));
  }

  if (mediaName) {
    candidates.push(path.join("data", "tweets_media", mediaName));
  }

  return candidates;
}

async function copyTweetMedia({ extractRoot, tweet, mediaDir }) {
  await mkdir(mediaDir, { recursive: true });

  const copiedImages = [];
  const copiedVideos = [];
  const mediaItems = [...(tweet.extended_entities?.media ?? []), ...(tweet.entities?.media ?? [])];
  const seen = new Set();
  let imageIndex = 0;
  let videoIndex = 0;

  for (const media of mediaItems) {
    const type = String(media.type || "").toLowerCase();

    for (const candidate of mediaFileCandidates(tweet, media)) {
      const sourcePath = path.join(extractRoot, candidate);
      const key = sourcePath.toLowerCase();

      if (seen.has(key) || !existsSync(sourcePath)) {
        continue;
      }

      seen.add(key);

      const extension = path.extname(sourcePath).toLowerCase();

      if (type.includes("video") || videoExtensions.has(extension)) {
        videoIndex += 1;

        const targetName = `video-${String(videoIndex).padStart(3, "0")}${extension || ".mp4"}`;
        await copyFile(sourcePath, path.join(mediaDir, targetName));
        copiedVideos.push(targetName);
      } else if (imageExtensions.has(extension)) {
        imageIndex += 1;

        const targetName = `image-${String(imageIndex).padStart(3, "0")}${extension}`;
        await copyFile(sourcePath, path.join(mediaDir, targetName));
        copiedImages.push(targetName);
      }
    }
  }

  return { copiedImages, copiedVideos };
}

function buildMarkdown({ tweet, account, text, mediaFolder, copiedImages, copiedVideos }) {
  const date = parseTwitterDate(tweet.created_at) ?? new Date();
  const parts = formatDateParts(date);
  const title = text.split(/\n+/).find(Boolean)?.slice(0, 80) || "Untitled X Post";
  const username = account?.username || account?.accountDisplayName || account?.label || "madwind99";
  const sourceUrl = tweet.id_str ? `https://x.com/${username}/status/${tweet.id_str}` : account?.url || `https://x.com/${username}`;
  const hashtags = (tweet.entities?.hashtags ?? []).map((tag) => tag.text).filter(Boolean);

  return [
    "---",
    "type: sns-post",
    "platform: x",
    `account: "${escapeYaml(account?.label || account?.accountDisplayName || username || "X")}"`,
    `account_url: "${escapeYaml(account?.url || `https://x.com/${username}`)}"`,
    `source_url: "${escapeYaml(sourceUrl)}"`,
    `post_id: "x_export_${escapeYaml(tweet.id_str || tweet.id || `${parts.fileDate}_${slugify(text)}`)}"`,
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
    `is_reply: ${isReply(tweet)}`,
    `is_retweet: ${isRetweet(tweet)}`,
    `favorite_count: ${Number(tweet.favorite_count || 0) || 0}`,
    `retweet_count: ${Number(tweet.retweet_count || 0) || 0}`,
    "tags:",
    "  - X",
    "  - SNS",
    ...hashtags.map((tag) => `  - "${escapeYaml(tag)}"`),
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    'import_source: "x-archive"',
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
    text || "No post body captured.",
    "",
    "## Images",
    "",
    copiedImages.length ? copiedImages.map((fileName) => `![[${mediaFolder}/${fileName}]]`).join("\n") : "No images captured.",
    "",
    "## Videos",
    "",
    copiedVideos.length ? copiedVideos.map((fileName) => `![[${mediaFolder}/${fileName}]]`).join("\n") : "No videos captured.",
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
    `[X post](${sourceUrl})`,
    "",
  ].join("\n");
}

function accountFromSettings(settings, archiveAccount) {
  const configured = (settings?.accounts ?? []).find((item) => item.platform === "x");
  const archive = archiveAccount?.account ?? {};
  const username = archive.username || configured?.url?.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i)?.[1] || "madwind99";

  return {
    label: configured?.label || archive.accountDisplayName || "X",
    url: configured?.url || `https://x.com/${username}`,
    username,
    accountDisplayName: archive.accountDisplayName,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const discoveredZipPath = args.zip || (await findLatestXZip());

  if (!discoveredZipPath) {
    console.log("No X/Twitter export zip was found in Downloads.");
    return;
  }

  const zipPath = path.resolve(discoveredZipPath);

  if (!existsSync(zipPath)) {
    console.log(`X archive zip was not found: ${zipPath}`);
    return;
  }

  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || "./data/sample-md");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sns-reader-x-archive-"));

  try {
    await extractZip(zipPath, tempRoot);

    const accountEntries = await readYtdParts(tempRoot, "account").catch(() => []);
    const account = accountFromSettings(settings, accountEntries[0]);
    const tweetEntries = await readYtdParts(tempRoot, "tweets");
    const includeReplies = Boolean(args["include-replies"]);
    const includeRetweets = Boolean(args["include-retweets"]);
    const tweets = tweetEntries
      .map((entry) => entry.tweet ?? entry)
      .filter((tweet) => tweet?.created_at && expandTweetText(tweet))
      .filter((tweet) => includeReplies || !isReply(tweet))
      .filter((tweet) => includeRetweets || !isRetweet(tweet))
      .sort((left, right) => (parseTwitterDate(left.created_at)?.getTime() ?? 0) - (parseTwitterDate(right.created_at)?.getTime() ?? 0));
    const written = [];

    for (const tweet of tweets) {
      const date = parseTwitterDate(tweet.created_at) ?? new Date();
      const parts = formatDateParts(date);
      const text = expandTweetText(tweet);
      const stem = `${parts.fileDate}_x_${tweet.id_str || tweet.id || String(written.length + 1).padStart(5, "0")}_${slugify(text.slice(0, 36))}`;
      const monthDir = path.join(outputRoot, "X", parts.month);
      const mediaFolder = `assets/${stem}`;
      const mediaDir = path.join(monthDir, "assets", stem);
      const { copiedImages, copiedVideos } = await copyTweetMedia({ extractRoot: tempRoot, tweet, mediaDir });
      const markdown = buildMarkdown({ tweet, account, text, mediaFolder, copiedImages, copiedVideos });
      const mdPath = path.join(monthDir, `${stem}.md`);

      await mkdir(monthDir, { recursive: true });
      await writeFile(mdPath, markdown, "utf8");
      await writeFile(
        path.join(mediaDir, "meta.json"),
        JSON.stringify(
          {
            sourceArchive: zipPath,
            tweetId: tweet.id_str || tweet.id || "",
            sourceCreatedAt: tweet.created_at,
            source: stripHtml(tweet.source),
            includeReplies,
            includeRetweets,
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

    console.log(`X archive: ${zipPath}`);
    console.log(`Raw tweets: ${tweetEntries.length}`);
    console.log(`Imported tweets: ${written.length}`);
    console.log(`Replies included: ${includeReplies}`);
    console.log(`Retweets included: ${includeRetweets}`);
    console.log(`Output folder: ${path.join(outputRoot, "X")}`);
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
