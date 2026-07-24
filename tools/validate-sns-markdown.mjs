import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hasCollapsedFacebookText } from "./facebook-post-text.mjs";

const workspaceRoot = process.cwd();
const REACTIONS_TEXT = "\uBAA8\uB4E0 \uACF5\uAC10:";
const AUTHOR_TEXT = "\uBBF8\uCE5C\uBC14\uB78C";
const IMAGE_COUNT_TEXT = "\uC7A5";
const COMMENT_COUNT_TEXT = "\uB313\uAE00";
const MONTH_TEXT = "\uC6D4";
const DAY_TEXT = "\uC77C";

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

async function walkMarkdownFiles(root, files = []) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      await walkMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

const GENERATED_MARKDOWN_SECTIONS = ["Date", "Body", "Images", "Videos", "Comments", "Summary", "Source"];

function extractSection(markdown, section) {
  const sectionIndex = GENERATED_MARKDOWN_SECTIONS.findIndex((item) => item.toLowerCase() === section.toLowerCase());
  const headingMatch = markdown.match(new RegExp(`(^|\\r?\\n)## ${section}\\s*\\r?\\n`, "i"));

  if (!headingMatch || typeof headingMatch.index !== "number") {
    return "";
  }

  const start = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(start);
  const laterSections =
    sectionIndex >= 0 ? GENERATED_MARKDOWN_SECTIONS.slice(sectionIndex + 1) : GENERATED_MARKDOWN_SECTIONS;
  const endOffsets = laterSections
    .map((nextSection) => rest.match(new RegExp(`\\r?\\n## ${nextSection}\\s*\\r?\\n`, "i"))?.index)
    .filter((index) => typeof index === "number");
  const end = endOffsets.length ? start + Math.min(...endOffsets) : markdown.length;

  return markdown.slice(start, end).trim();
}

function readProperty(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"));

  return match?.[1]?.trim() ?? "";
}

export function hasCollapsedBody(value) {
  return hasCollapsedFacebookText(value);
}

function hasFacebookFooterInBody(value) {
  const text = String(value || "");

  return (
    new RegExp(`^${REACTIONS_TEXT}$`, "m").test(text) ||
    new RegExp(`^\\+\\d+${IMAGE_COUNT_TEXT}$`, "m").test(text) ||
    new RegExp(`^${COMMENT_COUNT_TEXT}\\s+\\d+\\s*\\uAC1C$`, "m").test(text)
  );
}

function hasAuthorDatePrefix(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.length >= 2 &&
    lines[0] === AUTHOR_TEXT &&
    new RegExp(`^\\d+${MONTH_TEXT}\\s+\\d+${DAY_TEXT}$`).test(lines[1])
  );
}

export async function findMarkdownQualityIssues(root) {
  const files = await walkMarkdownFiles(root);
  const issues = [];

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");

    if (!markdown.includes("type: sns-post") && !markdown.includes("platform:")) {
      continue;
    }

    const body = extractSection(markdown, "Body");
    const title = readProperty(markdown, "title");

    if (hasCollapsedBody(body)) {
      issues.push({ severity: "error", code: "collapsed-body", filePath });
    }

    if (hasCollapsedBody(title)) {
      issues.push({ severity: "error", code: "collapsed-title", filePath });
    }

    if (hasFacebookFooterInBody(body)) {
      issues.push({ severity: "error", code: "facebook-footer-in-body", filePath });
    }

    if (hasAuthorDatePrefix(body)) {
      issues.push({ severity: "warning", code: "facebook-author-date-prefix", filePath });
    }
  }

  return issues;
}

async function main() {
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const root = path.resolve(process.argv[2] || settings?.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || "./data/sample-md");
  const issues = await findMarkdownQualityIssues(root);
  const errors = issues.filter((issue) => issue.severity === "error");

  if (issues.length === 0) {
    console.log(`Markdown quality check passed: ${root}`);
    return;
  }

  console.error(`Markdown quality check found ${issues.length} issue(s):`);
  issues.forEach((issue) => console.error(`${issue.severity.toUpperCase()} ${issue.code}: ${issue.filePath}`));

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
