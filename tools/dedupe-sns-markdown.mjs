import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_MARKDOWN_ROOT = "./data/sample-md";
const GENERATED_SECTIONS = ["Date", "Body", "Images", "Videos", "Comments", "Summary", "TAG", "Source"];

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

function readProperty(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"));

  return match?.[1]?.trim() ?? "";
}

function extractSection(markdown, section) {
  const sectionIndex = GENERATED_SECTIONS.findIndex((item) => item.toLowerCase() === section.toLowerCase());
  const headingMatch = markdown.match(new RegExp(`(^|\\r?\\n)## ${section}\\s*\\r?\\n`, "i"));

  if (!headingMatch || typeof headingMatch.index !== "number") {
    return "";
  }

  const start = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(start);
  const laterSections = sectionIndex >= 0 ? GENERATED_SECTIONS.slice(sectionIndex + 1) : GENERATED_SECTIONS;
  const endOffsets = laterSections
    .map((nextSection) => rest.match(new RegExp(`\\r?\\n## ${nextSection}\\s*\\r?\\n`, "i"))?.index)
    .filter((index) => typeof index === "number");
  const end = endOffsets.length ? start + Math.min(...endOffsets) : markdown.length;

  return markdown.slice(start, end).trim();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function createdTimeMs(value) {
  const time = Date.parse(String(value || ""));

  return Number.isFinite(time) ? time : 0;
}

function dateKeyFromCreated(value) {
  return String(value || "").slice(0, 10);
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;

  while (index < max && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function sectionMediaNames(markdown, section) {
  return [...extractSection(markdown, section).matchAll(/!\[\[([^\]]+)\]\]/g)]
    .map((match) => path.basename(match[1]))
    .sort()
    .join("|");
}

function contentFingerprint(entry) {
  return createHash("sha1")
    .update(
      [
        entry.platform,
        entry.created,
        entry.title,
        normalizeText(entry.body),
        entry.imageCount,
        sectionMediaNames(entry.markdown, "Images"),
        sectionMediaNames(entry.markdown, "Videos"),
      ].join("\n")
    )
    .digest("hex");
}

function hasGeneratedSummary(markdown) {
  const summary = extractSection(markdown, "Summary");

  return Boolean(summary && !/Summary will be generated after the LLM summarizer is connected/i.test(summary));
}

function keeperScore(entry) {
  return [
    hasGeneratedSummary(entry.markdown) ? 1 : 0,
    Number(entry.imageCount || 0),
    sectionMediaNames(entry.markdown, "Images").length + sectionMediaNames(entry.markdown, "Videos").length,
    normalizeText(entry.body).length,
    -entry.relativePath.length,
  ];
}

function compareKeeper(left, right) {
  const leftScore = keeperScore(left);
  const rightScore = keeperScore(right);

  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }

  return left.relativePath.localeCompare(right.relativePath);
}

function duplicatePlan(entries) {
  const parent = new Map();

  function find(value) {
    const current = parent.get(value) ?? value;

    if (current === value) {
      parent.set(value, value);
      return value;
    }

    const root = find(current);
    parent.set(value, root);
    return root;
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  }

  entries.forEach((entry) => parent.set(entry.filePath, entry.filePath));

  for (const key of ["postIdKey", "fingerprint"]) {
    const byKey = new Map();

    for (const entry of entries) {
      const value = entry[key];

      if (!value) {
        continue;
      }

      const previous = byKey.get(value);

      if (previous) {
        union(previous.filePath, entry.filePath);
      } else {
        byKey.set(value, entry);
      }
    }
  }

  const byRevisionKey = new Map();

  for (const entry of entries) {
    const key = [entry.platform, entry.dateKey, normalizeText(entry.title), entry.imageCount].join("\n");
    const current = byRevisionKey.get(key) ?? [];

    current.push(entry);
    byRevisionKey.set(key, current);
  }

  for (const group of byRevisionKey.values()) {
    if (group.length < 2) {
      continue;
    }

    const sorted = group.slice().sort((left, right) => left.createdMs - right.createdMs);

    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex];
        const right = sorted[rightIndex];
        const timeDelta = Math.abs(right.createdMs - left.createdMs);
        const leftBody = normalizeText(left.body);
        const rightBody = normalizeText(right.body);
        const shorter = leftBody.length <= rightBody.length ? leftBody : rightBody;
        const longer = leftBody.length <= rightBody.length ? rightBody : leftBody;
        // A same-day edit often reworks the tail of a post (not just appends to
        // it), so require most of the shorter body to match from the start
        // rather than an exact prefix - catches "edited within N minutes" cases
        // that a strict startsWith() would miss.
        const prefixRatio = shorter.length > 0 ? commonPrefixLength(shorter, longer) / shorter.length : 0;

        if (
          left.createdMs > 0 &&
          right.createdMs > 0 &&
          timeDelta <= 30 * 60 * 1000 &&
          shorter.length >= 120 &&
          longer.length > shorter.length &&
          prefixRatio >= 0.85
        ) {
          union(left.filePath, right.filePath);
        }
      }
    }
  }

  const components = new Map();

  for (const entry of entries) {
    const root = find(entry.filePath);
    const current = components.get(root) ?? [];

    current.push(entry);
    components.set(root, current);
  }

  return [...components.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = group.slice().sort(compareKeeper);
      const [keep, ...remove] = sorted;

      return { keep, remove };
    });
}

function normalizePathForCompare(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function isPathInside(childPath, parentPath) {
  const child = normalizePathForCompare(childPath);
  const parent = normalizePathForCompare(parentPath);

  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function deleteEntry(entry, root) {
  if (entry.filePath && isPathInside(entry.filePath, root)) {
    await rm(entry.filePath, { force: true });
  }

  if (entry.mediaPath && isPathInside(entry.mediaPath, root)) {
    await rm(entry.mediaPath, { recursive: true, force: true });
  }
}

function platformMatches(platform, filter) {
  return !filter || filter === "all" || platform.toLowerCase() === filter.toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadSettings(env);
  const root = path.resolve(args.root || settings.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);
  const platformFilter = String(args.platform || "all");
  const files = await walkMarkdownFiles(root);
  const entries = [];

  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => "");
    const platform = readProperty(markdown, "platform");

    if (readProperty(markdown, "type") !== "sns-post" || !platform || !platformMatches(platform, platformFilter)) {
      continue;
    }

    const mediaFolder = readProperty(markdown, "media_folder");
    const entry = {
      filePath,
      relativePath: path.relative(root, filePath),
      mediaPath: mediaFolder ? path.resolve(path.dirname(filePath), mediaFolder.replaceAll("/", path.sep)) : "",
      markdown,
      platform,
      postId: readProperty(markdown, "post_id"),
      created: readProperty(markdown, "created"),
      createdMs: createdTimeMs(readProperty(markdown, "created")),
      dateKey: dateKeyFromCreated(readProperty(markdown, "created")),
      title: readProperty(markdown, "title"),
      imageCount: readProperty(markdown, "image_count"),
      body: extractSection(markdown, "Body"),
    };

    entry.postIdKey = entry.postId ? `${entry.platform}:${entry.postId}` : "";
    entry.fingerprint = contentFingerprint(entry);
    entries.push(entry);
  }

  const plan = duplicatePlan(entries);
  const duplicateFiles = plan.reduce((total, group) => total + group.remove.length, 0);
  const dryRun = !args.apply;
  const byPlatform = entries.reduce((counts, entry) => {
    counts.set(entry.platform, (counts.get(entry.platform) ?? 0) + 1);
    return counts;
  }, new Map());

  console.log(`SNS Markdown root: ${root}`);
  console.log(`Platform filter: ${platformFilter}`);
  console.log(`Markdown files scanned: ${entries.length}`);
  console.log(
    `Scanned by platform: ${[...byPlatform.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([platform, count]) => `${platform} ${count}`)
      .join(", ") || "none"}`
  );
  console.log(`Duplicate groups found: ${plan.length}`);
  console.log(`Duplicate files ${dryRun ? "to remove" : "removed"}: ${duplicateFiles}`);

  for (const group of plan.slice(0, Number(args["show-examples"] || 8))) {
    console.log(`KEEP ${group.keep.relativePath}`);
    group.remove.forEach((entry) => console.log(`  REMOVE ${entry.relativePath}`));
  }

  if (!dryRun) {
    for (const group of plan) {
      for (const entry of group.remove) {
        await deleteEntry(entry, root);
      }
    }
  }

  if (dryRun) {
    console.log("Dry run only. Re-run with --apply to delete duplicate Markdown files and their media folders.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
