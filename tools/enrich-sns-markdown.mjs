import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_MARKDOWN_ROOT = "./data/sample-md";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";

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

function readScalar(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  const value = match?.[1]?.trim() ?? "";

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
    const line = lines[index];
    const keyValue = line.match(new RegExp(`^${key}:\\s*(.*)$`));

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

function truncateText(value, maxLength) {
  const text = String(value || "").trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[TRUNCATED]`;
}

function resolveSelectedProvider(env, settings) {
  const providerId = (
    env.SNS_READER_LLM_PROVIDER ||
    env.LLM_PROVIDER ||
    settings.selectedLlmProvider ||
    env.VITE_LLM_DEFAULT_PROVIDER ||
    "openai"
  );

  return providerId.startsWith("ollama-") ? "ollama" : providerId;
}

function envModelForProvider(env, providerId) {
  const normalized = providerId.replace(/-/g, "_").toUpperCase();

  if (providerId.startsWith("ollama") || providerId === "ollama") {
    return (
      env.SNS_READER_LLM_MODEL ||
      env.LLM_MODEL ||
      env[`VITE_LLM_${normalized}_MODEL`] ||
      env.VITE_LLM_OLLAMA_MODEL ||
      env.VITE_LLM_OLLAMA_GEMMA_MODEL ||
      env.VITE_LLM_OLLAMA_QWEN_MODEL ||
      env.VITE_LLM_OLLAMA_LLAMA_MODEL ||
      "gemma4:latest"
    );
  }

  return (
    env.SNS_READER_LLM_MODEL ||
    env.LLM_MODEL ||
    env[`VITE_LLM_${normalized}_MODEL`] ||
    env.VITE_LLM_OPENAI_MODEL ||
    env.VITE_LLM_OPENAI_BALANCED_MODEL ||
    env.VITE_LLM_OPENAI_FRONTIER_MODEL ||
    DEFAULT_OPENAI_MODEL
  );
}

function getLlmConfig(env, settings, args = {}) {
  const providerId = resolveSelectedProvider(env, settings);
  const localMode = args.local === true || env.SNS_READER_LLM_MODE === "local" || env.LLM_MODE === "local";

  if (localMode || providerId === "local-preview") {
    return { providerId, mode: "local", model: "local-preview" };
  }

  if (providerId.startsWith("openai") || providerId === "chatgpt") {
    return {
      providerId,
      mode: "openai",
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
      model: envModelForProvider(env, providerId),
    };
  }

  if (providerId.startsWith("ollama") || providerId === "ollama") {
    return {
      providerId,
      mode: "ollama",
      apiKey: env.OLLAMA_API_KEY,
      baseUrl: env.OLLAMA_BASE_URL || env.SNS_READER_LLM_BASE_URL || env.LLM_API_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
      model: envModelForProvider(env, providerId),
    };
  }

  return {
    providerId,
    mode: "openai-compatible",
    apiKey: env.SNS_READER_LLM_API_KEY || env.LLM_API_KEY,
    baseUrl: env.SNS_READER_LLM_BASE_URL || env.LLM_API_BASE_URL,
    model: envModelForProvider(env, providerId),
  };
}

function localFallback(title, body) {
  const normalized = String(body || "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = [
    normalized[0] || title || "본문이 비어 있는 SNS 글입니다.",
    normalized.find((line) => line !== normalized[0] && line.length > 12) ||
      "LLM 연결 전 로컬 미리보기로 생성한 요약입니다.",
  ].slice(0, 2);
  const words =
    `${title} ${body}`.match(/[A-Za-z][A-Za-z0-9-]{2,}|[가-힣][가-힣A-Za-z0-9-]{1,}/g) ?? [];
  const tags = Array.from(new Set(words.map(cleanTag).filter((word) => word.length <= 24))).slice(0, 10);

  return { summary, tags };
}

function buildPrompt({ title, date, platform, account, source, body }) {
  return [
    "다음 SNS 게시글 본문을 읽고 Obsidian/PDF 아카이브용 2줄 요약과 추천 TAG를 작성해줘.",
    "",
    "반드시 아래 JSON 형식만 출력해.",
    "{\"summary\":[\"첫 번째 요약 문장\",\"두 번째 요약 문장\"],\"tags\":[\"태그1\",\"태그2\"]}",
    "",
    "요약 규칙:",
    "- summary는 한국어 2문장으로 작성한다.",
    "- 각 문장은 45자 이상 140자 이하로 쓴다.",
    "- 첫 줄은 글의 핵심 사건, 목적, 주제를 담는다.",
    "- 두 번째 줄은 구현 과정, 어려움, 감정, 의미 중 본문에 실제로 있는 내용을 담는다.",
    "- 본문에 있는 고유명사, 기술명, 링크, 서비스명은 중요하면 그대로 반영한다.",
    "- 본문에 없는 내용을 추측하지 않는다.",
    "- '게시글입니다', '기록입니다' 같은 빈 표현만으로 끝내지 않는다.",
    "",
    "TAG 규칙:",
    "- tags는 6개 이상 10개 이하로 작성한다.",
    "- #은 붙이지 않는다.",
    "- 한국어 태그는 공백과 하이픈 없이 붙여 쓴다. 예: 쿠키관리, 서버구축, 개발일지",
    "- 영어/기술명 태그는 원래 표기를 유지한다. 예: yt-dlp, GitHub, ChatGPT",
    "- Facebook, SNS 같은 플랫폼 일반 태그는 글의 핵심 주제일 때만 사용한다.",
    "- 본문 내용을 대표하는 구체적인 명사형 태그를 우선한다.",
    "",
    `platform: ${platform || ""}`,
    `account: ${account || ""}`,
    `date: ${date || ""}`,
    `title: ${title || ""}`,
    `source: ${source || ""}`,
    "",
    "body:",
    truncateText(body, 12000),
  ].join("\n");
}

function parseJsonPayload(value) {
  const text = String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }

    throw new Error("LLM response was not valid JSON.");
  }
}

function cleanTag(tag) {
  return String(tag || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, "")
    .replace(/([가-힣])-([가-힣])/g, "$1$2")
    .replace(/["'`]/g, "");
}

function normalizeLlmResult(value) {
  const parsed = typeof value === "string" ? parseJsonPayload(value) : value;
  const summary = Array.isArray(parsed.summary)
    ? parsed.summary.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 2)
    : [];
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(cleanTag).filter(Boolean).slice(0, 10) : [];

  if (summary.length !== 2) {
    throw new Error("LLM response must include exactly two summary lines.");
  }

  return { summary, tags };
}

async function readJsonResponseBody(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text } };
  }
}

function extractResponsesOutput(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const textParts = [];

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

async function callResponsesApi(config, post) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: [
        {
          role: "system",
          content: "You create faithful Korean summaries and tags from SNS post text. Return only valid JSON.",
        },
        {
          role: "user",
          content: buildPrompt(post),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "sns_summary_tags",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: { type: "string" },
              },
              tags: {
                type: "array",
                minItems: 1,
                maxItems: 10,
                items: { type: "string" },
              },
            },
            required: ["summary", "tags"],
          },
        },
      },
    }),
  });

  const data = await readJsonResponseBody(response);

  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI Responses API failed with HTTP ${response.status}.`);
  }

  return normalizeLlmResult(extractResponsesOutput(data));
}

async function callChatCompletionsApi(config, post) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You create faithful Korean summaries and tags from SNS post text. Return only valid JSON.",
        },
        {
          role: "user",
          content: buildPrompt(post),
        },
      ],
    }),
  });

  const data = await readJsonResponseBody(response);

  if (!response.ok) {
    throw new Error(data.error?.message || `Chat Completions API failed with HTTP ${response.status}.`);
  }

  return normalizeLlmResult(data.choices?.[0]?.message?.content || "");
}

async function callOllamaChatApi(config, post) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      options: {
        temperature: 0.2,
      },
      messages: [
        {
          role: "system",
          content: "You create faithful Korean summaries and tags from SNS post text. Return only valid JSON.",
        },
        {
          role: "user",
          content: buildPrompt(post),
        },
      ],
    }),
  });

  const data = await readJsonResponseBody(response);

  if (!response.ok) {
    throw new Error(data.error || data.error?.message || `Ollama chat API failed with HTTP ${response.status}.`);
  }

  return normalizeLlmResult(data.message?.content || "");
}

async function enrichWithLlm(config, post) {
  if (config.mode === "openai" && !config.apiKey) {
    throw new Error(`Missing API key for ${config.providerId}. Set OPENAI_API_KEY in .env or choose Local Preview explicitly.`);
  }

  if (!config.model) {
    throw new Error(`Missing model for ${config.providerId}. Set SNS_READER_LLM_MODEL or the matching VITE_LLM_*_MODEL value.`);
  }

  if (config.mode === "openai") {
    return callResponsesApi(config, post);
  }

  if (config.mode === "ollama") {
    if (!config.baseUrl) {
      throw new Error("Missing Ollama base URL. Set OLLAMA_BASE_URL in .env.");
    }

    return callOllamaChatApi(config, post);
  }

  if (!config.apiKey) {
    throw new Error(`Missing API key for ${config.providerId}. Set SNS_READER_LLM_API_KEY or LLM_API_KEY in .env.`);
  }

  if (!config.baseUrl) {
    throw new Error(`Missing base URL for ${config.providerId}. Set SNS_READER_LLM_BASE_URL or LLM_API_BASE_URL.`);
  }

  return callChatCompletionsApi(config, post);
}

function yamlQuote(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function replaceFrontmatterField(frontmatter, key, value) {
  const lines = frontmatter.split(/\r?\n/);
  const output = [];
  let replaced = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith(`${key}:`)) {
      replaced = true;

      if (Array.isArray(value)) {
        output.push(`${key}:`);
        value.forEach((item) => output.push(`  - ${item}`));
      } else {
        output.push(`${key}: ${value}`);
      }

      while (lines[index + 1]?.match(/^\s*-\s+/)) {
        index += 1;
      }
    } else {
      output.push(line);
    }
  }

  if (!replaced) {
    if (Array.isArray(value)) {
      output.push(`${key}:`);
      value.forEach((item) => output.push(`  - ${item}`));
    } else {
      output.push(`${key}: ${value}`);
    }
  }

  return output.join("\n");
}

function upsertFrontmatter(markdown, summary, tags, config) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return markdown;
  }

  let frontmatter = match[1];
  frontmatter = replaceFrontmatterField(frontmatter, "has_summary", "true");
  frontmatter = replaceFrontmatterField(frontmatter, "summary_provider", yamlQuote(config.mode === "local" ? "local-preview" : config.providerId));
  frontmatter = replaceFrontmatterField(frontmatter, "summary_model", yamlQuote(config.model || "local-preview"));
  frontmatter = replaceFrontmatterField(frontmatter, "summary", summary.map(yamlQuote));
  frontmatter = replaceFrontmatterField(frontmatter, "tags", tags.map(yamlQuote));

  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${frontmatter}\n---`);
}

function upsertSummarySection(markdown, summary) {
  const section = `## Summary\n\n${summary.map((line) => `- ${line}`).join("\n")}`;

  if (/## Summary\s*\n[\s\S]*?(?=\n## |$)/i.test(markdown)) {
    return markdown.replace(/## Summary\s*\n[\s\S]*?(?=\n## |$)/i, section);
  }

  return `${markdown.trim()}\n\n${section}\n`;
}

function isIncludedPlatform(markdown, platform) {
  if (!platform || platform === "all") {
    return true;
  }

  return new RegExp(`platform:\\s*"?${platform}"?`, "i").test(markdown);
}

function isAlreadyEnriched(markdown, config) {
  const expectedProvider = config.mode === "local" ? "local-preview" : config.providerId;
  const expectedModel = config.model || "local-preview";

  return (
    readScalar(markdown, "has_summary") === "true" &&
    readScalar(markdown, "summary_provider") === expectedProvider &&
    readScalar(markdown, "summary_model") === expectedModel
  );
}

function hasMeaningfulSummary(markdown) {
  const frontmatterSummary = readFrontmatterList(markdown, "summary");
  const sectionLines = extractSection(markdown, "Summary")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  const lines = frontmatterSummary.length ? frontmatterSummary : sectionLines;
  const text = lines.join(" ");

  return lines.length >= 2 && !/summary will be generated/i.test(text);
}

function hasMeaningfulTags(markdown) {
  const genericTags = new Set(["sns", "facebook", "instagram", "threads", "youtube", "x", "naverblog", "naver-blog"]);
  const tags = readFrontmatterList(markdown, "tags").map(cleanTag).filter(Boolean);

  return tags.some((tag) => !genericTags.has(tag.toLowerCase()));
}

function hasAnyExistingSummaryAndTags(markdown) {
  return hasMeaningfulSummary(markdown) && hasMeaningfulTags(markdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadSettings(env);
  const root = path.resolve(args.root || settings.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);
  const platform = args.platform || "facebook";
  const limit = args.limit ? Number(args.limit) : Number.POSITIVE_INFINITY;
  const config = getLlmConfig(env, settings, args);
  const files = (await walkMarkdownFiles(root)).sort();
  let updated = 0;
  let skipped = 0;
  let alreadyEnriched = 0;

  console.log(
    config.mode === "local"
      ? `Enriching Markdown with local preview under ${root}.`
      : `Enriching Markdown with ${config.providerId} (${config.model}) under ${root}.`
  );

  for (const file of files) {
    if (updated >= limit) {
      break;
    }

    const markdown = await readFile(file, "utf8");

    if (!isIncludedPlatform(markdown, platform)) {
      continue;
    }

    if (!args.force && args["skip-any-existing"] && hasAnyExistingSummaryAndTags(markdown)) {
      alreadyEnriched += 1;
      continue;
    }

    if (!args.force && isAlreadyEnriched(markdown, config)) {
      alreadyEnriched += 1;
      continue;
    }

    const body = extractSection(markdown, "Body");

    if (!body.trim()) {
      skipped += 1;
      continue;
    }

    const post = {
      title: readScalar(markdown, "title"),
      date: readScalar(markdown, "date"),
      source: readScalar(markdown, "source"),
      platform: readScalar(markdown, "platform"),
      account: readScalar(markdown, "account"),
      body,
    };
    const result = config.mode === "local" ? localFallback(post.title, post.body) : await enrichWithLlm(config, post);
    const nextMarkdown = upsertSummarySection(upsertFrontmatter(markdown, result.summary, result.tags, config), result.summary);

    if (nextMarkdown !== markdown) {
      await writeFile(file, `${nextMarkdown.trim()}\n`, "utf8");
      updated += 1;
    }

    console.log(`Updated ${path.relative(root, file)}.`);
  }

  console.log(
    `Updated ${updated} Markdown files under ${root}. Skipped ${skipped} empty-body files. Already enriched ${alreadyEnriched} files.`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
