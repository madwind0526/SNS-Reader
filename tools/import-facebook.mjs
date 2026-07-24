import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { hasCollapsedFacebookText } from "./facebook-post-text.mjs";

const workspaceRoot = process.cwd();

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

function getFacebookAccounts(settings) {
  return (settings?.accounts ?? []).filter(
    (account) => account.platform === "facebook" && account.exportToObsidian !== false && account.url
  );
}

function extractFacebookPageId({ pageId, pageUrl }) {
  if (pageId) {
    return pageId;
  }

  if (!pageUrl) {
    return "";
  }

  try {
    const url = new URL(pageUrl);
    const parts = url.pathname.split("/").filter(Boolean);

    return parts[0] ?? "";
  } catch {
    return pageUrl.replace(/^https?:\/\/(www\.)?facebook\.com\//, "").split("/")[0] ?? "";
  }
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();

  if (Number.isNaN(date.getTime())) {
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

function slugPostId(id) {
  return String(id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "-").slice(-36);
}

function escapeYaml(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toMarkdown({ post, account, mediaFolder }) {
  if (hasCollapsedFacebookText(post.message)) {
    throw new Error(`Collapsed Facebook body detected in Graph API post ${post.id}. Repair before writing Markdown.`);
  }

  const date = normalizeDate(post.created_time);
  const parts = formatDateParts(date);
  const title = post.message?.split(/\r?\n/).find(Boolean)?.slice(0, 80) ?? "";
  const comments = post.comments?.data ?? [];
  const attachments = post.attachments?.data ?? [];
  const attachmentUrls = attachments
    .flatMap((attachment) => [attachment.media?.image?.src, attachment.url])
    .filter(Boolean);

  return [
    "---",
    "type: sns-post",
    "platform: facebook",
    `account: "${escapeYaml(account?.label || "Facebook")}"`,
    `account_url: "${escapeYaml(account?.url || "")}"`,
    `source_url: "${escapeYaml(post.permalink_url ?? "")}"`,
    `post_id: "${escapeYaml(post.id ?? "")}"`,
    `created: "${parts.dateTime}"`,
    `date: "${parts.date}"`,
    `year: ${parts.date.slice(0, 4)}`,
    `month: "${parts.month}"`,
    `title: "${escapeYaml(title)}"`,
    `has_images: ${attachmentUrls.length > 0}`,
    `image_count: ${attachmentUrls.length}`,
    `has_comments: ${comments.length > 0}`,
    `comment_count: ${comments.length}`,
    "has_summary: false",
    "tags:",
    "  - Facebook",
    "  - SNS",
    `media_folder: "${escapeYaml(mediaFolder)}"`,
    `imported_at: "${new Date().toISOString()}"`,
    'import_source: "facebook-graph-api"',
    "---",
    "",
    `# ${title || "Untitled Post"}`,
    "",
    "## Date",
    "",
    parts.dateTime,
    "",
    "## Body",
    "",
    post.message || "No post body captured.",
    "",
    "## Images",
    "",
    attachmentUrls.length > 0
      ? attachmentUrls.map((url, index) => `![Image ${index + 1}](${url})`).join("\n")
      : "No images captured.",
    "",
    "## Videos",
    "",
    "No videos captured.",
    "",
    "## Comments",
    "",
    comments.length > 0
      ? comments.map((comment) => `- ${comment.from?.name ?? "Unknown"}: ${comment.message ?? ""}`).join("\n")
      : "No comments captured.",
    "",
    "## Summary",
    "",
    "Summary will be generated after the LLM summarizer is connected.",
    "",
    "## Source",
    "",
    post.permalink_url ? `[Facebook post](${post.permalink_url})` : "No source URL captured.",
    "",
  ].join("\n");
}

async function fetchFacebookPosts({ pageId, accessToken, limit, since }) {
  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "attachments{media,url,type,title,description}",
    "comments.limit(50){from,message,created_time}",
  ].join(",");
  const url = new URL(`https://graph.facebook.com/v25.0/${encodeURIComponent(pageId)}/posts`);

  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", accessToken);

  if (since) {
    url.searchParams.set("since", since);
  }

  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    const message = payload?.error?.message ?? `Facebook Graph API request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload.data ?? [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const facebookAccounts = getFacebookAccounts(settings);
  const selectedAccount = facebookAccounts[0];
  const authMode = env.FACEBOOK_AUTH_MODE || "graph-api";
  const pageUrl = selectedAccount?.url ?? "";
  const pageId = extractFacebookPageId({ pageId: args["page-id"] || env.FACEBOOK_PAGE_ID, pageUrl });
  const accessToken = args["access-token"] || env.FACEBOOK_ACCESS_TOKEN;
  const since = args.since || "";
  const limit = Math.max(1, Math.min(Number(args.limit || env.FACEBOOK_IMPORT_LIMIT || 20), 100));
  const outputRoot = path.resolve(args.out || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || "./data/sample-md");

  if (authMode === "browser-session") {
    console.error("Facebook browser-session import is the preferred login-based path, but it is not implemented yet.");
    console.error("Next implementation step: open or attach to the configured browser session, read visible posts, and export them to Markdown.");
    if (selectedAccount) {
      console.error(`Settings Facebook account: ${selectedAccount.label || selectedAccount.url} <${selectedAccount.url}>`);
    } else {
      console.error("No enabled Facebook account was found in the app settings file. Open Settings, add/check Facebook, then press Save.");
    }
    console.error("Configured session keys: SNS_BROWSER, SNS_BROWSER_PROFILE, SNS_BROWSER_USER_DATA_DIR.");
    process.exitCode = 1;
    return;
  }

  if (authMode !== "graph-api") {
    console.error(`Unsupported FACEBOOK_AUTH_MODE: ${authMode}`);
    console.error("Supported now: graph-api. Planned: browser-session.");
    process.exitCode = 1;
    return;
  }

  if (!pageId || !accessToken) {
    console.error("Facebook import is not configured.");
    console.error("Open Settings, add/check Facebook, press Save, then set FACEBOOK_ACCESS_TOKEN for graph-api mode.");
    process.exitCode = 1;
    return;
  }

  const posts = await fetchFacebookPosts({ pageId, accessToken, limit, since });
  const writtenFiles = [];

  for (const post of posts) {
    const date = normalizeDate(post.created_time);
    const parts = formatDateParts(date);
    const stem = `${parts.fileDate}_facebook-graph_${slugPostId(post.id)}`;
    const mediaFolder = "";
    const markdown = toMarkdown({ post, account: selectedAccount, mediaFolder });
    const monthDir = path.join(outputRoot, "facebook", parts.month);
    const targetPath = path.join(monthDir, `${stem}.md`);

    await mkdir(monthDir, { recursive: true });
    await writeFile(targetPath, markdown, "utf8");
    writtenFiles.push(targetPath);
  }

  console.log(`Imported ${writtenFiles.length} Facebook posts.`);
  writtenFiles.forEach((filePath) => console.log(filePath));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
