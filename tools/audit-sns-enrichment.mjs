import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_ROOT = "F:/Obsidian/PC-Madwind/SNS";
const GENERIC_TAGS = new Set(["sns", "facebook", "instagram", "threads", "youtube", "x", "naverblog", "naver-blog"]);
const INVALID_SUMMARY_PATTERNS = [
  /summary will be generated/i,
  /\uC694\uC57D\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4/i,
  /\uC694\uC57D\uC774 \uC5B4\uB835/i,
  /\uB0B4\uC6A9\uC774 \uC81C\uACF5\uB418\uC9C0/i,
  /\uBCF8\uBB38 \uB0B4\uC6A9\uC774 \uC81C\uACF5\uB418\uC9C0/i,
  /\uC815\uBCF4\uAC00 \uBD80\uC871/i,
  /\uC815\uBCF4 \uBD80\uC871/i,
  /\uC6D0\uBCF8 SNS \uAC8C\uC2DC\uAE00\uC758 \uB0B4\uC6A9\uC744 \uC81C\uACF5/i,
];

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

async function walkMarkdownFiles(root, files = []) {
  if (!existsSync(root)) {
    return files;
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() !== "_archive") {
        await walkMarkdownFiles(fullPath, files);
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function readScalar(markdown, key) {
  const value = markdown.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";

  return value.replace(/^["']|["']$/g, "");
}

function readFrontmatterList(markdown, key) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return [];
  }

  const lines = match[1].split(/\r?\n/);
  const values = [];

  for (let index = 0; index < lines.length; index += 1) {
    const keyValue = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`));

    if (!keyValue) {
      continue;
    }

    const inlineValue = keyValue[1]?.trim();

    if (inlineValue) {
      return [inlineValue.replace(/^["']|["']$/g, "")];
    }

    while (lines[index + 1]?.match(/^\s*-\s+/)) {
      index += 1;
      values.push(lines[index].replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, "").trim());
    }

    return values.filter(Boolean);
  }

  return values;
}

function normalizeTag(tag) {
  return String(tag || "")
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function hasMeaningfulEnrichment(markdown) {
  const summary = readFrontmatterList(markdown, "summary");
  const tags = readFrontmatterList(markdown, "tags").map(normalizeTag);
  const summaryText = summary.join(" ");

  return (
    summary.length >= 2 &&
    !INVALID_SUMMARY_PATTERNS.some((pattern) => pattern.test(summaryText)) &&
    tags.some((tag) => !GENERIC_TAGS.has(tag))
  );
}

function addBucket(buckets, key, ok) {
  const bucket = buckets[key] ?? { total: 0, ok: 0, missing: 0 };
  bucket.total += 1;

  if (ok) {
    bucket.ok += 1;
  } else {
    bucket.missing += 1;
  }

  buckets[key] = bucket;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || DEFAULT_ROOT);
  const files = await walkMarkdownFiles(root);
  const byProvider = {};
  const byYear = {};
  let ok = 0;
  let missing = 0;

  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const provider = readScalar(markdown, "platform") || path.relative(root, file).split(path.sep)[0] || "unknown";
    const year = readScalar(markdown, "date").match(/\d{4}/)?.[0] || "unknown";
    const enriched = hasMeaningfulEnrichment(markdown);

    if (enriched) {
      ok += 1;
    } else {
      missing += 1;
    }

    addBucket(byProvider, provider, enriched);
    addBucket(byYear, year, enriched);
  }

  console.log(
    JSON.stringify(
      {
        total: files.length,
        ok,
        missing,
        byProvider: Object.fromEntries(Object.entries(byProvider).sort()),
        missingByYear: Object.fromEntries(Object.entries(byYear).filter(([, value]) => value.missing > 0).sort()),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
