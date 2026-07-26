import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_MARKDOWN_ROOT = "./data/sample-md";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";
const DEFAULT_BODY_LIMIT = Number(process.env.SNS_READER_LLM_BODY_LIMIT || 6000);
const DEFAULT_BATCH_BODY_LIMIT = Number(process.env.SNS_READER_LLM_BATCH_BODY_LIMIT || 2500);
const DEFAULT_TIMEOUT_MS = Number(process.env.SNS_READER_LLM_TIMEOUT_MS || 180000);
const DEFAULT_OUTPUT_TOKENS = Number(process.env.SNS_READER_LLM_OUTPUT_TOKENS || 900);
const DEFAULT_BATCH_OUTPUT_TOKENS = Number(process.env.SNS_READER_LLM_BATCH_OUTPUT_TOKENS || 3600);

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
      "LLM 연결 없이 로컬 미리보기로 생성한 요약입니다.",
  ].slice(0, 2);
  const words = `${title} ${body}`.match(/[A-Za-z][A-Za-z0-9-]{2,}|[가-힣][가-힣A-Za-z0-9-]{1,}/g) ?? [];
  const tags = Array.from(new Set(words.map(cleanTag).filter((word) => word.length <= 24))).slice(0, 10);

  return { summary, tags };
}

function lowInformationFallback({ title, date, platform, body }) {
  const label = collapseInlineText(String(body || title || "짧은 SNS 기록").replace(/^\[|\]$/g, ""));
  const platformLabel = platform ? cleanTag(platform) : "SNS";
  const dated = date ? `${date}에 남긴` : "날짜가 기록된";

  return {
    summary: [
      `${dated} 짧은 ${platformLabel} 게시물로, 원문에는 "${label}" 정도의 제한된 내용만 남아 있습니다.`,
      "구체적인 사건이나 감정은 충분히 복원되지 않아 링크성 기록 또는 원문 보강 대상으로 아카이브합니다.",
    ],
    tags: [platformLabel, "짧은기록", "링크성게시물", "본문부족", "아카이브", "원문보강"],
  };
}

function isLowInformationBody(body) {
  const text = String(body || "").trim();
  const compact = text.replace(/\s+/g, "");

  return compact.length < 24 || /^\[[^\]]+\]$/.test(compact) || /^https?:\/\/\S+$/i.test(compact);
}

function collapseInlineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildPrompt({ title, date, platform, account, source, body }) {
  return [
    "다음 SNS 게시글 본문을 읽고 Obsidian/PDF 아카이브용 2줄 요약과 추천 TAG를 작성해 주세요.",
    "",
    "반드시 아래 JSON 형식만 출력하세요.",
    "{\"summary\":[\"첫 번째 요약 문장\",\"두 번째 요약 문장\"],\"tags\":[\"태그1\",\"태그2\"]}",
    "",
    "요약 규칙:",
    "- summary는 한국어 2문장으로 작성한다.",
    "- 각 문장은 45자 이상 140자 이하로 쓴다.",
    "- 첫 줄은 글의 핵심 사건, 목적, 주제를 담는다.",
    "- 둘째 줄은 구현 과정, 고민, 감정, 한계 중 본문에 실제로 있는 내용을 담는다.",
    "- 본문에 있는 고유명사, 기술명, 링크, 서비스명은 중요하면 그대로 반영한다.",
    "- 본문에 없는 내용은 추측하지 않는다.",
    "- '게시글입니다', '기록입니다' 같은 빈 표현만으로 끝내지 않는다.",
    "",
    "TAG 규칙:",
    "- tags는 6개 이상 10개 이하로 작성한다.",
    "- #은 붙이지 않는다.",
    "- 한국어 태그는 공백과 하이픈 없이 붙여 쓴다. 예: 쿠키관리, 서버구축, 개발일지",
    "- 영어/기술명 태그는 원래 표기를 유지한다. 예: yt-dlp, GitHub, ChatGPT",
    "- Facebook, SNS 같은 플랫폼 일반 태그는 글의 핵심 주제일 때만 사용한다.",
    "- 본문 내용에 대응하는 구체적인 명사형 태그를 우선한다.",
    "",
    `platform: ${platform || ""}`,
    `account: ${account || ""}`,
    `date: ${date || ""}`,
    `title: ${title || ""}`,
    `source: ${source || ""}`,
    "",
    "body:",
    truncateText(body, DEFAULT_BODY_LIMIT),
  ].join("\n");
}

function buildBatchPrompt(posts) {
  const serializedPosts = posts.map((post) => ({
    id: post.id,
    platform: post.platform || "",
    account: post.account || "",
    date: post.date || "",
    title: post.title || "",
    source: post.source || "",
    body: truncateText(post.body, DEFAULT_BATCH_BODY_LIMIT),
  }));

  return [
    "아래 SNS 게시글 여러 개를 각각 독립적으로 읽고 Obsidian/PDF 아카이브용 2줄 요약과 추천 TAG를 작성해 주세요.",
    "",
    "반드시 아래 JSON 형식만 출력하세요.",
    "{\"items\":[{\"id\":\"p1\",\"summary\":[\"첫 번째 요약 문장\",\"두 번째 요약 문장\"],\"tags\":[\"태그1\",\"태그2\"]}]}",
    "",
    "요약 규칙:",
    "- 각 items 항목은 입력 posts의 id와 정확히 일치해야 한다.",
    "- summary는 한국어 2문장으로 작성한다.",
    "- 각 문장은 45자 이상 140자 이하로 쓴다.",
    "- 첫 줄은 글의 핵심 사건, 목적, 주제를 담는다.",
    "- 둘째 줄은 구현 과정, 고민, 감정, 한계 중 본문에 실제로 있는 내용을 담는다.",
    "- 본문에 있는 고유명사, 기술명, 링크, 서비스명은 중요하면 그대로 반영한다.",
    "- 본문에 없는 내용은 추측하지 않는다.",
    "- 서로 다른 게시글의 내용을 섞지 않는다.",
    "",
    "TAG 규칙:",
    "- tags는 6개 이상 10개 이하로 작성한다.",
    "- #은 붙이지 않는다.",
    "- 한국어 태그는 공백과 하이픈 없이 붙여 쓴다.",
    "- 영어/기술명 태그는 원래 표기를 유지한다.",
    "- Facebook, SNS 같은 플랫폼 일반 태그는 글의 핵심 주제일 때만 사용한다.",
    "",
    "posts:",
    JSON.stringify(serializedPosts, null, 2),
  ].join("\n");
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  // Small local models sometimes return tags as a single comma-separated
  // string instead of a JSON array - recover that instead of silently
  // discarding the tags entirely.
  const rawTags = parsed.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.map(cleanTag).filter(Boolean).slice(0, 10)
    : typeof rawTags === "string"
      ? rawTags.split(/[,、，]+/).map(cleanTag).filter(Boolean).slice(0, 10)
      : [];

  if (summary.length === 1) {
    const split = splitSummaryLine(summary[0]);

    if (split.length === 2) {
      summary.splice(0, summary.length, ...split);
    }
  }

  if (summary.length !== 2) {
    throw new Error("LLM response must include two summary lines.");
  }

  if (tags.length === 0) {
    throw new Error("LLM response must include at least one tag.");
  }

  return { summary, tags };
}

function normalizeBatchLlmResult(value, posts) {
  const parsed = typeof value === "string" ? parseJsonPayload(value) : value;
  const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
  const expectedIds = new Set(posts.map((post) => post.id));
  const results = new Map();

  for (const item of items) {
    const id = String(item?.id || "").trim();

    if (!expectedIds.has(id)) {
      continue;
    }

    results.set(id, normalizeLlmResult(item));
  }

  const missingIds = posts.map((post) => post.id).filter((id) => !results.has(id));

  if (missingIds.length) {
    throw new Error(`LLM batch response missed ${missingIds.length} item(s): ${missingIds.join(", ")}`);
  }

  return results;
}

function splitSummaryLine(line) {
  const text = String(line || "").trim();

  if (!text) {
    return [];
  }

  const sentenceSplit = text
    .split(/(?<=[.!?。！？다요음임됨함함니다습니다])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentenceSplit.length >= 2) {
    return [sentenceSplit[0], sentenceSplit.slice(1).join(" ")].map((part) => part.trim()).filter(Boolean);
  }

  if (text.length >= 90) {
    const midpoint = Math.floor(text.length / 2);
    const leftSpace = text.lastIndexOf(" ", midpoint);
    const rightSpace = text.indexOf(" ", midpoint);
    const splitAt = leftSpace > 35 ? leftSpace : rightSpace > 0 ? rightSpace : midpoint;

    return [text.slice(0, splitAt).trim(), text.slice(splitAt).trim()].filter(Boolean);
  }

  return [];
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
  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}/responses`, {
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
  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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

  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      options: {
        temperature: 0.2,
        num_predict: DEFAULT_OUTPUT_TOKENS,
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

  const content = data.message?.content || "";

  try {
    return normalizeLlmResult(content);
  } catch {
    return repairOllamaJson(config, post, content);
  }
}

async function repairOllamaJson(config, post, invalidContent) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: DEFAULT_OUTPUT_TOKENS,
      },
      messages: [
        {
          role: "system",
          content: "Return only valid JSON. No markdown fences, no commentary.",
        },
        {
          role: "user",
          content: [
            "아래 SNS 글과 이전 LLM 응답을 참고해서 valid JSON만 다시 작성하세요.",
            "{\"summary\":[\"첫 번째 요약 문장\",\"두 번째 요약 문장\"],\"tags\":[\"태그1\",\"태그2\"]}",
            "",
            "조건:",
            "- summary는 한국어 2문장",
            "- tags는 # 없이 6개 이상 10개 이하",
            "- 본문에 없는 내용은 추가하지 않음",
            "",
            `title: ${post.title || ""}`,
            `date: ${post.date || ""}`,
            "",
            "previous invalid response:",
            truncateText(invalidContent, 1800),
            "",
            "body:",
            truncateText(post.body, 3000),
          ].join("\n"),
        },
      ],
    }),
  });

  const data = await readJsonResponseBody(response);

  if (!response.ok) {
    throw new Error(data.error || data.error?.message || `Ollama JSON repair failed with HTTP ${response.status}.`);
  }

  return normalizeLlmResult(data.message?.content || "");
}

async function callOllamaBatchChatApi(config, posts) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      options: {
        temperature: 0.15,
        num_predict: Math.max(DEFAULT_BATCH_OUTPUT_TOKENS, posts.length * 420),
      },
      messages: [
        {
          role: "system",
          content: "You create faithful Korean summaries and tags from SNS post text. Return only valid JSON.",
        },
        {
          role: "user",
          content: buildBatchPrompt(posts),
        },
      ],
    }),
  });

  const data = await readJsonResponseBody(response);

  if (!response.ok) {
    throw new Error(data.error || data.error?.message || `Ollama batch chat API failed with HTTP ${response.status}.`);
  }

  return normalizeBatchLlmResult(data.message?.content || "", posts);
}

async function enrichBatchWithLlm(config, posts) {
  if (!posts.length) {
    return new Map();
  }

  if (config.mode !== "ollama") {
    throw new Error("Batch enrichment currently supports Ollama only.");
  }

  if (!config.baseUrl) {
    throw new Error("Missing Ollama base URL. Set OLLAMA_BASE_URL in .env.");
  }

  if (!config.model) {
    throw new Error(`Missing model for ${config.providerId}. Set SNS_READER_LLM_MODEL or the matching VITE_LLM_*_MODEL value.`);
  }

  return callOllamaBatchChatApi(config, posts);
}

async function enrichBatchResilient(config, posts, retries) {
  try {
    return await withRetry(() => enrichBatchWithLlm(config, posts), retries);
  } catch (error) {
    if (posts.length <= 1) {
      throw error;
    }

    const midpoint = Math.ceil(posts.length / 2);
    console.warn(`Batch failed for ${posts.length} item(s), splitting into ${midpoint} and ${posts.length - midpoint}: ${error.message}`);
    const left = await enrichBatchResilient(config, posts.slice(0, midpoint), retries);
    const right = await enrichBatchResilient(config, posts.slice(midpoint), retries);

    return new Map([...left, ...right]);
  }
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
  return `"${collapseInlineText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isFrontmatterKeyLine(line) {
  return /^[A-Za-z0-9_-]+:\s*/.test(line);
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

      if (Array.isArray(value)) {
        while (lines[index + 1] !== undefined && !isFrontmatterKeyLine(lines[index + 1])) {
          index += 1;
        }
      } else {
        while (lines[index + 1]?.match(/^\s+/)) {
          index += 1;
        }
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
  frontmatter = replaceFrontmatterField(frontmatter, "summary", summary.map(collapseInlineText).map(yamlQuote));
  frontmatter = replaceFrontmatterField(frontmatter, "tags", tags.map(yamlQuote));

  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${frontmatter}\n---`);
}

function upsertSummarySection(markdown, summary) {
  const section = `## Summary\n\n${summary.map((line) => `- ${collapseInlineText(line)}`).join("\n")}`;

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

function normalizeDate(value) {
  const match = String(value || "").match(/(\d{4})[.-](\d{1,2})[.-](\d{1,2})/);

  if (!match) {
    return "";
  }

  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function isIncludedDate(markdown, args) {
  const date = normalizeDate(readScalar(markdown, "date"));

  if (!date) {
    return !args.year && !args["date-from"] && !args["date-to"];
  }

  if (args.year && !String(args.year).split(",").map((year) => year.trim()).filter(Boolean).includes(date.slice(0, 4))) {
    return false;
  }

  if (args["date-from"] && date < normalizeDate(args["date-from"])) {
    return false;
  }

  if (args["date-to"] && date > normalizeDate(args["date-to"])) {
    return false;
  }

  return true;
}

function isAlreadyEnriched(markdown, config) {
  const expectedProvider = config.mode === "local" ? "local-preview" : config.providerId;
  const expectedModel = config.model || "local-preview";

  return (
    readScalar(markdown, "has_summary") === "true" &&
    readScalar(markdown, "summary_provider") === expectedProvider &&
    readScalar(markdown, "summary_model") === expectedModel &&
    hasAnyExistingSummaryAndTags(markdown)
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

  return (
    lines.length >= 2 &&
    !/summary will be generated/i.test(text) &&
    !/요약할 수 없습니다|요약이 어렵|내용이 제공되지|본문 내용이 제공되지|정보가 부족|정보 부족|원본 SNS 게시글의 내용을 제공/i.test(text)
  );
}

function hasMeaningfulTags(markdown) {
  const genericTags = new Set(["sns", "facebook", "instagram", "threads", "youtube", "x", "naverblog", "naver-blog"]);
  const tags = readFrontmatterList(markdown, "tags").map(cleanTag).filter(Boolean);

  return tags.some((tag) => !genericTags.has(tag.toLowerCase()));
}

function hasAnyExistingSummaryAndTags(markdown) {
  return hasMeaningfulSummary(markdown) && hasMeaningfulTags(markdown);
}

function isArchivedFile(root, file) {
  return path
    .relative(root, file)
    .split(path.sep)
    .some((part) => part.toLowerCase() === "_archive");
}

async function appendJsonl(file, record) {
  if (!file) {
    return;
  }

  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

function resolveResultFile(root, relativeFile) {
  const resolved = path.resolve(root, relativeFile);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Result file path escapes root: ${relativeFile}`);
  }

  return resolved;
}

async function applyResults(root, resultsFile, config) {
  const raw = await readFile(resultsFile, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const line of lines) {
    let record;

    try {
      record = JSON.parse(line);
    } catch {
      failed += 1;
      continue;
    }

    if (record.error || !Array.isArray(record.summary) || !Array.isArray(record.tags)) {
      skipped += 1;
      continue;
    }

    try {
      const file = resolveResultFile(root, record.file);
      const markdown = await readFile(file, "utf8");
      const nextMarkdown = upsertSummarySection(upsertFrontmatter(markdown, record.summary, record.tags, config), record.summary);

      if (nextMarkdown !== markdown) {
        await writeFile(file, `${nextMarkdown.trim()}\n`, "utf8");
        applied += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`Failed to apply ${record.file || "(unknown)"}: ${error.message}`);
    }
  }

  console.log(`Applied ${applied} result records from ${resultsFile}. Skipped ${skipped}. Failed ${failed}.`);
}

async function writeEnrichmentResult({ root, file, markdown, post, result, config, args, resultsFile }) {
  const relativeFile = path.relative(root, file);

  await appendJsonl(resultsFile, {
    file: relativeFile,
    summary: result.summary,
    tags: result.tags,
    provider: config.mode === "local" ? "local-preview" : config.providerId,
    model: config.model || "local-preview",
    generated_at: new Date().toISOString(),
  });

  if (args["no-apply"]) {
    return true;
  }

  const nextMarkdown = upsertSummarySection(upsertFrontmatter(markdown, result.summary, result.tags, config), result.summary);

  if (nextMarkdown !== markdown) {
    await writeFile(file, `${nextMarkdown.trim()}\n`, "utf8");
    return true;
  }

  return false;
}

async function writeErrorResult({ root, file, error, config, resultsFile }) {
  await appendJsonl(resultsFile, {
    file: path.relative(root, file),
    error: error.message,
    provider: config.mode === "local" ? "local-preview" : config.providerId,
    model: config.model || "local-preview",
    generated_at: new Date().toISOString(),
  });
}

async function withRetry(task, retries) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        console.warn(`Retrying after LLM error (${attempt + 1}/${retries}): ${error.message}`);
      }
    }
  }

  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadSettings(env);
  const root = path.resolve(args.root || settings.obsidianRootFolder || env.SNS_READER_OBSIDIAN_FOLDER || DEFAULT_MARKDOWN_ROOT);
  const platform = args.platform || "all";
  const limit = args.limit ? Number(args.limit) : Number.POSITIVE_INFINITY;
  const retries = args.retries ? Number(args.retries) : 1;
  const config = getLlmConfig(env, settings, args);
  const batchSize =
    config.mode === "ollama" && args["batch-size"] ? Math.max(1, Number(args["batch-size"]) || 1) : 1;
  const resultsFile = args["results-file"] ? path.resolve(workspaceRoot, args["results-file"]) : "";
  const applyOnlyFile = args["apply-results"] ? path.resolve(workspaceRoot, args["apply-results"]) : "";

  if (applyOnlyFile) {
    await applyResults(root, applyOnlyFile, config);
    return;
  }

  const files = (await walkMarkdownFiles(root)).sort();
  let updated = 0;
  let skipped = 0;
  let alreadyEnriched = 0;
  let failed = 0;
  let candidateIndex = 0;
  const pendingBatch = [];

  console.log(
    config.mode === "local"
      ? `Enriching Markdown with local preview under ${root}.`
      : `Enriching Markdown with ${config.providerId} (${config.model}) under ${root}.`
  );

  async function flushBatch() {
    if (!pendingBatch.length) {
      return;
    }

    const batch = pendingBatch.splice(0, pendingBatch.length);
    const label = `${path.relative(root, batch[0].file)} ... ${path.relative(root, batch[batch.length - 1].file)}`;
    console.log(`Enriching batch of ${batch.length}: ${label}.`);

    try {
      const resultMap = await enrichBatchResilient(
        config,
        batch.map((item) => item.post),
        retries
      );

      for (const item of batch) {
        const result = resultMap.get(item.post.id);
        const changed = await writeEnrichmentResult({
          root,
          file: item.file,
          markdown: item.markdown,
          post: item.post,
          result,
          config,
          args,
          resultsFile,
        });

        if (changed) {
          updated += 1;
        }

        console.log(args["no-apply"] ? `Generated ${path.relative(root, item.file)}.` : `Updated ${path.relative(root, item.file)}.`);
      }
    } catch (error) {
      failed += batch.length;

      for (const item of batch) {
        await writeErrorResult({ root, file: item.file, error, config, resultsFile });
      }

      console.error(`Failed batch of ${batch.length}: ${error.message}`);
    }
  }

  for (const file of files) {
    if (updated + pendingBatch.length >= limit) {
      break;
    }

    if (isArchivedFile(root, file)) {
      continue;
    }

    const markdown = await readFile(file, "utf8");

    if (!isIncludedPlatform(markdown, platform)) {
      continue;
    }

    if (!isIncludedDate(markdown, args)) {
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
    console.log(`Enriching ${path.relative(root, file)}.`);
    const relativeFile = path.relative(root, file);
    const lowInformation = isLowInformationBody(post.body);

    if (batchSize > 1 && !lowInformation && config.mode !== "local") {
      candidateIndex += 1;
      pendingBatch.push({
        file,
        markdown,
        post: {
          ...post,
          id: `p${candidateIndex}`,
        },
      });

      if (pendingBatch.length >= batchSize) {
        await flushBatch();
      }

      continue;
    }

    try {
      const result = lowInformation
        ? lowInformationFallback(post)
        : config.mode === "local"
          ? localFallback(post.title, post.body)
          : await withRetry(() => enrichWithLlm(config, post), retries);

      const changed = await writeEnrichmentResult({
        root,
        file,
        markdown,
        post,
        result,
        config,
        args,
        resultsFile,
      });

      if (changed) {
        updated += 1;
      }

      console.log(args["no-apply"] ? `Generated ${relativeFile}.` : `Updated ${relativeFile}.`);
    } catch (error) {
      failed += 1;
      await writeErrorResult({ root, file, error, config, resultsFile });
      console.error(`Failed ${relativeFile}: ${error.message}`);
    }
  }

  await flushBatch();

  console.log(
    `Updated ${updated} Markdown files under ${root}. Skipped ${skipped} empty-body files. Already enriched ${alreadyEnriched} files. Failed ${failed} files.`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
