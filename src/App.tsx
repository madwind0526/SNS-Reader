import {
  Archive,
  Database,
  Bot,
  Eye,
  Facebook,
  FileText,
  FolderOpen,
  GitBranch,
  Instagram,
  KeyRound,
  ListFilter,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Rss,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Tags,
  Trash2,
  Twitter,
  X,
  Youtube
} from "lucide-react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultSettings, fieldLabels, pdfStyleLabels, platformLabels } from "./settings/defaults";
import { getAvailableLlmProviders, getPreferredLlmProvider } from "./settings/llm";
import { clearSettings, loadSettings, loadSettingsFile, saveSettings } from "./settings/storage";
import type { AppSettings, ExportField, LlmProviderOption, PdfStyleTarget, PdfTextStyle, SnsAccountConfig, SnsPlatform } from "./types/domain";

type ViewMode = "sns-read" | "pdf-write" | "settings" | "mesh-view";
type AccountFilter = "total" | string;
type PdfModalMode = "viewer" | "creator" | null;
type ConfirmModalMode = "reset" | null;
type SidebarModalMode = "search" | "filter" | "query" | "import" | null;
type LlmEnvStatus = Record<string, boolean>;
type LlmEnvValues = Record<string, string>;
const MASKED_SECRET_VALUE = "****************";
const importablePlatforms: SnsPlatform[] = ["facebook", "instagram", "threads", "youtube"];

interface CardFilters {
  imagesOnly: boolean;
  commentsOnly: boolean;
  tagsOnly: boolean;
  platforms: SnsPlatform[];
  dateFrom: string;
  dateTo: string;
  connectionMin: number;
  connectionMax: number;
  commentAuthor: string;
  tagText: string;
}

interface ConvertedPost {
  id: string;
  accountId: string;
  title: string;
  platform: SnsPlatform;
  platformLabel: string;
  date: string;
  dateIso: string;
  filePath: string;
  bodyPreview?: string;
  summary: string;
  summaryLines?: string[];
  imageCount: number;
  commentCount: number;
  commentsText?: string;
  reactionText?: string;
  commentAuthors: string[];
  tags: string[];
  body?: string;
  imageUrls?: string[];
  sourceUrl?: string;
  thumbnailUrl?: string;
}

interface LlmConfigDraft {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerLabel: string;
}

interface PdfBook {
  id: string;
  title: string;
  dateRange: string;
  pageCount: number;
  filePath: string;
  url?: string;
  coverUrl?: string;
  createdAt: string;
  postCount?: number;
}

interface LlmQueryResult {
  answer: string;
  sources: ConvertedPost[];
}

const emptyAccount: Omit<SnsAccountConfig, "id"> = {
  platform: "instagram",
  label: "",
  url: "",
  requiresLogin: false,
  exportToObsidian: true,
  username: "",
  credentialKey: ""
};

function validatePdfYearRangeList(value: string) {
  const entries = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const match = entry.match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);

    if (!match) {
      return `년도 형식이 올바르지 않습니다: ${entry}`;
    }

    const startYear = Number(match[1]);
    const endYear = Number(match[2] || match[1]);

    if (startYear > endYear) {
      return `년도 범위는 앞의 연도가 뒤의 연도보다 클 수 없습니다: ${entry}`;
    }
  }

  return "";
}

const BUILD_VERSION = "Build v0.1.0";

const sampleConvertedPosts: ConvertedPost[] = [
  {
    id: "facebook-2026-07-22",
    accountId: "sample-facebook",
    title: "Family archive note",
    platform: "facebook",
    platformLabel: "Facebook",
    date: "2026.07.22 15:30",
    dateIso: "2026-07-22",
    filePath: "SNS/facebook/2026-07/2026-07-22_1530_facebook_1042.md",
    summary: "A Facebook post converted into Markdown with comments, images, and source metadata.",
    imageCount: 4,
    commentCount: 18,
    commentAuthors: ["Minji", "Dad", "Sora"],
    tags: ["Facebook", "Archive", "Family"]
  },
  {
    id: "instagram-2026-07-22",
    accountId: "sample-instagram",
    title: "Sample photo journal",
    platform: "instagram",
    platformLabel: "Instagram",
    date: "2026.07.22 18:21",
    dateIso: "2026-07-22",
    filePath: "SNS/instagram/2026-07/2026-07-22_1821_instagram_Cx9ab12.md",
    summary: "Images are stored in a post-specific folder and represented with a collage preview.",
    imageCount: 3,
    commentCount: 12,
    commentAuthors: ["Jin", "Mina"],
    tags: ["Photo", "SNS", "Archive"]
  },
  {
    id: "youtube-2026-07-21",
    accountId: "sample-youtube",
    title: "Video notes and comments",
    platform: "youtube",
    platformLabel: "YouTube",
    date: "2026.07.21 09:40",
    dateIso: "2026-07-21",
    filePath: "SNS/youtube/2026-07/2026-07-21_0940_youtube_ab12cd.md",
    summary: "Video description, transcript summary, and selected comments are prepared for PDF export.",
    imageCount: 1,
    commentCount: 34,
    commentAuthors: ["Alex", "StudyMate", "Jin"],
    tags: ["Video", "Summary", "Comments"]
  },
  {
    id: "instagram-2026-07-20",
    accountId: "sample-instagram",
    title: "Trip collage",
    platform: "instagram",
    platformLabel: "Instagram",
    date: "2026.07.20 11:03",
    dateIso: "2026-07-20",
    filePath: "SNS/instagram/2026-07/2026-07-20_1103_instagram_Ef34gh.md",
    summary: "Multiple attached images were merged into a preview collage while preserving originals.",
    imageCount: 6,
    commentCount: 7,
    commentAuthors: ["Mina", "TravelBuddy"],
    tags: ["Travel", "Collage"]
  },
  {
    id: "facebook-2026-07-18",
    accountId: "sample-facebook",
    title: "",
    platform: "facebook",
    platformLabel: "Facebook",
    date: "2026.07.18 20:15",
    dateIso: "2026-07-18",
    filePath: "SNS/facebook/2026-07/2026-07-18_2015_facebook_8891.md",
    summary: "Untitled posts still keep date, body, source URL, comments, and optional tags.",
    imageCount: 0,
    commentCount: 3,
    commentAuthors: ["Dad"],
    tags: ["Timeline", "Note"]
  },
  {
    id: "youtube-2026-07-15",
    accountId: "sample-youtube",
    title: "Channel archive sample",
    platform: "youtube",
    platformLabel: "YouTube",
    date: "2026.07.15 14:50",
    dateIso: "2026-07-15",
    filePath: "SNS/youtube/2026-07/2026-07-15_1450_youtube_zz90yy.md",
    summary: "Each video post starts as its own Markdown note and can later begin on a new PDF page.",
    imageCount: 1,
    commentCount: 28,
    commentAuthors: ["StudyMate", "Alex"],
    tags: ["YouTube", "Book"]
  }
];

const samplePdfBooks: PdfBook[] = [
  {
    id: "pdf-2025",
    title: "SNS Archive 2025",
    dateRange: "2025.01.01 - 2025.12.31",
    pageCount: 186,
    filePath: "PDFExports/yearly/SNS_2025.pdf",
    createdAt: "2026.07.20"
  },
  {
    id: "pdf-trip",
    title: "Travel Posts",
    dateRange: "2026.05.01 - 2026.07.15",
    pageCount: 94,
    filePath: "PDFExports/date-range/SNS_2026-05-01_2026-07-15.pdf",
    createdAt: "2026.07.21"
  }
];

const emptyCardFilters: CardFilters = {
  imagesOnly: false,
  commentsOnly: false,
  tagsOnly: false,
  platforms: [],
  dateFrom: "",
  dateTo: "",
  connectionMin: 0,
  connectionMax: 0,
  commentAuthor: "",
  tagText: ""
};

const genericMeshTags = new Set(["sns", "facebook", "instagram", "threads", "youtube", "x", "naverblog", "naver-blog"]);
const meshVisibleEdgeLimit = 360;
const meshCanvasSize = 1000;
const meshPanMargin = 180;

type MeshEdge = {
  from: string;
  to: string;
  sharedTags: string[];
  weight: number;
};

function getSemanticTags(post: ConvertedPost) {
  const sourceTags = Array.isArray(post.tags) ? post.tags : [];

  return Array.from(new Set(sourceTags
    .map((tag) => String(tag).replace(/^#/, "").trim())
    .filter((tag) => tag && !genericMeshTags.has(tag.toLowerCase()))));
}

function getPostKey(post: ConvertedPost, fallback = "") {
  return String(post.id || post.filePath || post.title || fallback);
}

function getEdgeKey(from: string, to: string) {
  return from < to ? `${from}---${to}` : `${to}---${from}`;
}

function selectBalancedMeshEdges(edges: MeshEdge[], limit: number, focusTag?: string | null) {
  const selected: MeshEdge[] = [];
  const selectedKeys = new Set<string>();
  const nodeVisualCounts = new Map<string, number>();
  const tagVisualCounts = new Map<string, number>();
  const tagLimit = focusTag ? limit : Math.max(18, Math.ceil(limit / 10));
  const nodeCaps = [2, 4, 7, Number.POSITIVE_INFINITY];

  for (const nodeCap of nodeCaps) {
    for (const edge of edges) {
      if (selected.length >= limit) {
        return selected;
      }

      if (focusTag && !edge.sharedTags.includes(focusTag)) {
        continue;
      }

      const key = getEdgeKey(edge.from, edge.to);
      if (selectedKeys.has(key)) {
        continue;
      }

      const primaryTag = focusTag ?? edge.sharedTags[0] ?? "";
      const fromCount = nodeVisualCounts.get(edge.from) ?? 0;
      const toCount = nodeVisualCounts.get(edge.to) ?? 0;
      const currentTagCount = tagVisualCounts.get(primaryTag) ?? 0;

      if (fromCount >= nodeCap || toCount >= nodeCap || (!focusTag && currentTagCount >= tagLimit)) {
        continue;
      }

      selected.push(edge);
      selectedKeys.add(key);
      nodeVisualCounts.set(edge.from, fromCount + 1);
      nodeVisualCounts.set(edge.to, toCount + 1);
      tagVisualCounts.set(primaryTag, currentTagCount + 1);
    }
  }

  return selected;
}

function getTagCounts(posts: ConvertedPost[]) {
  const tagCounts = new Map<string, number>();

  posts.forEach((post) => {
    getSemanticTags(post).forEach((tag) => {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    });
  });

  return tagCounts;
}

function hashToUnit(value: string, salt: number) {
  let hash = 2166136261 ^ salt;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildConnectionCounts(posts: ConvertedPost[]) {
  const connectedPostIds = new Map<string, Set<string>>();
  const postsByTag = new Map<string, string[]>();

  posts.forEach((post, index) => {
    const postId = getPostKey(post, String(index));

    connectedPostIds.set(postId, new Set());

    getSemanticTags(post).forEach((tag) => {
      const existingPosts = postsByTag.get(tag) ?? [];
      existingPosts.push(postId);
      postsByTag.set(tag, existingPosts);
    });
  });

  postsByTag.forEach((postIds) => {
    for (let leftIndex = 0; leftIndex < postIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < postIds.length; rightIndex += 1) {
        connectedPostIds.get(postIds[leftIndex])?.add(postIds[rightIndex]);
        connectedPostIds.get(postIds[rightIndex])?.add(postIds[leftIndex]);
      }
    }
  });

  return new Map(Array.from(connectedPostIds.entries()).map(([postId, connectedIds]) => [postId, connectedIds.size]));
}

function splitCommaTerms(value: string) {
  return value
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function isValidDateInput(value: string) {
  if (!value) {
    return true;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function buildLocalLlmPreviewAnswer(
  question: string,
  posts: ConvertedPost[],
  provider: LlmProviderOption
): LlmQueryResult {
  const normalizedQuestion = question.trim();
  const tokens = normalizedQuestion
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'`~|\\/]+/)
    .filter((token) => token.length > 1);

  const scoredPosts = posts
    .map((post) => {
      const searchableText = [post.title, post.platformLabel, post.summary, post.filePath, ...post.tags]
        .join(" ")
        .toLowerCase();
      const score = tokens.reduce((total, token) => total + (searchableText.includes(token) ? 1 : 0), 0);

      return { post, score };
    })
    .sort((left, right) => right.score - left.score);

  const sources = scoredPosts
    .filter((item) => item.score > 0)
    .map((item) => item.post)
    .slice(0, 3);
  const fallbackSources = sources.length > 0 ? sources : posts.slice(0, 3);
  const sourceSummary = fallbackSources
    .map((post) => `${post.title || "Untitled Post"} (${post.platformLabel}, ${post.date})`)
    .join("; ");
  const answer =
    posts.length === 0
      ? "No generated SNS Markdown cards are available in the current scope yet. After folder scanning is connected, the LLM will answer from those Markdown files."
      : `${provider.label} is selected. LLM backend is not connected yet, so this is a local preview. For "${normalizedQuestion}", the most relevant current Markdown cards are: ${sourceSummary}. When the LLM pipeline is connected, this panel will send the question, retrieved Markdown chunks, and source paths to the selected model, then return a cited answer.`;

  return {
    answer,
    sources: fallbackSources
  };
}

function getProviderEnvKeys(provider: LlmProviderOption) {
  if (provider.id === "local-preview") {
    return [];
  }

  if (provider.id === "custom") {
    return ["SNS_READER_LLM_API_KEY", "SNS_READER_LLM_BASE_URL", "SNS_READER_LLM_MODEL"];
  }

  if (provider.id.startsWith("ollama")) {
    return ["OLLAMA_BASE_URL"];
  }

  return provider.serverKeyName ? [provider.serverKeyName] : [];
}

function getProviderModelEnvKey(provider: LlmProviderOption) {
  switch (provider.id) {
    case "openai-frontier":
      return "VITE_LLM_OPENAI_FRONTIER_MODEL";
    case "gemini-flash":
      return "VITE_LLM_GEMINI_FLASH_MODEL";
    case "ollama":
      return "VITE_LLM_OLLAMA_MODEL";
    case "ollama-gemma":
      return "VITE_LLM_OLLAMA_GEMMA_MODEL";
    case "custom":
      return "SNS_READER_LLM_MODEL";
    default:
      return "SNS_READER_LLM_MODEL";
  }
}

function getProviderBaseUrlEnvKey(provider: LlmProviderOption) {
  if (provider.id.startsWith("ollama")) {
    return "OLLAMA_BASE_URL";
  }

  if (provider.id === "openai-frontier") {
    return "OPENAI_BASE_URL";
  }

  if (provider.id === "custom") {
    return "SNS_READER_LLM_BASE_URL";
  }

  return "";
}

function getProviderApiKeyEnvKey(provider: LlmProviderOption) {
  return getProviderEnvKeys(provider).find((key) => key.includes("API_KEY")) ?? "";
}

function isProviderConfigured(provider: LlmProviderOption, envStatus: LlmEnvStatus) {
  const requiredKeys = getProviderEnvKeys(provider);

  return requiredKeys.length === 0 || requiredKeys.every((key) => envStatus[key]);
}

function getProviderDisplayModel(provider: LlmProviderOption, envValues: LlmEnvValues) {
  return envValues[getProviderModelEnvKey(provider)] || provider.modelLabel;
}

function getProviderDisplayName(provider: LlmProviderOption, envValues: LlmEnvValues) {
  if (provider.id === "local-preview") {
    return provider.label;
  }

  return `${provider.label} - ${getProviderDisplayModel(provider, envValues)}`;
}

function getReadablePreviewColor(color: string, theme: AppSettings["theme"]) {
  const match = String(color || "").match(/^#?([0-9a-f]{6})$/i);

  if (!match) {
    return theme === "dark" ? "#f3f1ea" : "#202124";
  }

  const hex = match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

  if (theme === "dark" && luminance < 0.36) {
    return "#f3f1ea";
  }

  if (theme === "light" && luminance > 0.78) {
    return "#202124";
  }

  return color;
}

function detectPlatformFromArchiveName(fileName: string): SnsPlatform | null {
  const lowerName = fileName.toLowerCase();

  if (lowerName.includes("instagram")) {
    return "instagram";
  }

  if (lowerName.includes("threads")) {
    return "threads";
  }

  if (lowerName.includes("facebook")) {
    return "facebook";
  }

  if (lowerName.includes("youtube") || lowerName.includes("takeout")) {
    return "youtube";
  }

  if (lowerName.includes("twitter") || lowerName.includes("x-archive")) {
    return "x";
  }

  return null;
}

export function App() {
  const [view, setView] = useState<ViewMode>("sns-read");
  const [activeAccount, setActiveAccount] = useState<AccountFilter>("total");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [accountDraft, setAccountDraft] = useState<Omit<SnsAccountConfig, "id">>(emptyAccount);
  const [editingAccount, setEditingAccount] = useState<SnsAccountConfig | null>(null);
  const [pdfModalMode, setPdfModalMode] = useState<PdfModalMode>(null);
  const [confirmModalMode, setConfirmModalMode] = useState<ConfirmModalMode>(null);
  const [sidebarModalMode, setSidebarModalMode] = useState<SidebarModalMode>(null);
  const [selectedPdf, setSelectedPdf] = useState<PdfBook | null>(null);
  const [cardFilters, setCardFilters] = useState<CardFilters>(emptyCardFilters);
  const [llmQuestion, setLlmQuestion] = useState("");
  const [llmResult, setLlmResult] = useState<LlmQueryResult | null>(null);
  const [llmEnvStatus, setLlmEnvStatus] = useState<LlmEnvStatus>({});
  const [llmEnvValues, setLlmEnvValues] = useState<LlmEnvValues>({});
  const [editingLlmProvider, setEditingLlmProvider] = useState<LlmProviderOption | null>(null);
  const [convertedPosts, setConvertedPosts] = useState<ConvertedPost[]>([]);
  const [pdfBooks, setPdfBooks] = useState<PdfBook[]>([]);
  const [selectedPost, setSelectedPost] = useState<ConvertedPost | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ConvertedPost | null>(null);
  const [deletePdfCandidate, setDeletePdfCandidate] = useState<PdfBook | null>(null);
  const [isSnsReading, setIsSnsReading] = useState(false);
  const [isImportingArchive, setIsImportingArchive] = useState(false);
  const [isEnrichingMarkdown, setIsEnrichingMarkdown] = useState(false);
  const [isUpdatingSns, setIsUpdatingSns] = useState(false);
  const [isCreatingPdf, setIsCreatingPdf] = useState(false);
  const [saveStatus, setSaveStatus] = useState("No changes saved in this session.");
  const [systemMessage, setSystemMessage] = useState("Ready. Waiting for SNS conversion tasks.");
  const llmProviders = useMemo(() => getAvailableLlmProviders(), []);
  const selectedLlmProvider = useMemo(
    () => getPreferredLlmProvider(llmProviders, settings.selectedLlmProvider),
    [llmProviders, settings.selectedLlmProvider]
  );

  const storagePreview = useMemo(() => {
    if (settings.storageLayout === "platform-month") {
      return "SNS/instagram/2026-07/2026-07-22_1530_instagram_post-id.md";
    }

    return "SNS/2026-07/instagram/2026-07-22_1530_instagram_post-id.md";
  }, [settings.storageLayout]);

  const refreshConvertedPosts = async ({ silent = false } = {}) => {
    try {
      const response = await fetch(`/api/markdown-cards?ts=${Date.now()}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Markdown scan failed with ${response.status}`);
      }

      const payload = (await response.json()) as { cards?: ConvertedPost[]; root?: string };
      const cards = payload.cards ?? [];

      setConvertedPosts(cards);
      if (!silent) {
        setSystemMessage(`Loaded ${cards.length} converted Markdown files from ${payload.root ?? "SNS folder"}.`);
      }
    } catch (error) {
      if (!silent) {
        setConvertedPosts([]);
        setSystemMessage(error instanceof Error ? error.message : "Markdown scan failed.");
      }
    }
  };

  const refreshLlmEnvStatus = async () => {
    try {
      const response = await fetch(`/api/env?ts=${Date.now()}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Env scan failed with ${response.status}`);
      }

      const payload = (await response.json()) as { keys?: LlmEnvStatus; values?: LlmEnvValues };

      setLlmEnvStatus(payload.keys ?? {});
      setLlmEnvValues(payload.values ?? {});
    } catch {
      setLlmEnvStatus({});
      setLlmEnvValues({});
    }
  };

  const refreshPdfBooks = async ({ silent = false } = {}) => {
    try {
      const response = await fetch(`/api/pdf-books?ts=${Date.now()}`, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`PDF scan failed with ${response.status}`);
      }

      const payload = (await response.json()) as { books?: PdfBook[]; root?: string };
      const books = payload.books ?? [];

      setPdfBooks(books);
      if (!silent) {
        setSystemMessage(`Loaded ${books.length} PDF files from ${payload.root ?? "PDF folder"}.`);
      }
    } catch (error) {
      setPdfBooks([]);
      if (!silent) {
        setSystemMessage(error instanceof Error ? error.message : "PDF scan failed.");
      }
    }
  };

  const saveLlmEnv = async (provider: LlmProviderOption, draft: LlmConfigDraft) => {
    const updates: Record<string, string> = {};
    const modelKey = getProviderModelEnvKey(provider);
    const baseUrlKey = getProviderBaseUrlEnvKey(provider);
    const nextApiKey = draft.apiKey.trim();
    const nextProviderLabel = draft.providerLabel.trim();
    const savedProviderLabel = nextProviderLabel || provider.label;
    const shouldReplaceApiKey = Boolean(nextApiKey) && nextApiKey !== MASKED_SECRET_VALUE;

    if (modelKey && draft.model.trim()) {
      updates[modelKey] = draft.model.trim();
    }

    if (baseUrlKey && draft.baseUrl.trim()) {
      updates[baseUrlKey] = draft.baseUrl.trim();
    }

    if (provider.id === "custom") {
      updates.SNS_READER_LLM_PROVIDER = "custom";
      updates.VITE_LLM_CUSTOM_PROVIDER_LABEL = savedProviderLabel;
      updates.SNS_READER_LLM_MODEL = draft.model.trim();
      updates.SNS_READER_LLM_BASE_URL = draft.baseUrl.trim();
      if (shouldReplaceApiKey) {
        updates.SNS_READER_LLM_API_KEY = nextApiKey;
      }
    } else if (provider.serverKeyName && shouldReplaceApiKey && !provider.id.startsWith("ollama")) {
      updates[provider.serverKeyName] = nextApiKey;
    }

    if (Object.keys(updates).length === 0) {
      selectLlmProvider(provider.id);
      setEditingLlmProvider(null);
      setSystemMessage(`${savedProviderLabel} \uBAA8\uB378\uC744 \uC120\uD0DD\uD588\uC2B5\uB2C8\uB2E4.`);
      return;
    }

    const response = await fetch("/api/env", {
      body: JSON.stringify({ updates }),
      headers: {
        "Content-Type": "application/json"
      },
      method: "PUT"
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;

      throw new Error(payload?.error || "LLM env save failed.");
    }

    selectLlmProvider(provider.id);
    setEditingLlmProvider(null);
    await refreshLlmEnvStatus();
    setSystemMessage(`${savedProviderLabel} \uC124\uC815\uC744 .env\uC5D0 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.`);
  };

  useEffect(() => {
    let mounted = true;

    const loadInitialData = async () => {
      const fileSettings = await loadSettingsFile();

      if (mounted && fileSettings) {
        setSettings(fileSettings);
      }

      if (mounted) {
        await refreshConvertedPosts();
        await refreshPdfBooks({ silent: true });
        await refreshLlmEnvStatus();
      }
    };

    void loadInitialData();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    setSelectedPost((current) => {
      if (!current) {
        return current;
      }

      return convertedPosts.find((post) => post.id === current.id) ?? null;
    });
  }, [convertedPosts]);

  useEffect(() => {
    const refreshVisibleCards = () => {
      if (document.visibilityState === "visible") {
        void refreshConvertedPosts({ silent: true });
      }
    };
    const intervalId = window.setInterval(refreshVisibleCards, 5000);

    window.addEventListener("focus", refreshVisibleCards);
    document.addEventListener("visibilitychange", refreshVisibleCards);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleCards);
      document.removeEventListener("visibilitychange", refreshVisibleCards);
    };
  }, []);

  const querySourcePosts = useMemo(() => {
    return convertedPosts.filter((post) => {
      const accountMatches = activeAccount === "total" || post.accountId === activeAccount;

      return accountMatches;
    });
  }, [activeAccount, convertedPosts]);

  const connectionCounts = useMemo(() => buildConnectionCounts(querySourcePosts), [querySourcePosts]);
  const maxConnectionCount = useMemo(
    () => Math.max(0, ...Array.from(connectionCounts.values())),
    [connectionCounts]
  );

  const visiblePosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return querySourcePosts.filter((post) => {
      const commentAuthorTerms = splitCommaTerms(cardFilters.commentAuthor);
      const tagTerms = splitCommaTerms(cardFilters.tagText);
      const connectionCount = connectionCounts.get(getPostKey(post)) ?? 0;
      const connectionMax = cardFilters.connectionMax > 0 ? cardFilters.connectionMax : Number.POSITIVE_INFINITY;
      const filterMatches =
        (!cardFilters.imagesOnly || post.imageCount > 0) &&
        (!cardFilters.commentsOnly || post.commentCount > 0) &&
        (!cardFilters.tagsOnly || post.tags.length > 0) &&
        (cardFilters.platforms.length === 0 || cardFilters.platforms.includes(post.platform)) &&
        (!cardFilters.dateFrom || post.dateIso >= cardFilters.dateFrom) &&
        (!cardFilters.dateTo || post.dateIso <= cardFilters.dateTo) &&
        connectionCount >= cardFilters.connectionMin &&
        connectionCount <= connectionMax &&
        (commentAuthorTerms.length === 0 ||
          commentAuthorTerms.some((term) =>
            post.commentAuthors.some((author) => author.toLowerCase().includes(term))
          )) &&
        (tagTerms.length === 0 || tagTerms.some((term) => post.tags.some((tag) => tag.toLowerCase().includes(term))));
      const queryMatches =
        !normalizedQuery ||
        [post.title, post.platformLabel, post.summary, post.filePath, ...post.tags]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);

      return filterMatches && queryMatches;
    });
  }, [cardFilters, connectionCounts, query, querySourcePosts]);

  const sidebarItems = useMemo(() => {
    const totalCount = convertedPosts.length;
    const accountItems = settings.accounts.map((account) => ({
      key: account.id,
      label: account.label || platformLabels[account.platform],
      count: convertedPosts.filter((post) => post.accountId === account.id).length,
      icon: getPlatformIcon(account.platform)
    }));

    return [
      {
        key: "total",
        label: "Total",
        count: totalCount,
        icon: <Archive size={20} />
      },
      ...accountItems
    ];
  }, [convertedPosts, settings.accounts]);

  const filterPlatformOptions = useMemo(() => {
    const platforms = new Set<SnsPlatform>();

    settings.accounts.forEach((account) => platforms.add(account.platform));
    convertedPosts.forEach((post) => platforms.add(post.platform));

    return Array.from(platforms).map((platform) => ({
      platform,
      label: platformLabels[platform]
    }));
  }, [convertedPosts, settings.accounts]);

  const hasActiveFilters =
    cardFilters.imagesOnly ||
    cardFilters.commentsOnly ||
    cardFilters.tagsOnly ||
    cardFilters.platforms.length > 0 ||
    cardFilters.connectionMin > 0 ||
    cardFilters.connectionMax > 0 ||
    Boolean(cardFilters.dateFrom || cardFilters.dateTo || cardFilters.commentAuthor.trim() || cardFilters.tagText.trim());
  const hasActiveLlmQuery = Boolean(llmQuestion.trim() || llmResult);

  const updateSettings = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
    setSettings((current) => ({
      ...current,
      [key]: value
    }));
    setSaveStatus("Unsaved changes.");
    setSystemMessage("Settings modified. Save when ready.");
  };

  const toggleField = (target: "optionalFields" | "pdfFields", field: ExportField) => {
    setSettings((current) => {
      const fields = current[target];
      const nextFields = fields.includes(field)
        ? fields.filter((item) => item !== field)
        : [...fields, field];

      return {
        ...current,
        [target]: nextFields
      };
    });
    setSaveStatus("Unsaved changes.");
    setSystemMessage("Field options updated.");
  };

  const updatePdfStyle = <Key extends keyof PdfTextStyle>(target: PdfStyleTarget, key: Key, value: PdfTextStyle[Key]) => {
    setSettings((current) => ({
      ...current,
      pdfStyles: {
        ...current.pdfStyles,
        [target]: {
          ...current.pdfStyles[target],
          [key]: value
        }
      }
    }));
    setSaveStatus("Unsaved changes.");
    setSystemMessage("PDF style updated.");
  };

  const handleSave = () => {
    saveSettings(settings);
    void refreshConvertedPosts();
    const savedAt = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    setSaveStatus(`Saved locally at ${savedAt}.`);
    setSystemMessage(`Settings saved locally at ${savedAt}.`);
  };

  const handleReset = () => {
    clearSettings();
    setSettings(defaultSettings);
    setAccountDraft(emptyAccount);
    setEditingAccount(null);
    setConfirmModalMode(null);
    setSaveStatus("Settings reset. Save to keep defaults.");
    setSystemMessage("Settings reset to defaults.");
  };

  const addAccount = () => {
    if (!accountDraft.url.trim()) {
      setSystemMessage("Account URL is required.");
      return;
    }

    const account: SnsAccountConfig = {
      ...accountDraft,
      id: `${accountDraft.platform}-${Date.now()}`,
      label: accountDraft.label.trim() || platformLabels[accountDraft.platform],
      url: accountDraft.url.trim(),
      exportToObsidian: accountDraft.exportToObsidian
    };

    setSettings((current) => ({
      ...current,
      accounts: [...current.accounts, account]
    }));
    setAccountDraft(emptyAccount);
    setSaveStatus("Unsaved changes.");
    setSystemMessage("SNS account added.");
  };

  const removeAccount = (id: string) => {
    setSettings((current) => ({
      ...current,
      accounts: current.accounts.filter((account) => account.id !== id)
    }));
    setActiveAccount((current) => (current === id ? "total" : current));
    if (editingAccount?.id === id) {
      setEditingAccount(null);
    }
    setSaveStatus("Unsaved changes.");
    setSystemMessage("SNS account removed.");
  };

  const editAccount = (id: string) => {
    const account = settings.accounts.find((item) => item.id === id);

    if (!account) {
      return;
    }

    setEditingAccount({
      ...account,
      username: account.username ?? "",
      credentialKey: account.credentialKey ?? ""
    });
    setSystemMessage("Editing SNS account.");
  };

  const cancelAccountEdit = () => {
    setEditingAccount(null);
    setSystemMessage("Account editing canceled.");
  };

  const updateEditingAccount = <Key extends keyof SnsAccountConfig>(key: Key, value: SnsAccountConfig[Key]) => {
    setEditingAccount((current) => (current ? { ...current, [key]: value } : current));
  };

  const confirmAccountEdit = () => {
    if (!editingAccount) {
      return;
    }

    if (!editingAccount.url.trim()) {
      setSystemMessage("Account URL is required.");
      return;
    }

    const updatedAccount: SnsAccountConfig = {
      ...editingAccount,
      label: editingAccount.label.trim() || platformLabels[editingAccount.platform],
      url: editingAccount.url.trim()
    };

    setSettings((current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === updatedAccount.id ? updatedAccount : account
      )
    }));
    setEditingAccount(null);
    setSaveStatus("Unsaved changes.");
    setSystemMessage("SNS account updated.");
  };

  const toggleAccountExport = (id: string, exportToObsidian: boolean) => {
    setSettings((current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === id ? { ...account, exportToObsidian } : account
      )
    }));
    setSaveStatus("Unsaved changes.");
    setSystemMessage(exportToObsidian ? "Account enabled for Markdown export." : "Account ignored for Markdown export.");
  };

  const selectLlmProvider = (providerId: string) => {
    setSettings((current) => {
      const nextSettings = {
        ...current,
        selectedLlmProvider: providerId
      };

      saveSettings(nextSettings);
      return nextSettings;
    });
    setSaveStatus("LLM default saved locally.");
    setSystemMessage("LLM provider saved as the default for Query.");
  };

  const restartServer = async () => {
    setSystemMessage("Restarting local server. If the page disconnects, wait a moment and refresh.");

    try {
      await fetch("/api/server/restart", {
        method: "POST"
      });
    } catch {
      setSystemMessage("Restart signal sent. Refresh the app after the server comes back.");
    }
  };

  const openView = (nextView: ViewMode, message: string) => {
    setView(nextView);
    if (nextView === "pdf-write") {
      void refreshPdfBooks({ silent: true });
    }
    setSystemMessage(message);
  };

  const createPdfBook = async () => {
    if (isCreatingPdf) {
      return;
    }

    if (settings.pdfSplitMode === "year") {
      const yearError = validatePdfYearRangeList(settings.pdfYear);

      if (yearError) {
        setSystemMessage(yearError);
        return;
      }
    }

    setIsCreatingPdf(true);
    setSystemMessage("PDF 생성 중입니다. Markdown, 이미지, 요약 정보를 책 형식으로 배치하고 있습니다...");

    try {
      const response = await fetch("/api/create-pdf", {
        body: JSON.stringify({ settings }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      const payload = (await response.json()) as { book?: PdfBook; books?: PdfBook[]; message?: string; error?: string };

      if (!response.ok || payload.error) {
        throw new Error(payload.error || `PDF creation failed with ${response.status}`);
      }

      await refreshPdfBooks({ silent: true });
      const createdBook = payload.books?.[0] ?? payload.book ?? null;
      setSelectedPdf(createdBook);
      setPdfModalMode(createdBook ? "viewer" : null);
      setSystemMessage(payload.message || "PDF 생성이 완료되었습니다.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "PDF 생성에 실패했습니다.");
    } finally {
      setIsCreatingPdf(false);
    }
  };

  const runSnsRead = async () => {
    if (isSnsReading) {
      return;
    }

    setView("sns-read");
    setIsSnsReading(true);
    setSystemMessage("SNS Read started. Importing, validating, and enriching Markdown files...");

    try {
      const response = await fetch("/api/sns-read", {
        method: "POST"
      });
      const payload = (await response.json()) as { message?: string; error?: string; output?: string };

      if (!response.ok || payload.error) {
        throw new Error(payload.error || `SNS Read failed with ${response.status}`);
      }

      await refreshConvertedPosts();
      setSystemMessage(payload.message || "SNS Read complete.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "SNS Read failed.");
    } finally {
      setIsSnsReading(false);
    }
  };

  const runArchiveImport = async (platform: SnsPlatform, zipFile: File, enrich: boolean) => {
    if (isImportingArchive) {
      return;
    }

    setView("sns-read");
    setIsImportingArchive(true);
    setSystemMessage(`${platformLabels[platform]} archive import started. The selected zip is being processed...`);

    try {
      const params = new URLSearchParams({
        platform,
        fileName: zipFile.name,
        enrich: enrich ? "true" : "false"
      });
      const response = await fetch(`/api/import-archive?${params.toString()}`, {
        body: zipFile,
        method: "POST"
      });
      const payload = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Import failed with ${response.status}`);
      }

      await refreshConvertedPosts();
      setSidebarModalMode(null);
      setSystemMessage(payload.message || `${platformLabels[platform]} archive import complete.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "Archive import failed.");
    } finally {
      setIsImportingArchive(false);
    }
  };

  const runMarkdownEnrichment = async () => {
    if (isEnrichingMarkdown) {
      return;
    }

    setView("sns-read");
    setIsEnrichingMarkdown(true);
    setSystemMessage("Summary and TAG enrichment started. Existing enriched Markdown files will be skipped...");

    try {
      const response = await fetch("/api/enrich-markdown", {
        method: "POST"
      });
      const payload = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Enrichment failed with ${response.status}`);
      }

      await refreshConvertedPosts();
      setSystemMessage(payload.message || "Summary and TAG enrichment complete.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "Summary and TAG enrichment failed.");
    } finally {
      setIsEnrichingMarkdown(false);
    }
  };

  const openLoginBrowser = async () => {
    setSystemMessage("로그인 브라우저를 여는 중입니다...");

    try {
      const response = await fetch("/api/login-browser", {
        method: "POST"
      });
      const payload = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Login browser failed with ${response.status}`);
      }

      setSystemMessage(payload.message || "로그인 브라우저를 열었습니다.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "로그인 브라우저를 열지 못했습니다.");
    }
  };

  const runSnsUpdate = async () => {
    if (isUpdatingSns) {
      return;
    }

    setView("sns-read");
    setIsUpdatingSns(true);
    setSystemMessage("SNS Update started. Checking enabled accounts and latest Markdown dates...");

    try {
      const response = await fetch("/api/sns-update", {
        method: "POST"
      });
      const payload = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Update failed with ${response.status}`);
      }

      await refreshConvertedPosts();
      setSystemMessage(payload.message || "SNS Update check complete.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "SNS Update failed.");
    } finally {
      setIsUpdatingSns(false);
    }
  };

  const deletePost = async () => {
    if (!deleteCandidate) {
      return;
    }

    try {
      const response = await fetch(`/api/markdown-card?path=${encodeURIComponent(deleteCandidate.filePath)}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(`Delete failed with ${response.status}`);
      }

      setConvertedPosts((current) => current.filter((post) => post.id !== deleteCandidate.id));
      setSelectedPost((current) => (current?.id === deleteCandidate.id ? null : current));
      setSystemMessage(`${deleteCandidate.title || "Untitled Post"} deleted.`);
      setDeleteCandidate(null);
      void refreshConvertedPosts();
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const deletePdf = async () => {
    if (!deletePdfCandidate) {
      return;
    }

    try {
      const response = await fetch(`/api/pdf-file?path=${encodeURIComponent(deletePdfCandidate.filePath)}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(`PDF delete failed with ${response.status}`);
      }

      setPdfBooks((current) => current.filter((pdf) => pdf.id !== deletePdfCandidate.id));
      setSelectedPdf((current) => (current?.id === deletePdfCandidate.id ? null : current));
      setSystemMessage(`${deletePdfCandidate.title || "PDF"} 파일을 삭제했습니다.`);
      setDeletePdfCandidate(null);
      void refreshPdfBooks({ silent: true });
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "PDF delete failed.");
    }
  };

  return (
    <main className={`app-shell ${settings.theme}`}>
      <TopToolbar
        query={query}
        view={view}
        onQueryChange={setQuery}
        onLoginBrowser={openLoginBrowser}
        onRestartServer={restartServer}
        onSnsRead={runSnsRead}
        onViewChange={openView}
        snsReadBusy={isSnsReading}
      />

      <PlatformSidebar
        activeAccount={activeAccount}
        filterActive={hasActiveFilters}
        enrichBusy={isEnrichingMarkdown}
        items={sidebarItems}
        queryActive={hasActiveLlmQuery}
        searchActive={Boolean(query.trim())}
        updateBusy={isUpdatingSns}
        onEnrich={runMarkdownEnrichment}
        onFilter={() => {
          setSidebarModalMode("filter");
          setSystemMessage("Card filters opened.");
        }}
        onImport={() => {
          setSidebarModalMode("import");
          setSystemMessage("Archive import opened.");
        }}
        onQuery={() => {
          setSidebarModalMode("query");
          setLlmResult(null);
          setSystemMessage("LLM query opened.");
        }}
        onSearch={() => {
          setSidebarModalMode("search");
          setSystemMessage("Search panel opened.");
        }}
        onSelect={setActiveAccount}
        onUpdate={runSnsUpdate}
      />

      <section className="main-window">
        {view === "sns-read" && (
          <ConvertedFileLibrary
            posts={visiblePosts}
            onDeletePost={setDeleteCandidate}
            onOpenPost={(post) => {
              setSelectedPost(post);
              setSystemMessage(`${post.title || "Untitled Post"} opened.`);
            }}
          />
        )}

        {view === "pdf-write" && (
          <PdfWriteView
            pdfBooks={pdfBooks}
            onCreate={() => {
              setPdfModalMode("creator");
              setSelectedPdf(null);
              setSystemMessage("PDF 생성 설정을 열었습니다.");
            }}
            onDeletePdf={setDeletePdfCandidate}
            onOpenPdf={(pdf) => {
              setSelectedPdf(pdf);
              setPdfModalMode("viewer");
              setSystemMessage(`${pdf.title} 미리보기를 열었습니다.`);
            }}
          />
        )}

        {view === "mesh-view" && <MeshView posts={visiblePosts} />}

        {view === "settings" && (
          <SettingsView
            accountDraft={accountDraft}
            requestReset={() => setConfirmModalMode("reset")}
            handleSave={handleSave}
            llmEnvStatus={llmEnvStatus}
            llmEnvValues={llmEnvValues}
            llmProviders={llmProviders}
            editAccount={editAccount}
            removeAccount={removeAccount}
            setAccountDraft={setAccountDraft}
            settings={settings}
            saveStatus={saveStatus}
            storagePreview={storagePreview}
            toggleAccountExport={toggleAccountExport}
            toggleField={toggleField}
            updateSettings={updateSettings}
            onAddAccount={addAccount}
            onConfigureLlm={setEditingLlmProvider}
            onSelectLlm={(providerId) => {
              const provider = llmProviders.find((item) => item.id === providerId);

              selectLlmProvider(providerId);
              if (provider) {
                setEditingLlmProvider(provider);
              }
            }}
          />
        )}
      </section>

      <footer className="system-message" aria-live="polite">
        <span>System</span>
        <strong>{systemMessage}</strong>
      </footer>

      {pdfModalMode === "viewer" && selectedPdf && (
        <PdfViewerModal
          pdf={selectedPdf}
          onClose={() => {
            setPdfModalMode(null);
            setSelectedPdf(null);
          }}
        />
      )}

      {pdfModalMode === "creator" && (
        <PdfCreatorModal
          creating={isCreatingPdf}
          settings={settings}
          toggleField={toggleField}
          updatePdfStyle={updatePdfStyle}
          updateSettings={updateSettings}
          onCreate={createPdfBook}
          onSave={handleSave}
          onClose={() => setPdfModalMode(null)}
        />
      )}

      {confirmModalMode === "reset" && (
        <ConfirmResetModal
          onCancel={() => setConfirmModalMode(null)}
          onConfirm={handleReset}
        />
      )}

      {editingAccount && (
        <EditSnsAccountModal
          account={editingAccount}
          onCancel={cancelAccountEdit}
          onChange={updateEditingAccount}
          onConfirm={confirmAccountEdit}
        />
      )}

      {sidebarModalMode === "search" && (
        <SearchPanelModal
          query={query}
          onApply={(nextQuery) => {
            setQuery(nextQuery);
            setSidebarModalMode(null);
            setSystemMessage(nextQuery.trim() ? "Search applied." : "Search cleared.");
          }}
          onClear={() => {
            setQuery("");
            setSystemMessage("Search cleared.");
          }}
          onClose={() => setSidebarModalMode(null)}
        />
      )}

      {sidebarModalMode === "filter" && (
        <FilterPanelModal
          connectionMax={maxConnectionCount}
          filters={cardFilters}
          platformOptions={filterPlatformOptions}
          onApply={(nextFilters) => {
            setCardFilters(nextFilters);
            setSidebarModalMode(null);
            setSystemMessage("Card filters applied.");
          }}
          onClear={() => {
            setCardFilters(emptyCardFilters);
            setSystemMessage("Card filters cleared.");
          }}
          onClose={() => setSidebarModalMode(null)}
        />
      )}

      {sidebarModalMode === "query" && (
        <LlmQueryModal
          envValues={llmEnvValues}
          question={llmQuestion}
          result={llmResult}
          selectedProvider={selectedLlmProvider}
          sourcePosts={querySourcePosts}
          providers={llmProviders}
          onAsk={(nextQuestion) => {
            const result = buildLocalLlmPreviewAnswer(nextQuestion, querySourcePosts, selectedLlmProvider);
            setLlmQuestion(nextQuestion);
            setLlmResult(result);
            setSystemMessage("LLM query preview created from current Markdown cards.");
          }}
          onProviderChange={(providerId) => {
            selectLlmProvider(providerId);
            setLlmResult(null);
          }}
          onClear={() => {
            setLlmQuestion("");
            setLlmResult(null);
            setSystemMessage("LLM query cleared.");
          }}
          onClose={() => setSidebarModalMode(null)}
        />
      )}

      {sidebarModalMode === "import" && (
        <ArchiveImportModal
          disabled={isImportingArchive}
          onApply={runArchiveImport}
          onClose={() => setSidebarModalMode(null)}
        />
      )}

      {selectedPost && (
        <PostDetailModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
          onOpenImage={(imageUrl) => {
            setSelectedImage(imageUrl);
          }}
        />
      )}

      {selectedImage && (
        <ImagePreviewModal
          imageUrl={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {deleteCandidate && (
        <ConfirmDeletePostModal
          post={deleteCandidate}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={deletePost}
        />
      )}

      {deletePdfCandidate && (
        <ConfirmDeletePdfModal
          pdf={deletePdfCandidate}
          onCancel={() => setDeletePdfCandidate(null)}
          onConfirm={deletePdf}
        />
      )}

      {editingLlmProvider && (
        <LlmProviderConfigDialog
          envValues={llmEnvValues}
          envStatus={llmEnvStatus}
          provider={editingLlmProvider}
          onCancel={() => setEditingLlmProvider(null)}
          onConfirm={saveLlmEnv}
        />
      )}
    </main>
  );
}

function PlatformSidebar({
  activeAccount,
  enrichBusy,
  filterActive,
  items,
  queryActive,
  searchActive,
  updateBusy,
  onEnrich,
  onFilter,
  onImport,
  onQuery,
  onSearch,
  onSelect,
  onUpdate
}: {
  activeAccount: AccountFilter;
  enrichBusy: boolean;
  filterActive: boolean;
  items: Array<{
    key: string;
    label: string;
    count: number;
    icon: ReactNode;
  }>;
  queryActive: boolean;
  searchActive: boolean;
  updateBusy: boolean;
  onEnrich: () => void;
  onFilter: () => void;
  onImport: () => void;
  onQuery: () => void;
  onSearch: () => void;
  onSelect: (accountId: AccountFilter) => void;
  onUpdate: () => void;
}) {
  return (
    <aside className="platform-sidebar" aria-label="Platform filters">
      <nav className="platform-nav">
        {items.map((item) => (
          <button
            className={activeAccount === item.key ? "platform-button active" : "platform-button"}
            key={item.key}
            onClick={() => onSelect(item.key)}
            title={`${item.label}: ${item.count}`}
            type="button"
          >
            <span className="platform-icon">{item.icon}</span>
            <span className="platform-count" aria-label={`${item.count} files`}>
              {item.count}
            </span>
          </button>
        ))}
      </nav>

      <div className="sidebar-tools">
        <button
          className={searchActive ? "icon-button active" : "icon-button"}
          onClick={onSearch}
          title="Search"
          type="button"
        >
          <Search size={20} />
        </button>
        <button
          className={filterActive ? "icon-button active" : "icon-button"}
          onClick={onFilter}
          title="Filter"
          type="button"
        >
          <SlidersHorizontal size={20} />
        </button>
        <button
          className={queryActive ? "icon-button active" : "icon-button"}
          onClick={onQuery}
          title="Query"
          type="button"
        >
          <Bot size={20} />
        </button>
        <button
          className="icon-button"
          onClick={onImport}
          title="Import"
          type="button"
        >
          <FolderOpen size={20} />
        </button>
        <button
          className="icon-button"
          disabled={enrichBusy}
          onClick={onEnrich}
          title={enrichBusy ? "Summary and TAG running" : "Summary and TAG"}
          type="button"
        >
          <Tags size={20} />
        </button>
        <button
          className="icon-button"
          disabled={updateBusy}
          onClick={onUpdate}
          title={updateBusy ? "Update running" : "Update"}
          type="button"
        >
          <RefreshCw size={20} />
        </button>
      </div>
    </aside>
  );
}

function TopToolbar({
  query,
  view,
  onLoginBrowser,
  onQueryChange,
  onRestartServer,
  onSnsRead,
  onViewChange,
  snsReadBusy
}: {
  query: string;
  view: ViewMode;
  onLoginBrowser: () => void;
  onQueryChange: (query: string) => void;
  onRestartServer: () => void;
  onSnsRead: () => void;
  onViewChange: (view: ViewMode, message: string) => void;
  snsReadBusy: boolean;
}) {
  return (
    <header className="top-toolbar">
      <div className="app-title">
        <strong>SNS Reader</strong>
        <span>{BUILD_VERSION}</span>
      </div>

      <label className="toolbar-search">
        <Search size={18} />
        <input
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search converted Markdown files"
          value={query}
        />
      </label>

      <nav className="toolbar-actions" aria-label="Main actions">
        <button
          className={view === "mesh-view" ? "icon-button active" : "icon-button"}
          onClick={() => onViewChange("mesh-view", "Mesh view opened.")}
          title="Mesh"
          type="button"
        >
          <GitBranch size={20} />
        </button>
        <button
          className={view === "sns-read" ? "icon-button active" : "icon-button"}
          disabled={snsReadBusy}
          onClick={onSnsRead}
          title={snsReadBusy ? "SNS running" : "SNS"}
          type="button"
        >
          <Database size={20} />
        </button>
        <button
          className={view === "pdf-write" ? "icon-button active" : "icon-button"}
          onClick={() => onViewChange("pdf-write", "PDF writer view opened.")}
          title="PDF"
          type="button"
        >
          <FileText size={20} />
        </button>
        <button
          className="icon-button"
          onClick={onLoginBrowser}
          title="로그인"
          type="button"
        >
          <KeyRound size={20} />
        </button>
        <button
          className={view === "settings" ? "icon-button active" : "icon-button"}
          onClick={() => onViewChange("settings", "Settings view opened.")}
          title="Setting"
          type="button"
        >
          <Settings size={20} />
        </button>
        <button
          className="icon-button restart-button"
          onClick={onRestartServer}
          title="Restart local server"
          type="button"
        >
          <Power size={20} />
        </button>
      </nav>
    </header>
  );
}

function ConvertedFileLibrary({
  onDeletePost,
  posts,
  onOpenPost
}: {
  onDeletePost: (post: ConvertedPost) => void;
  posts: ConvertedPost[];
  onOpenPost: (post: ConvertedPost) => void;
}) {
  return (
    <section className="library-section">
      <div className="post-card-grid">
        {posts.map((post) => (
          <article
            className={`post-card platform-${post.platform}`}
            key={post.id}
            onClick={() => onOpenPost(post)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenPost(post);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <CardImagePreview imageCount={post.imageCount} imageUrl={post.imageUrls?.[0] ?? ""} />
            <div className="post-card-body">
              <button
                className="card-delete-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeletePost(post);
                }}
                title="Delete"
                type="button"
              >
                <Trash2 size={16} />
              </button>
              <div className="post-meta">
                <span>{post.platformLabel}</span>
                <strong>{post.date}</strong>
              </div>
              <h3>{post.title || "Untitled Post"}</h3>
              <p className="post-body-preview">{post.bodyPreview || post.body || post.summary}</p>
              <div className="post-card-footer">
                <p className="post-summary-preview">{post.summary}</p>
                <div className="tag-row compact-tags text-tags">
                  {post.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>

      {posts.length === 0 && (
        <div className="empty-state">
          <ListFilter size={24} />
          <strong>No cards in this filter</strong>
          <span>Converted files will appear here after the folder scan is connected.</span>
        </div>
      )}
    </section>
  );
}

function MeshView({ posts }: { posts: ConvertedPost[] }) {
  const meshSvgRef = useRef<SVGSVGElement | null>(null);
  const [meshViewport, setMeshViewport] = useState({ centerX: 500, centerY: 500, zoom: 1 });
  const [meshDragStart, setMeshDragStart] = useState<{
    centerX: number;
    centerY: number;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  const [selectedMeshTag, setSelectedMeshTag] = useState<string | null>(null);
  const meshDataKey = useMemo(() => {
    const firstPostId = posts[0] ? getPostKey(posts[0]) : "";
    const lastPostId = posts[posts.length - 1] ? getPostKey(posts[posts.length - 1]) : "";

    return `${posts.length}:${firstPostId}:${lastPostId}`;
  }, [posts]);
  const mesh = useMemo(() => {
    const postTagMap = new Map<string, string[]>();
    const graphPosts = posts.map((post, index) => ({
      ...post,
      id: getPostKey(post, String(index))
    }));
    const tagCounts = getTagCounts(graphPosts);

    graphPosts.forEach((post) => {
      const normalizedTags = getSemanticTags(post);

      if (normalizedTags.length === 0) {
        return;
      }

      postTagMap.set(post.id, normalizedTags);
    });

    const topTags = Array.from(tagCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 18);
    const tagNames = new Set(topTags.map(([tag]) => tag));
    const postPositions = new Map<string, { x: number; y: number }>();
    const postDegrees = new Map<string, number>();
    const edgeWeights = new Map<string, MeshEdge>();
    const postsByVisibleTag = new Map<string, string[]>();
    const centerX = 500;
    const centerY = 500;

    graphPosts.forEach((post) => {
      (postTagMap.get(post.id) ?? [])
        .filter((tag) => tagNames.has(tag))
        .forEach((tag) => {
          postsByVisibleTag.set(tag, [...(postsByVisibleTag.get(tag) ?? []), post.id]);
        });
    });

    postsByVisibleTag.forEach((postIds, tag) => {
      for (let leftIndex = 0; leftIndex < postIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < postIds.length; rightIndex += 1) {
          const from = postIds[leftIndex];
          const to = postIds[rightIndex];
          const key = getEdgeKey(from, to);
          const existingEdge = edgeWeights.get(key);

          if (existingEdge) {
            existingEdge.sharedTags.push(tag);
            existingEdge.weight += 1;
          } else {
            edgeWeights.set(key, { from, to, sharedTags: [tag], weight: 1 });
          }

          postDegrees.set(from, (postDegrees.get(from) ?? 0) + 1);
          postDegrees.set(to, (postDegrees.get(to) ?? 0) + 1);
        }
      }
    });

    const sortedEdges = Array.from(edgeWeights.values()).sort(
      (left, right) => right.weight - left.weight || (postDegrees.get(right.from) ?? 0) - (postDegrees.get(left.from) ?? 0)
    );
    const visibleEdges = selectBalancedMeshEdges(sortedEdges, meshVisibleEdgeLimit);
    const highlightedEdges = selectedMeshTag
      ? selectBalancedMeshEdges(sortedEdges, meshVisibleEdgeLimit, selectedMeshTag)
      : [];
    const highlightedEdgeKeys = new Set(highlightedEdges.map((edge) => getEdgeKey(edge.from, edge.to)));
    const backgroundEdges = visibleEdges.filter((edge) => !highlightedEdgeKeys.has(getEdgeKey(edge.from, edge.to)));
    const maxDegree = Math.max(1, ...Array.from(postDegrees.values()));

    const layoutPosts = [...graphPosts].sort((left, right) => {
      const degreeDelta = (postDegrees.get(right.id) ?? 0) - (postDegrees.get(left.id) ?? 0);

      return degreeDelta || String(left.dateIso || left.date).localeCompare(String(right.dateIso || right.date)) || left.id.localeCompare(right.id);
    });
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    layoutPosts.forEach((post, index) => {
      const degree = postDegrees.get(post.id) ?? 0;
      const degreeRatio = Math.sqrt(degree / maxDegree);
      const baseRadius = Math.sqrt((index + 0.5) / Math.max(1, layoutPosts.length));
      const radialJitter = (hashToUnit(String(post.filePath || post.id), 31) - 0.5) * 0.08;
      const radial = clampNumber(baseRadius * (1 - degreeRatio * 0.22) + radialJitter, 0.06, 0.98);
      const angle = index * goldenAngle + hashToUnit(post.id + String(post.dateIso || post.date), 17) * 0.42;
      const jitterX = (hashToUnit(String(post.title || "") + post.id, 47) - 0.5) * 18;
      const jitterY = (hashToUnit(post.id + String(post.platform || ""), 59) - 0.5) * 18;

      postPositions.set(post.id, {
        x: clampNumber(centerX + Math.cos(angle) * 438 * radial + jitterX, 48, 952),
        y: clampNumber(centerY + Math.sin(angle) * 438 * radial + jitterY, 48, 952)
      });
    });

    return { backgroundEdges, graphPosts, highlightedEdges, maxDegree, postDegrees, postPositions, topTags, visibleEdges };
  }, [posts, selectedMeshTag]);
  const meshViewSize = meshCanvasSize / meshViewport.zoom;
  const meshViewBoxX = clampNumber(
    meshViewport.centerX - meshViewSize / 2,
    -meshPanMargin,
    meshCanvasSize - meshViewSize + meshPanMargin
  );
  const meshViewBoxY = clampNumber(
    meshViewport.centerY - meshViewSize / 2,
    -meshPanMargin,
    meshCanvasSize - meshViewSize + meshPanMargin
  );
  const meshViewBox = `${meshViewBoxX} ${meshViewBoxY} ${meshViewSize} ${meshViewSize}`;
  const clampMeshViewport = (centerX: number, centerY: number, zoom: number) => {
    const nextSize = meshCanvasSize / zoom;
    const minCenter = nextSize / 2 - meshPanMargin;
    const maxCenter = meshCanvasSize - nextSize / 2 + meshPanMargin;

    return {
      centerX: clampNumber(centerX, minCenter, maxCenter),
      centerY: clampNumber(centerY, minCenter, maxCenter),
      zoom
    };
  };

  useEffect(() => {
    setMeshViewport({ centerX: 500, centerY: 500, zoom: 1 });
    setMeshDragStart(null);
    setSelectedMeshTag(null);
  }, [meshDataKey]);

  return (
    <section className="mesh-page">
      <div className="library-header">
        <div>
          <p className="eyebrow">{"TAG \uC5F0\uACB0\uB9DD"}</p>
          <h1>Mesh View</h1>
        </div>
        <span className="mesh-summary">
          {mesh.graphPosts.length}{"\uAC1C \uAE00 / "}{mesh.visibleEdges.length}{"\uAC1C \uC5F0\uACB0"}
          {selectedMeshTag ? ` / ${selectedMeshTag} ${mesh.highlightedEdges.length}\uAC1C highlight` : ""}
        </span>
      </div>

      <div className="mesh-layout">
        <div className="mesh-canvas-panel">
          {mesh.graphPosts.length === 0 ? (
            <div className="empty-state mesh-empty-state">
              <GitBranch size={28} />
              <strong>{"\uC5F0\uACB0\uD560 \uAE00\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."}</strong>
              <span>{"\uC694\uC57D\uACFC TAG \uC0DD\uC131\uC744 \uBA3C\uC800 \uC2E4\uD589\uD558\uBA74 \uAC19\uC740 TAG\uB97C \uAC00\uC9C4 \uAE00\uB4E4\uC774 \uC5F0\uACB0\uB429\uB2C8\uB2E4."}</span>
            </div>
          ) : (
            <svg
              ref={meshSvgRef}
              className={meshDragStart ? "mesh-svg dragging" : "mesh-svg"}
              viewBox={meshViewBox}
              role="img"
              aria-label={"TAG \uAE30\uBC18 \uAE00 \uC5F0\uACB0\uB9DD"}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return;
                }

                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setMeshDragStart({
                  centerX: meshViewport.centerX,
                  centerY: meshViewport.centerY,
                  pointerX: event.clientX,
                  pointerY: event.clientY
                });
              }}
              onPointerMove={(event) => {
                if (!meshDragStart || !meshSvgRef.current) {
                  return;
                }

                const bounds = meshSvgRef.current.getBoundingClientRect();
                const nextSize = meshCanvasSize / meshViewport.zoom;
                const deltaX = ((event.clientX - meshDragStart.pointerX) / bounds.width) * nextSize;
                const deltaY = ((event.clientY - meshDragStart.pointerY) / bounds.height) * nextSize;

                setMeshViewport(clampMeshViewport(meshDragStart.centerX - deltaX, meshDragStart.centerY - deltaY, meshViewport.zoom));
              }}
              onPointerUp={(event) => {
                if (meshDragStart) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }

                setMeshDragStart(null);
              }}
              onPointerCancel={() => setMeshDragStart(null)}
              onWheel={(event) => {
                if (!meshSvgRef.current) {
                  return;
                }

                event.preventDefault();
                const bounds = meshSvgRef.current.getBoundingClientRect();
                const relativeX = clampNumber((event.clientX - bounds.left) / bounds.width, 0, 1);
                const relativeY = clampNumber((event.clientY - bounds.top) / bounds.height, 0, 1);

                setMeshViewport((current) => {
                  const currentSize = meshCanvasSize / current.zoom;
                  const currentX = current.centerX - currentSize / 2;
                  const currentY = current.centerY - currentSize / 2;
                  const cursorX = currentX + relativeX * currentSize;
                  const cursorY = currentY + relativeY * currentSize;
                  const nextZoom = clampNumber(current.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 12);
                  const nextSize = meshCanvasSize / nextZoom;
                  const nextCenterX = cursorX - relativeX * nextSize + nextSize / 2;
                  const nextCenterY = cursorY - relativeY * nextSize + nextSize / 2;

                  return clampMeshViewport(nextCenterX, nextCenterY, nextZoom);
                });
              }}
            >
              {mesh.backgroundEdges.map((edge) => {
                const from = mesh.postPositions.get(edge.from);
                const to = mesh.postPositions.get(edge.to);

                if (!from || !to) {
                  return null;
                }

                return (
                  <line
                    className={selectedMeshTag ? "mesh-edge muted" : "mesh-edge"}
                    key={edge.from + "-" + edge.to}
                    style={{ "--edge-weight": Math.min(4, edge.weight) } as CSSProperties}
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  >
                    <title>{edge.sharedTags.join(", ")}</title>
                  </line>
                );
              })}
              {mesh.highlightedEdges.map((edge) => {
                const from = mesh.postPositions.get(edge.from);
                const to = mesh.postPositions.get(edge.to);

                if (!from || !to) {
                  return null;
                }

                return (
                  <line
                    className="mesh-edge highlighted"
                    key={`highlight-${edge.from}-${edge.to}`}
                    style={{ "--edge-weight": Math.min(4, edge.weight) } as CSSProperties}
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  >
                    <title>{edge.sharedTags.join(", ")}</title>
                  </line>
                );
              })}
              {mesh.graphPosts.map((post) => {
                const position = mesh.postPositions.get(post.id);

                if (!position) {
                  return null;
                }

                return (
                  <g className={"mesh-post-node platform-" + post.platform} key={post.id}>
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={1.8 + Math.sqrt((mesh.postDegrees.get(post.id) ?? 0) / mesh.maxDegree) * 3.4}
                    />
                    <title>{(post.title || "Untitled Post") + "\n" + post.date + "\nConnections: " + (mesh.postDegrees.get(post.id) ?? 0)}</title>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <aside className="mesh-side-panel">
          <h2>Top TAG</h2>
          <div className="mesh-tag-list">
            {mesh.topTags.map(([tag, count]) => (
              <button
                className={selectedMeshTag === tag ? "mesh-tag-item active" : "mesh-tag-item"}
                key={tag}
                onClick={() => setSelectedMeshTag((current) => (current === tag ? null : tag))}
                type="button"
                title={`${tag} TAG \uC5F0\uACB0\uC120\uB9CC \uBCF4\uAE30`}
              >
                <span>{tag}</span>
                <strong>{count}</strong>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function CardImagePreview({
  imageCount,
  imageUrl
}: {
  imageCount: number;
  imageUrl: string;
}) {
  return (
    <div className={imageUrl ? "post-thumb has-image" : "post-thumb"}>
      {imageUrl ? (
        <>
          <img alt="" src={imageUrl} />
          <span className="image-count-badge">
            {imageCount} {imageCount === 1 ? "image" : "images"}
          </span>
        </>
      ) : (
        <span className="empty-thumb-label">{imageCount > 0 ? `${imageCount} images` : "No image"}</span>
      )}
    </div>
  );
}

function DetailImageStrip({
  imageUrls,
  onOpenImage
}: {
  imageUrls: string[];
  onOpenImage: (imageUrl: string) => void;
}) {
  if (imageUrls.length === 0) {
    return null;
  }

  return (
    <section className="detail-image-strip" aria-label="Post images">
      {imageUrls.map((imageUrl, index) => (
        <button
          className="detail-image-button"
          key={`${imageUrl}-${index}`}
          onClick={() => onOpenImage(imageUrl)}
          type="button"
        >
          <img alt="" src={imageUrl} />
        </button>
      ))}
    </section>
  );
}

function PostDetailModal({
  post,
  onClose,
  onOpenImage
}: {
  post: ConvertedPost;
  onClose: () => void;
  onOpenImage: (imageUrl: string) => void;
}) {
  const bodyParagraphs = (post.body || "No body captured.")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const summaryLines =
    post.summaryLines && post.summaryLines.length > 0
      ? post.summaryLines
      : post.summary
          .split(/\s+-\s+|\n+/)
          .map((line) => line.replace(/^[-*]\s+/, "").trim())
          .filter(Boolean)
          .slice(0, 2);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section
        className="modal-shell post-detail-shell"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Markdown post detail"
      >
        <header className="post-detail-header">
          <p className="eyebrow">{post.platformLabel}</p>
          <button className="icon-button" onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body post-detail-body">
          <div className="post-detail-title-row">
            <h2>{post.title || "Untitled Post"}</h2>
            <span>{post.date}</span>
          </div>

          <div className="post-detail-meta">
            <span>{post.filePath}</span>
          </div>

          <section className="post-detail-section">
            {bodyParagraphs.map((paragraph, index) => (
              <p key={`${post.id}-body-${index}`}>{paragraph}</p>
            ))}
          </section>

          <section className="post-detail-section">
            <h3>댓글</h3>
            <p>{post.commentsText && !post.commentsText.includes("No comments") ? post.commentsText : "저장된 댓글이 없습니다."}</p>
            {post.reactionText && <p>{post.reactionText}</p>}
          </section>

          <section className="post-detail-section">
            <h3>요약</h3>
            {summaryLines.length > 0 ? (
              <ul>
                {summaryLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p>No summary captured.</p>
            )}
          </section>

          <section className="post-detail-section">
            <h3>TAG</h3>
            <div className="tag-row text-tags">
              {post.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          </section>

          {post.sourceUrl && (
            <a className="source-link" href={post.sourceUrl} rel="noreferrer" target="_blank">
              Original Source
            </a>
          )}
        </div>

        <DetailImageStrip imageUrls={post.imageUrls ?? []} onOpenImage={onOpenImage} />
      </section>
    </div>
  );
}

function ImagePreviewModal({
  imageUrl,
  onClose
}: {
  imageUrl: string;
  onClose: () => void;
}) {
  const [imageSize, setImageSize] = useState({ height: 0, width: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragStart, setDragStart] = useState<{ panX: number; panY: number; pointerX: number; pointerY: number } | null>(
    null
  );
  const viewportWidth = typeof window === "undefined" ? 1180 : Math.max(320, window.innerWidth - 64);
  const viewportHeight = typeof window === "undefined" ? 860 : Math.max(320, window.innerHeight - 64);
  const naturalWidth = imageSize.width || viewportWidth;
  const naturalHeight = imageSize.height || viewportHeight;
  const fitScale = Math.min(1, viewportWidth / naturalWidth, viewportHeight / naturalHeight);
  const fittedWidth = Math.max(1, Math.round(naturalWidth * fitScale));
  const fittedHeight = Math.max(1, Math.round(naturalHeight * fitScale));
  const shellWidth = Math.min(viewportWidth, Math.max(360, fittedWidth));
  const shellHeight = Math.min(viewportHeight, Math.max(260, fittedHeight));

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [imageUrl]);

  return (
    <div className="modal-backdrop image-preview-backdrop" onClick={onClose} role="presentation">
      <section
        className={dragStart ? "image-preview-shell dragging" : "image-preview-shell"}
        style={{ height: shellHeight, width: shellWidth }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) {
            return;
          }

          if (event.button !== 0) {
            return;
          }

          if (zoom <= 1) {
            return;
          }

          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragStart({
            panX: pan.x,
            panY: pan.y,
            pointerX: event.clientX,
            pointerY: event.clientY
          });
        }}
        onPointerLeave={() => setDragStart(null)}
        onPointerMove={(event) => {
          if (!dragStart) {
            return;
          }

          setPan({
            x: dragStart.panX + event.clientX - dragStart.pointerX,
            y: dragStart.panY + event.clientY - dragStart.pointerY
          });
        }}
        onPointerUp={() => setDragStart(null)}
        onWheel={(event) => {
          event.preventDefault();
          const nextZoom = Math.min(4, Math.max(1, zoom + (event.deltaY < 0 ? 0.12 : -0.12)));

          if (nextZoom <= 1) {
            setPan({ x: 0, y: 0 });
          }

          setZoom(Number(nextZoom.toFixed(2)));
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
      >
        <button
          className="icon-button image-preview-close"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title="Close"
          type="button"
        >
          <X size={20} />
        </button>
        <div
          className="image-preview-stage"
          style={{ height: shellHeight, width: shellWidth }}
        >
          <img
            alt=""
            draggable={false}
            onLoad={(event) => {
              setImageSize({
                height: event.currentTarget.naturalHeight,
                width: event.currentTarget.naturalWidth
              });
            }}
            onDragStart={(event) => event.preventDefault()}
            src={imageUrl}
            style={{
              height: fittedHeight,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              width: fittedWidth
            }}
          />
        </div>
      </section>
    </div>
  );
}

function ConfirmDeletePostModal({
  post,
  onCancel,
  onConfirm
}: {
  post: ConvertedPost;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <section
        className="modal-shell confirm-shell"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm delete post"
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">Delete</p>
            <h2>게시글을 삭제할까요?</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <p className="confirm-copy">
            {post.title || "Untitled Post"} 파일과 연결된 이미지 폴더를 삭제합니다.
          </p>
          <small>{post.filePath}</small>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger-action compact" onClick={onConfirm} type="button">
            Delete
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmDeletePdfModal({
  pdf,
  onCancel,
  onConfirm
}: {
  pdf: PdfBook;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <section
        className="modal-shell confirm-shell"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm delete PDF"
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">Delete</p>
            <h2>PDF를 삭제할까요?</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <p className="confirm-copy">{pdf.title || "PDF"} 파일을 삭제합니다.</p>
          <small>{pdf.filePath}</small>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger-action compact" onClick={onConfirm} type="button">
            Delete
          </button>
        </footer>
      </section>
    </div>
  );
}

function PdfWriteView({
  pdfBooks,
  onCreate,
  onDeletePdf,
  onOpenPdf
}: {
  pdfBooks: PdfBook[];
  onCreate: () => void;
  onDeletePdf: (pdf: PdfBook) => void;
  onOpenPdf: (pdf: PdfBook) => void;
}) {
  return (
    <section className="pdf-page">
      <div className="library-header">
        <div>
          <p className="eyebrow">PDF 보관함</p>
          <h1>생성된 PDF</h1>
        </div>
        <button className="primary-action compact" onClick={onCreate} type="button">
          <Plus size={18} />
          PDF 만들기
        </button>
      </div>

      <div className="pdf-card-grid">
        {pdfBooks.length === 0 && (
          <div className="empty-state pdf-empty-state">
            <FileText size={34} />
            <strong>아직 만들어진 PDF가 없습니다.</strong>
            <span>PDF 만들기를 눌러 현재 Markdown 카드로 책을 만들어보세요.</span>
          </div>
        )}
        {pdfBooks.map((pdf) => (
          <article className="pdf-card" key={pdf.id}>
            <button className="pdf-card-hit-area" onClick={() => onOpenPdf(pdf)} title={`${pdf.title} 미리보기`} type="button" />
            <button
              className="pdf-card-delete"
              onClick={(event) => {
                event.stopPropagation();
                onDeletePdf(pdf);
              }}
              title="PDF 삭제"
              type="button"
            >
              <Trash2 size={16} />
            </button>
            <div className="pdf-card-cover">
              {pdf.coverUrl ? (
                <img alt={`${pdf.title} 표지`} loading="lazy" src={pdf.coverUrl} />
              ) : (
                <>
                  <FileText size={38} />
                  <span>PDF</span>
                </>
              )}
            </div>
            <div className="pdf-card-body">
              <strong className="pdf-card-date">{pdf.dateRange || pdf.createdAt}</strong>
              <p className="pdf-card-count">{typeof pdf.postCount === "number" ? `${pdf.postCount}개 글` : "글 수 정보 없음"} / {pdf.pageCount}쪽</p>
              <p className="pdf-card-source">원문 link</p>
              <small>{pdf.filePath}</small>
              <div className="pdf-card-action">
                <Eye size={18} />
                미리보기
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function SettingsView({
  accountDraft,
  editAccount,
  requestReset,
  handleSave,
  llmEnvStatus,
  llmEnvValues,
  llmProviders,
  removeAccount,
  saveStatus,
  setAccountDraft,
  settings,
  storagePreview,
  toggleAccountExport,
  toggleField,
  updateSettings,
  onAddAccount,
  onConfigureLlm,
  onSelectLlm
}: {
  accountDraft: Omit<SnsAccountConfig, "id">;
  editAccount: (id: string) => void;
  requestReset: () => void;
  handleSave: () => void;
  llmEnvStatus: LlmEnvStatus;
  llmEnvValues: LlmEnvValues;
  llmProviders: LlmProviderOption[];
  removeAccount: (id: string) => void;
  saveStatus: string;
  setAccountDraft: Dispatch<SetStateAction<Omit<SnsAccountConfig, "id">>>;
  settings: AppSettings;
  storagePreview: string;
  toggleAccountExport: (id: string, exportToObsidian: boolean) => void;
  toggleField: (target: "optionalFields" | "pdfFields", field: ExportField) => void;
  updateSettings: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
  onAddAccount: () => void;
  onConfigureLlm: (provider: LlmProviderOption) => void;
  onSelectLlm: (providerId: string) => void;
}) {
  return (
    <section className="settings-page">
      <div className="settings-actions">
        <span className="save-status" role="status">
          {saveStatus}
        </span>
        <button className="ghost-action compact" onClick={requestReset} type="button">
          <RotateCcw size={18} />
          Reset to Defaults
        </button>
        <button className="primary-action compact" onClick={handleSave} type="button">
          <Save size={18} />
          Save
        </button>
      </div>

      <Panel title="General Setting" icon={<FolderOpen size={18} />}>
        <label>
          Theme
          <select
            onChange={(event) => updateSettings("theme", event.target.value as AppSettings["theme"])}
            value={settings.theme}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>
          DB Folder
          <input
            onChange={(event) => updateSettings("obsidianRootFolder", event.target.value)}
            placeholder="F:\\Obsidian\\PC-Madwind\\SNS"
            value={settings.obsidianRootFolder}
          />
        </label>
        <label>
          Output Folder
          <input
            onChange={(event) => updateSettings("pdfOutputFolder", event.target.value)}
            placeholder="F:\\Obsidian\\PC-Madwind\\PDF"
            value={settings.pdfOutputFolder}
          />
        </label>
      </Panel>

      <Panel title="LLM Setting" icon={<Bot size={18} />}>
        <LlmProviderPicker
          envStatus={llmEnvStatus}
          envValues={llmEnvValues}
          providers={llmProviders}
          selectedProviderId={settings.selectedLlmProvider}
          onSelect={onSelectLlm}
        />
        <button className="ghost-action compact llm-add-button" onClick={() => onConfigureLlm(llmProviders.find((provider) => provider.id === "custom") ?? llmProviders[0])} type="button">
          <Plus size={16} />
          {"\uBAA8\uB378 \uC218\uB3D9 \uCD94\uAC00"}
        </button>
        <p className="hint">{"\uB4DC\uB86D\uB2E4\uC6B4\uC5D0\uC11C \uBAA8\uB378\uC744 \uC120\uD0DD\uD558\uBA74 \uC124\uC815 \uD31D\uC5C5\uC774 \uC5F4\uB9BD\uB2C8\uB2E4. \uCEEC\uB7EC \uC6D0\uC740 .env\uC5D0 \uD544\uC694\uD55C \uC815\uBCF4\uAC00 \uC788\uB2E4\uB294 \uB73B\uC785\uB2C8\uB2E4."}</p>
      </Panel>

      <Panel title="SNS Setting" icon={<Plus size={18} />}>
        <label>
          Name
          <input
            onChange={(event) =>
              setAccountDraft((current) => ({
                ...current,
                label: event.target.value
              }))
            }
            placeholder="Mom FB, Work Instagram, Project Blog, etc."
            value={accountDraft.label}
          />
        </label>
        <label>
          Platform
          <select
            onChange={(event) =>
              setAccountDraft((current) => ({
                ...current,
                platform: event.target.value as SnsPlatform
              }))
            }
            value={accountDraft.platform}
          >
            {Object.entries(platformLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Account URL
          <input
            onChange={(event) =>
              setAccountDraft((current) => ({
                ...current,
                url: event.target.value
              }))
            }
            placeholder="https://..."
            value={accountDraft.url}
          />
        </label>
        <label className="inline-check">
          <input
            checked={accountDraft.requiresLogin}
            onChange={(event) =>
              setAccountDraft((current) => ({
                ...current,
                requiresLogin: event.target.checked
              }))
            }
            type="checkbox"
          />
          Login Required
        </label>
        {accountDraft.requiresLogin && (
          <div className="login-required-note">
            Login Required marks this URL as private or session-based. Passwords will not be saved here; later imports will ask for a secure login session or OS keychain entry.
          </div>
        )}
        <label className="inline-check">
          <input
            checked={accountDraft.exportToObsidian}
            onChange={(event) =>
              setAccountDraft((current) => ({
                ...current,
                exportToObsidian: event.target.checked
              }))
            }
            type="checkbox"
          />
          Import to Obsidian
        </label>
        <button className="primary-action full-width" onClick={onAddAccount} type="button">
          <Plus size={18} />
          Add Account
        </button>
      </Panel>

      <Panel title="SNS Saved" icon={<KeyRound size={18} />}>
        <div className="account-list">
          {settings.accounts.map((account) => (
            <div className="managed-account-row" key={account.id}>
              <label className="md-export-check" title="Import to Obsidian">
                <input
                  checked={account.exportToObsidian}
                  onChange={(event) => toggleAccountExport(account.id, event.target.checked)}
                  type="checkbox"
                />
                <span>Import</span>
              </label>
              <div>
                <span>{platformLabels[account.platform]}</span>
                <strong>{account.label}</strong>
                <small>{account.url}</small>
              </div>
              <div className="account-row-actions">
                <button
                  className="icon-button"
                  onClick={() => editAccount(account.id)}
                  title="Edit account"
                  type="button"
                >
                  <Pencil size={18} />
                </button>
                <button
                  className="icon-button danger"
                  onClick={() => removeAccount(account.id)}
                  title="Remove account"
                  type="button"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Obsidian Output" icon={<Database size={18} />}>
        <label>
          Folder Layout
          <select
            onChange={(event) =>
              updateSettings("storageLayout", event.target.value as AppSettings["storageLayout"])
            }
            value={settings.storageLayout}
          >
            <option value="platform-month">Platform / Month</option>
            <option value="month-platform">Month / Platform</option>
          </select>
        </label>
        <RequiredFields />
        <FieldSelector
          selectedFields={settings.optionalFields}
          onToggle={(field) => toggleField("optionalFields", field)}
        />
        <div className="number-row">
          <label>
            Summary Lines
            <input
              max={5}
              min={1}
              onChange={(event) => updateSettings("summaryLines", Number(event.target.value))}
              type="number"
              value={settings.summaryLines}
            />
          </label>
          <label>
            Max Tags
            <input
              max={10}
              min={1}
              onChange={(event) => updateSettings("maxTags", Number(event.target.value))}
              type="number"
              value={settings.maxTags}
            />
          </label>
        </div>
        <p className="hint">{storagePreview}</p>
      </Panel>

    </section>
  );
}

function LlmProviderPicker({
  envStatus,
  envValues,
  providers,
  selectedProviderId,
  onSelect
}: {
  envStatus: LlmEnvStatus;
  envValues: LlmEnvValues;
  providers: LlmProviderOption[];
  selectedProviderId: string;
  onSelect: (providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pickerProviders = providers.filter((provider) => provider.id !== "custom");
  const selectedProvider = getPreferredLlmProvider(pickerProviders, selectedProviderId);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const chooseProvider = (providerId: string) => {
    onSelect(providerId);
    setOpen(false);
  };

  return (
    <div className="llm-picker" ref={rootRef}>
      <span className="field-caption">Default Query LLM</span>
      <button
        aria-expanded={open}
        className="llm-picker-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <LlmStatusDot configured={isProviderConfigured(selectedProvider, envStatus)} />
        <span>{getProviderDisplayName(selectedProvider, envValues)}</span>
        <span className="llm-picker-caret">v</span>
      </button>
      {open && (
        <div className="llm-picker-menu" role="listbox">
          {pickerProviders.map((provider) => (
            <button
              aria-selected={provider.id === selectedProvider.id}
              className={provider.id === selectedProvider.id ? "llm-picker-option selected" : "llm-picker-option"}
              key={provider.id}
              onClick={() => chooseProvider(provider.id)}
              role="option"
              type="button"
            >
              <LlmStatusDot configured={isProviderConfigured(provider, envStatus)} />
              <span>{getProviderDisplayName(provider, envValues)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LlmStatusDot({ configured }: { configured: boolean }) {
  return <span aria-label={configured ? "configured" : undefined} className={configured ? "llm-status-dot configured" : "llm-status-dot"} />;
}

function Panel({
  title,
  icon,
  children
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ReadOnlyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="read-only-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FieldSelector({
  selectedFields,
  onToggle
}: {
  selectedFields: ExportField[];
  onToggle: (field: ExportField) => void;
}) {
  return (
    <div className="field-grid">
      {(Object.keys(fieldLabels) as ExportField[]).map((field) => (
        <label className="check-tile" key={field}>
          <input checked={selectedFields.includes(field)} onChange={() => onToggle(field)} type="checkbox" />
          <span>{fieldLabels[field]}</span>
        </label>
      ))}
    </div>
  );
}

function RequiredFields() {
  return (
    <div className="required-field-grid" aria-label="Required fields">
      {["Title", "Date", "Body"].map((field) => (
        <label className="required-check-tile" key={field}>
          <input checked disabled readOnly type="checkbox" />
          <span>{field}</span>
        </label>
      ))}
    </div>
  );
}

function Segmented<Option extends string>({
  options,
  value,
  onChange
}: {
  options: [Option, string][];
  value: Option;
  onChange: (value: Option) => void;
}) {
  return (
    <div className={`segmented columns-${options.length}`}>
      {options.map(([optionValue, label]) => (
        <button
          className={value === optionValue ? "selected" : ""}
          key={optionValue}
          onClick={() => onChange(optionValue)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PdfViewerModal({ pdf, onClose }: { pdf: PdfBook; onClose: () => void }) {
  const [selectedPage, setSelectedPage] = useState(1);
  const [isExpanded, setIsExpanded] = useState(false);
  const wheelLockRef = useRef(0);
  const pageCount = Math.max(1, Number(pdf.pageCount || 1));
  const pages = useMemo(() => Array.from({ length: pageCount }, (_item, index) => index + 1), [pageCount]);
  const pageImageUrl = (page: number, dpi: number) => `/api/pdf-page?path=${encodeURIComponent(pdf.filePath)}&page=${page}&dpi=${dpi}`;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section
        className={isExpanded ? "modal-shell pdf-viewer-shell expanded" : "modal-shell pdf-viewer-shell"}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="PDF Preview"
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">PDF 미리보기</p>
            <h2>{pdf.title}</h2>
          </div>
          <div className="modal-header-actions">
            <button className="icon-button" onClick={() => setIsExpanded((current) => !current)} title={isExpanded ? "창 크기 복원" : "전체보기"} type="button">
              {isExpanded ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
            <button className="icon-button" onClick={onClose} title="닫기" type="button">
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="modal-body pdf-viewer-body">
          <aside className="pdf-page-nav" aria-label="PDF page navigation">
            {pages.map((page) => (
              <button
                className={page === selectedPage ? "pdf-page-thumb active" : "pdf-page-thumb"}
                key={page}
                onClick={() => setSelectedPage(page)}
                type="button"
              >
                <img alt={`${page}쪽 미리보기`} loading="lazy" src={pageImageUrl(page, 48)} />
                <span>{page}</span>
              </button>
            ))}
          </aside>
          <main
            className="pdf-page-preview-pane"
            onWheel={(event) => {
              event.preventDefault();

              if (Math.abs(event.deltaY) < 12) {
                return;
              }

              const now = Date.now();

              if (now - wheelLockRef.current < 260) {
                return;
              }

              wheelLockRef.current = now;
              setSelectedPage((current) => Math.min(pageCount, Math.max(1, current + (event.deltaY > 0 ? 1 : -1))));
            }}
          >
            <img alt={`${selectedPage}쪽`} className="pdf-page-preview-image" src={pageImageUrl(selectedPage, 150)} />
          </main>
        </div>
      </section>
    </div>
  );
}
function PdfCreatorModal({
  creating,
  settings,
  toggleField,
  updatePdfStyle,
  updateSettings,
  onCreate,
  onSave,
  onClose
}: {
  creating: boolean;
  settings: AppSettings;
  toggleField: (target: "optionalFields" | "pdfFields", field: ExportField) => void;
  updatePdfStyle: <Key extends keyof PdfTextStyle>(target: PdfStyleTarget, key: Key, value: PdfTextStyle[Key]) => void;
  updateSettings: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
  onCreate: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const [styleTarget, setStyleTarget] = useState<PdfStyleTarget>("body");
  const [stylePreviewText, setStylePreviewText] = useState("가나다라마바사아자차카타파하\nABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz");
  const fontOptions = settings.pdfFonts.length ? settings.pdfFonts : defaultSettings.pdfFonts;
  const activeStyle = settings.pdfStyles[styleTarget];
  const selectedFontKnown = fontOptions.some((font) => font.fontFamily === activeStyle.fontFamily);
  const visibleFontOptions = selectedFontKnown
    ? fontOptions
    : [
        ...fontOptions,
        {
          id: `current-${activeStyle.fontFamily}`,
          label: activeStyle.fontFamily,
          fontFamily: activeStyle.fontFamily,
          regularPath: "",
          boldPath: ""
        }
      ];
  const stylePreview: CSSProperties = {
    color: getReadablePreviewColor(activeStyle.color, settings.theme),
    fontFamily: `"${activeStyle.fontFamily}", "Malgun Gothic", sans-serif`,
    fontSize: `${activeStyle.fontSize * 2}px`,
    fontStyle: activeStyle.italic ? "italic" : "normal",
    fontWeight: activeStyle.bold ? 800 : 500,
    lineHeight: activeStyle.lineHeight,
    textAlign: "center",
    textDecoration: activeStyle.underline ? "underline" : "none"
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell pdf-creator-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Create PDF">
        <header className="modal-header">
          <div>
            <p className="eyebrow">PDF 만들기</p>
            <h2>PDF 생성</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="닫기" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <Panel title="Source" icon={<Database size={18} />}>
            <label>
              DB Folder
              <input
                onChange={(event) => updateSettings("obsidianRootFolder", event.target.value)}
                placeholder="F:\\Obsidian\\PC-Madwind\\SNS"
                value={settings.obsidianRootFolder}
              />
            </label>
            <label>
              Output Folder
              <input
                onChange={(event) => updateSettings("pdfOutputFolder", event.target.value)}
                placeholder="F:\\Obsidian\\PC-Madwind\\PDF"
                value={settings.pdfOutputFolder}
              />
            </label>
          </Panel>
          <Panel title="PDF Setting" icon={<FileText size={18} />}>
            <label>
              Split mode
              <select
                onChange={(event) => updateSettings("pdfSplitMode", event.target.value as AppSettings["pdfSplitMode"])}
                value={settings.pdfSplitMode}
              >
                <option value="year">Year list</option>
                <option value="date-range">Date range</option>
                <option value="page-count">Pages per PDF</option>
              </select>
            </label>
            <PdfSplitControls settings={settings} updateSettings={updateSettings} />
            <label>
              Image layout
              <select
                onChange={(event) => updateSettings("imageLayout", event.target.value as AppSettings["imageLayout"])}
                value={settings.imageLayout}
              >
                <option value="collage">Collage</option>
                <option value="individual">Individual images</option>
                <option value="collage-individual">Collage + individual images</option>
              </select>
            </label>
            <RequiredFields />
            <FieldSelector selectedFields={settings.pdfFields} onToggle={(field) => toggleField("pdfFields", field)} />
          </Panel>
          <Panel title="Overview" icon={<ListFilter size={18} />}>
            <div className="pdf-overview-options">
              <ReadOnlyLine label="Included" value="Summary, Thinking, Postings, Favorite Posts, Mesh View" />
              <p className="hint">Markdown에 저장된 요약, TAG, 댓글, 반응 정보를 사용해서 책 앞부분의 요약 페이지를 만듭니다.</p>
            </div>
          </Panel>
          <Panel title="Style" icon={<Pencil size={18} />}>
            <label>
              Page orientation
              <select
                onChange={(event) => {
                  const nextOrientation = event.target.value as AppSettings["pdfPageOrientation"];

                  updateSettings("pdfPageOrientation", nextOrientation);
                  if (nextOrientation === "landscape" && settings.pdfTextColumnCount === 1) {
                    updateSettings("pdfTextColumnCount", 2);
                  }
                  if (nextOrientation === "portrait" && settings.pdfTextColumnCount === 3) {
                    updateSettings("pdfTextColumnCount", 2);
                  }
                }}
                value={settings.pdfPageOrientation}
              >
                <option value="portrait">세로</option>
                <option value="landscape">가로</option>
              </select>
            </label>
            <label>
              Body windows
              <select
                onChange={(event) => updateSettings("pdfTextColumnCount", Number(event.target.value) as AppSettings["pdfTextColumnCount"])}
                value={settings.pdfTextColumnCount}
              >
                <option disabled={settings.pdfPageOrientation === "landscape"} value={1}>
                  본문 1개
                </option>
                <option value={2}>본문 2개</option>
                <option disabled={settings.pdfPageOrientation !== "landscape"} value={3}>
                  본문 3개
                </option>
              </select>
            </label>
            {settings.pdfPageOrientation !== "landscape" && (
              <p className="hint">본문 3개는 가로 페이지에서만 사용할 수 있습니다.</p>
            )}
            {settings.pdfPageOrientation === "landscape" && (
              <p className="hint">가로 페이지에서는 본문 2개 또는 3개를 사용할 수 있습니다.</p>
            )}
            <div className="pdf-style-grid pdf-cover-image-grid">
              <label>
                세로 표지 그림
                <input
                  onChange={(event) => updateSettings("pdfPortraitCoverImagePath", event.target.value)}
                  placeholder="assets\\Cover-Long3.jpeg"
                  value={settings.pdfPortraitCoverImagePath}
                />
              </label>
              <label>
                가로 표지 그림
                <input
                  onChange={(event) => updateSettings("pdfLandscapeCoverImagePath", event.target.value)}
                  placeholder="assets\\Cover-Wide2.png"
                  value={settings.pdfLandscapeCoverImagePath}
                />
              </label>
            </div>
            <label>
              Corner pattern
              <input
                onChange={(event) => updateSettings("pdfCornerPatternPath", event.target.value)}
                placeholder="assets\\korean-corner-pattern-1.jpeg"
                value={settings.pdfCornerPatternPath}
              />
            </label>
            <label>
              Style target
              <select onChange={(event) => setStyleTarget(event.target.value as PdfStyleTarget)} value={styleTarget}>
                {Object.entries(pdfStyleLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="pdf-style-grid">
              <label>
                Font
                <select onChange={(event) => updatePdfStyle(styleTarget, "fontFamily", event.target.value)} value={activeStyle.fontFamily}>
                  {visibleFontOptions.map((font) => (
                    <option key={font.id} value={font.fontFamily}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Size
                <input min={7} max={32} onChange={(event) => updatePdfStyle(styleTarget, "fontSize", Number(event.target.value))} type="number" value={activeStyle.fontSize} />
              </label>
              <label>
                Color
                <input onChange={(event) => updatePdfStyle(styleTarget, "color", event.target.value)} type="color" value={activeStyle.color} />
              </label>
              <label>
                Line height
                <input max={2.4} min={1} onChange={(event) => updatePdfStyle(styleTarget, "lineHeight", Number(event.target.value))} step={0.05} type="number" value={activeStyle.lineHeight} />
              </label>
            </div>
            <div className="style-toggle-row">
              <label className="inline-check">
                <input checked={activeStyle.bold} onChange={(event) => updatePdfStyle(styleTarget, "bold", event.target.checked)} type="checkbox" />
                Bold
              </label>
              <label className="inline-check">
                <input checked={activeStyle.italic} onChange={(event) => updatePdfStyle(styleTarget, "italic", event.target.checked)} type="checkbox" />
                Italic
              </label>
              <label className="inline-check">
                <input checked={activeStyle.underline} onChange={(event) => updatePdfStyle(styleTarget, "underline", event.target.checked)} type="checkbox" />
                Underline
              </label>
            </div>
            <div className="pdf-style-preview">
              <span>미리보기</span>
              <div
                className="pdf-style-preview-editor"
                contentEditable
                onInput={(event) => setStylePreviewText(event.currentTarget.innerText)}
                role="textbox"
                style={stylePreview}
                suppressContentEditableWarning
              >
                {stylePreviewText}
              </div>
            </div>
          </Panel>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" disabled={creating} onClick={onClose} type="button">
            취소
          </button>
          <div className="modal-footer-actions pdf-creator-actions">
            <button className="ghost-action compact pdf-save-action" disabled={creating} onClick={onSave} type="button">
              저장
            </button>
            <button className="primary-action compact" disabled={creating} onClick={onCreate} type="button">
              {creating ? "생성 중..." : "생성"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function PdfSplitControls({
  settings,
  updateSettings
}: {
  settings: AppSettings;
  updateSettings: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
}) {
  if (settings.pdfSplitMode === "year") {
    return (
      <div className="split-control-panel">
        <label>
          Year
          <input
            onChange={(event) => updateSettings("pdfYear", event.target.value)}
            placeholder="2026, 2025, 2023-2024"
            value={settings.pdfYear}
          />
        </label>
        <p className="hint">쉼표로 구분된 각 항목이 각각 한 권의 PDF가 됩니다. 예: 2026, 2025, 2023-2024</p>
      </div>
    );
  }

  if (settings.pdfSplitMode === "date-range") {
    return (
      <div className="split-control-panel">
        <div className="number-row">
          <label>
            From
            <input onChange={(event) => updateSettings("pdfDateFrom", event.target.value)} placeholder="YYYY-MM-DD" type="text" value={settings.pdfDateFrom} />
          </label>
          <label>
            To
            <input onChange={(event) => updateSettings("pdfDateTo", event.target.value)} placeholder="YYYY-MM-DD" type="text" value={settings.pdfDateTo} />
          </label>
        </div>
        <p className="hint">지정된 기간 전체가 하나의 PDF로 만들어집니다.</p>
      </div>
    );
  }

  return (
    <div className="split-control-panel">
      <label>
        Pages per PDF
        <input min={30} onChange={(event) => updateSettings("pdfPageCount", Number(event.target.value))} placeholder="200" type="number" value={settings.pdfPageCount || ""} />
      </label>
      <p className="hint">30쪽 이상만 가능합니다. 마지막 권이 30쪽 미만이면 앞 권에 합칩니다.</p>
    </div>
  );
}
function SearchPanelModal({
  query,
  onApply,
  onClear,
  onClose
}: {
  query: string;
  onApply: (query: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draftQuery, setDraftQuery] = useState(query);

  const clearSearch = () => {
    setDraftQuery("");
    onClear();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell side-tool-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Search cards">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Card Search</p>
            <h2>Search</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <label>
            Search Text
            <input
              autoFocus
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Search title, body summary, path, platform, or tag"
              value={draftQuery}
            />
          </label>
          <p className="hint">This uses the same search value as the top toolbar.</p>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onClose} type="button">
            Close
          </button>
          <div className="modal-footer-actions">
            <button className="ghost-action compact" onClick={clearSearch} type="button">
              Clear
            </button>
            <button className="primary-action compact" onClick={() => onApply(draftQuery)} type="button">
              Apply
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function FilterPanelModal({
  connectionMax,
  filters,
  platformOptions,
  onApply,
  onClear,
  onClose
}: {
  connectionMax: number;
  filters: CardFilters;
  platformOptions: Array<{ platform: SnsPlatform; label: string }>;
  onApply: (filters: CardFilters) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draftFilters, setDraftFilters] = useState<CardFilters>(filters);
  const [dateError, setDateError] = useState("");
  const connectionLimit = Math.max(0, connectionMax);
  const sliderMax = Math.max(1, connectionLimit);
  const connectionMin = Math.min(draftFilters.connectionMin, connectionLimit);
  const connectionUpper = connectionLimit === 0
    ? 0
    : draftFilters.connectionMax > 0
      ? Math.min(draftFilters.connectionMax, connectionLimit)
      : connectionLimit;
  const lowerPercent = (connectionMin / sliderMax) * 100;
  const upperPercent = (connectionUpper / sliderMax) * 100;

  const updateDraft = <Key extends keyof CardFilters>(key: Key, value: CardFilters[Key]) => {
    if (key === "dateFrom" || key === "dateTo") {
      setDateError("");
    }

    setDraftFilters((current) => ({
      ...current,
      [key]: value
    }));
  };

  const updateConnectionMin = (value: number) => {
    setDraftFilters((current) => {
      const nextMin = Math.min(value, current.connectionMax > 0 ? current.connectionMax : connectionLimit);

      return {
        ...current,
        connectionMin: nextMin
      };
    });
  };

  const updateConnectionMax = (value: number) => {
    setDraftFilters((current) => {
      const nextMax = Math.max(value, current.connectionMin);

      return {
        ...current,
        connectionMax: nextMax >= connectionLimit ? 0 : nextMax
      };
    });
  };

  const updateConnectionMinText = (value: string) => {
    const nextValue = Number(value);

    if (!Number.isFinite(nextValue)) {
      return;
    }

    updateConnectionMin(clampNumber(Math.round(nextValue), 0, connectionLimit));
  };

  const updateConnectionMaxText = (value: string) => {
    const nextValue = Number(value);

    if (!Number.isFinite(nextValue)) {
      return;
    }

    updateConnectionMax(clampNumber(Math.round(nextValue), 0, connectionLimit));
  };

  const togglePlatformFilter = (platform: SnsPlatform, checked: boolean) => {
    setDraftFilters((current) => ({
      ...current,
      platforms: checked
        ? Array.from(new Set([...current.platforms, platform]))
        : current.platforms.filter((item) => item !== platform)
    }));
  };

  const applyFilters = () => {
    if (!isValidDateInput(draftFilters.dateFrom) || !isValidDateInput(draftFilters.dateTo)) {
      setDateError("Use a valid date in YYYY-MM-DD format.");
      return;
    }

    if (draftFilters.dateFrom && draftFilters.dateTo && draftFilters.dateFrom > draftFilters.dateTo) {
      setDateError("From date must be earlier than or equal to To date.");
      return;
    }

    onApply({
      ...draftFilters,
      connectionMin,
      connectionMax: connectionUpper >= connectionLimit ? 0 : connectionUpper,
      commentAuthor: draftFilters.commentAuthor.trim(),
      tagText: draftFilters.tagText.trim()
    });
  };

  const clearFilters = () => {
    setDraftFilters(emptyCardFilters);
    setDateError("");
    onClear();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell filter-tool-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Filter cards">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Card Filter</p>
            <h2>Filter</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <div className="filter-section">
            <span>SNS Type</span>
            <div className="filter-option-grid">
              {platformOptions.map((option) => (
                <label className="check-tile" key={option.platform}>
                  <input
                    checked={draftFilters.platforms.includes(option.platform)}
                    onChange={(event) => togglePlatformFilter(option.platform, event.target.checked)}
                    type="checkbox"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <span>Date</span>
            <div className="number-row">
              <label>
                From
                <input
                  onChange={(event) => updateDraft("dateFrom", event.target.value)}
                  type="date"
                  value={draftFilters.dateFrom}
                />
              </label>
              <label>
                To
                <input
                  onChange={(event) => updateDraft("dateTo", event.target.value)}
                  type="date"
                  value={draftFilters.dateTo}
                />
              </label>
            </div>
            {dateError && (
              <p className="form-error" role="alert">
                {dateError}
              </p>
            )}
          </div>
          <div className="filter-section">
            <span>Include</span>
            <div className="filter-option-list">
              <label className="check-tile">
                <input
                  checked={draftFilters.imagesOnly}
                  onChange={(event) => updateDraft("imagesOnly", event.target.checked)}
                  type="checkbox"
                />
                Images
              </label>
              <label className="check-tile">
                <input
                  checked={draftFilters.tagsOnly}
                  onChange={(event) => updateDraft("tagsOnly", event.target.checked)}
                  type="checkbox"
                />
                Tags
              </label>
              <label className="check-tile">
                <input
                  checked={draftFilters.commentsOnly}
                  onChange={(event) => updateDraft("commentsOnly", event.target.checked)}
                  type="checkbox"
                />
                Comments
              </label>
            </div>
          </div>
          <div className="filter-section">
            <span>Connection</span>
            <div className="connection-range-row">
              <label className="connection-value-input" aria-label="Minimum connection">
                <input
                  aria-label="Minimum connection"
                  max={connectionLimit}
                  min={0}
                  onChange={(event) => updateConnectionMinText(event.target.value)}
                  type="number"
                  value={connectionMin}
                />
              </label>
              <div
                className="dual-range"
                style={{
                  "--range-lower": `${lowerPercent}%`,
                  "--range-upper": `${upperPercent}%`
                } as CSSProperties}
              >
                <div className="dual-range-track" />
                <input
                  aria-label="Minimum connection"
                  max={sliderMax}
                  min={0}
                  onChange={(event) => updateConnectionMin(Number(event.target.value))}
                  onInput={(event) => updateConnectionMin(Number(event.currentTarget.value))}
                  type="range"
                  value={connectionMin}
                />
                <input
                  aria-label="Maximum connection"
                  max={sliderMax}
                  min={0}
                  onChange={(event) => updateConnectionMax(Number(event.target.value))}
                  onInput={(event) => updateConnectionMax(Number(event.currentTarget.value))}
                  type="range"
                  value={connectionUpper}
                />
              </div>
              <label className="connection-value-input" aria-label="Maximum connection">
                <input
                  aria-label="Maximum connection"
                  max={connectionLimit}
                  min={0}
                  onChange={(event) => updateConnectionMaxText(event.target.value)}
                  type="number"
                  value={connectionUpper}
                />
              </label>
            </div>
          </div>
          <div className="filter-section">
            <span>Text Conditions</span>
            <div className="number-row">
              <label>
                Comment Author
                <input
                  onChange={(event) => updateDraft("commentAuthor", event.target.value)}
                  placeholder="ex: Mina, Dad, Alex"
                  value={draftFilters.commentAuthor}
                />
              </label>
              <label>
                TAG
                <input
                  onChange={(event) => updateDraft("tagText", event.target.value)}
                  placeholder="ex: Archive, Travel"
                  value={draftFilters.tagText}
                />
              </label>
            </div>
          </div>
          <p className="hint">Comment Author and TAG accept comma-separated values and match with OR.</p>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onClose} type="button">
            Close
          </button>
          <div className="modal-footer-actions">
            <button className="ghost-action compact" onClick={clearFilters} type="button">
              Clear
            </button>
            <button className="primary-action compact" onClick={applyFilters} type="button">
              Apply
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ArchiveImportModal({
  disabled,
  onApply,
  onClose
}: {
  disabled: boolean;
  onApply: (platform: SnsPlatform, zipFile: File, enrich: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [platform, setPlatform] = useState<SnsPlatform>("facebook");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [enrich, setEnrich] = useState(true);
  const [error, setError] = useState("");
  const detectedPlatform = selectedFile ? detectPlatformFromArchiveName(selectedFile.name) : null;
  const fileNameWarning =
    detectedPlatform && detectedPlatform !== platform
      ? `파일 이름은 ${platformLabels[detectedPlatform]} archive처럼 보입니다. 현재 선택한 Provider는 ${platformLabels[platform]}입니다.`
      : "";
  const canImport = Boolean(selectedFile) && !disabled;
  const importHint =
    platform === "youtube"
      ? "Google Takeout에서 YouTube 및 YouTube Music 게시물 데이터를 포함한 zip을 선택하세요."
      : platform === "facebook"
      ? "Meta/Facebook 정보 다운로드에서 받은 zip을 선택하세요."
      : "Meta 계정 센터에서 받은 Instagram 또는 Threads 정보 다운로드 zip을 선택하세요.";

  const clearFile = () => {
    setSelectedFile(null);
    setError("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const submit = async () => {
    if (!selectedFile || disabled) {
      return;
    }

    if (!selectedFile.name.toLowerCase().endsWith(".zip")) {
      setError("zip 파일만 Import할 수 있습니다.");
      return;
    }

    setError("");
    await onApply(platform, selectedFile, enrich);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell archive-import-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="SNS archive import">
        <header className="modal-header">
          <div>
            <p className="eyebrow">SNS Import</p>
            <h2>Archive Import</h2>
          </div>
          <button className="icon-button" disabled={disabled} onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <label>
            SNS Provider
            <select disabled={disabled} onChange={(event) => setPlatform(event.target.value as SnsPlatform)} value={platform}>
              {importablePlatforms.map((item) => (
                <option key={item} value={item}>
                  {platformLabels[item]}
                </option>
              ))}
            </select>
          </label>

          <div className="archive-file-picker">
            <input
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null);
                setError("");
              }}
              ref={fileInputRef}
              type="file"
            />
            <button className="ghost-action" disabled={disabled} onClick={() => fileInputRef.current?.click()} type="button">
              <FolderOpen size={18} />
              zip 파일 선택
            </button>
            <div>
              <strong>{selectedFile?.name ?? "선택된 zip 파일 없음"}</strong>
              <span>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB` : "탐색기에서 archive zip을 선택하세요."}</span>
            </div>
          </div>

          <label className="inline-check">
            <input checked={enrich} disabled={disabled} onChange={(event) => setEnrich(event.target.checked)} type="checkbox" />
            Import 후 요약과 TAG 생성
          </label>

          <p className="hint">{importHint}</p>
          {fileNameWarning && <p className="form-warning">{fileNameWarning}</p>}
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" disabled={disabled} onClick={onClose} type="button">
            Close
          </button>
          <div className="modal-footer-actions">
            <button className="ghost-action compact" disabled={disabled} onClick={clearFile} type="button">
              Clear
            </button>
            <button className="primary-action compact" disabled={!canImport} onClick={submit} type="button">
              {disabled ? "Importing..." : "Apply"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function LlmQueryModal({
  envValues,
  question,
  providers,
  result,
  selectedProvider,
  sourcePosts,
  onAsk,
  onClear,
  onProviderChange,
  onClose
}: {
  envValues: LlmEnvValues;
  question: string;
  providers: LlmProviderOption[];
  result: LlmQueryResult | null;
  selectedProvider: LlmProviderOption;
  sourcePosts: ConvertedPost[];
  onAsk: (question: string) => void;
  onClear: () => void;
  onProviderChange: (providerId: string) => void;
  onClose: () => void;
}) {
  const [draftQuestion, setDraftQuestion] = useState(question);
  const canAsk = draftQuestion.trim().length > 0 && sourcePosts.length > 0;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell llm-query-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Ask Markdown files">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Markdown Q&A</p>
            <h2>Ask SNS Markdown</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <label>
            LLM
            <select
              onChange={(event) => onProviderChange(event.target.value)}
              value={selectedProvider.id}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {getProviderDisplayName(provider, envValues)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Question
            <textarea
              autoFocus
              className="query-textarea"
              onChange={(event) => setDraftQuestion(event.target.value)}
              placeholder="Ask about generated SNS Markdown files, for example: What were the main topics in July?"
              value={draftQuestion}
            />
          </label>
          <div className="llm-scope-line">
            <Database size={16} />
            <span>{sourcePosts.length} Markdown cards in the current SNS scope</span>
            <span className="scope-divider">/</span>
            <span>{selectedProvider.label}</span>
          </div>
          {result ? (
            <div className="llm-answer-panel">
              <span>Answer</span>
              <p>{result.answer}</p>
            </div>
          ) : (
            <div className="llm-empty-answer">
              <Search size={22} />
              <strong>Ready for a natural language question</strong>
              <span>The next step is connecting this panel to a local Markdown scan, vector index, and LLM API.</span>
            </div>
          )}
          {result && (
            <div className="llm-source-list">
              <span>Sources</span>
              {result.sources.map((post) => (
                <article key={post.id} className="llm-source-row">
                  <strong>{post.title || "Untitled Post"}</strong>
                  <small>{post.filePath}</small>
                </article>
              ))}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onClose} type="button">
            Close
          </button>
          <div className="modal-footer-actions">
            <button className="ghost-action compact" onClick={onClear} type="button">
              Clear
            </button>
            <button className="primary-action compact" disabled={!canAsk} onClick={() => onAsk(draftQuestion)} type="button">
              Apply
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function LlmProviderConfigDialog({
  envValues,
  envStatus,
  provider,
  onCancel,
  onConfirm
}: {
  envValues: LlmEnvValues;
  envStatus: LlmEnvStatus;
  provider: LlmProviderOption;
  onCancel: () => void;
  onConfirm: (provider: LlmProviderOption, draft: LlmConfigDraft) => Promise<void>;
}) {
  const displayModel = getProviderDisplayModel(provider, envValues);
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
  const hasExistingApiKey = Boolean(apiKeyEnvKey && envStatus[apiKeyEnvKey]);
  const [draft, setDraft] = useState<LlmConfigDraft>({
    apiKey: hasExistingApiKey ? MASKED_SECRET_VALUE : "",
    baseUrl:
      envValues[getProviderBaseUrlEnvKey(provider)] ||
      (provider.id.startsWith("ollama") ? "http://127.0.0.1:11434" : provider.id === "openai-frontier" ? "https://api.openai.com/v1" : ""),
    model: provider.id === "local-preview" || provider.id === "custom" ? envValues.SNS_READER_LLM_MODEL || "" : displayModel,
    providerLabel: provider.id === "custom" ? envValues.VITE_LLM_CUSTOM_PROVIDER_LABEL || "" : provider.label
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const needsApiKey = provider.id !== "local-preview" && !provider.id.startsWith("ollama");
  const needsBaseUrl = provider.id === "custom" || provider.id.startsWith("ollama") || provider.id === "openai-frontier";
  const needsModel = provider.id !== "local-preview";
  const needsProviderLabel = provider.id === "custom";
  const configured = isProviderConfigured(provider, envStatus);
  const apiKeySatisfied = !needsApiKey || Boolean(draft.apiKey.trim()) || hasExistingApiKey;
  const canSave =
    provider.id === "local-preview" ||
    (apiKeySatisfied &&
      (!needsProviderLabel || Boolean(draft.providerLabel.trim())) &&
      (!needsBaseUrl || Boolean(draft.baseUrl.trim())) &&
      (!needsModel || Boolean(draft.model.trim())));

  const submit = async () => {
    if (!canSave || saving) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      await onConfirm(provider, draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save LLM settings.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <section
        className="modal-shell llm-config-shell"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="LLM settings"
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">LLM Setting</p>
            <h2>{configured ? "Edit model" : "Add model"}</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <div className="llm-config-summary">
            <Bot size={20} />
            <div>
              <strong>{provider.id === "custom" ? "New provider" : provider.label}</strong>
              <span>
                {provider.id === "custom"
                  ? "Provider, model, Base URL, and API key will be saved to .env."
                  : provider.id === "ollama"
                  ? "Model and Base URL will be saved to .env."
                  : getProviderEnvKeys(provider).length
                  ? `Model: ${displayModel} / ${getProviderEnvKeys(provider).join(", ")} will be saved to .env.`
                  : "Preview mode does not need extra settings."}
              </span>
            </div>
          </div>
          {needsProviderLabel && (
            <label>
              Provider
              <input
                onChange={(event) => setDraft((current) => ({ ...current, providerLabel: event.target.value }))}
                placeholder="OpenRouter, LM Studio, Groq, etc."
                value={draft.providerLabel}
              />
            </label>
          )}
          {needsModel && (
            <label>
              Model
              <input
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                placeholder={provider.id === "ollama" ? "gemma4:latest, qwen3.6:latest, llama3.3:70b" : "gpt-4.1, gemini-3.6-flash, etc."}
                value={draft.model}
              />
            </label>
          )}
          {needsBaseUrl && (
            <label>
              Base URL
              <input
                onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://api.example.com/v1"
                value={draft.baseUrl}
              />
            </label>
          )}
          {needsApiKey && (
            <label>
              API Key
              <input
                autoComplete="off"
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                onFocus={() => {
                  if (draft.apiKey === MASKED_SECRET_VALUE) {
                    setDraft((current) => ({ ...current, apiKey: "" }));
                  }
                }}
                placeholder={hasExistingApiKey ? "새 API Key를 입력하면 기존 값을 교체합니다." : "API Key는 .env에만 저장됩니다."}
                type={draft.apiKey === MASKED_SECRET_VALUE ? "text" : "password"}
                value={draft.apiKey}
              />
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <p className="hint">Input values are only used to create or update .env, not saved as separate app settings.</p>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-action compact" disabled={!canSave || saving} onClick={submit} type="button">
            {saving ? "Saving..." : "Save to .env"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function LlmProviderConfigModal({
  envValues,
  provider,
  onCancel,
  onConfirm
}: {
  envValues: LlmEnvValues;
  provider: LlmProviderOption;
  onCancel: () => void;
  onConfirm: (provider: LlmProviderOption, draft: LlmConfigDraft) => Promise<void>;
}) {
  const displayModel = getProviderDisplayModel(provider, envValues);
  const [draft, setDraft] = useState<LlmConfigDraft>({
    apiKey: "",
    baseUrl: envValues[getProviderBaseUrlEnvKey(provider)] || (provider.id.startsWith("ollama") ? "http://127.0.0.1:11434" : provider.id === "openai-frontier" ? "https://api.openai.com/v1" : ""),
    model: provider.id === "local-preview" || provider.id === "custom" ? envValues.SNS_READER_LLM_MODEL || "" : displayModel,
    providerLabel: provider.id === "custom" ? envValues.VITE_LLM_CUSTOM_PROVIDER_LABEL || "" : provider.label
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const needsApiKey = provider.id !== "local-preview" && !provider.id.startsWith("ollama");
  const needsBaseUrl = provider.id === "custom" || provider.id.startsWith("ollama") || provider.id === "openai-frontier";
  const needsModel = provider.id !== "local-preview";
  const canSave =
    provider.id === "local-preview" ||
    (!needsApiKey || draft.apiKey.trim()) &&
      (!needsBaseUrl || draft.baseUrl.trim()) &&
      (!needsModel || draft.model.trim());

  const submit = async () => {
    if (!canSave || saving) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      await onConfirm(provider, draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "LLM 설정 저장에 실패했습니다.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <section
        className="modal-shell llm-config-shell"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="LLM 설정"
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">LLM Setting</p>
            <h2>{provider.label}</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <div className="llm-config-summary">
            <Bot size={20} />
            <div>
              <strong>{provider.modelLabel}</strong>
              <strong>{displayModel}</strong>
              <span>{getProviderEnvKeys(provider).length ? `${getProviderEnvKeys(provider).join(", ")} 값을 .env에 저장합니다.` : "추가 설정이 필요 없는 preview 모델입니다."}</span>
            </div>
          </div>
          {needsModel && (
            <label>
              Model
              <input
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                placeholder="gemma4:latest, gpt-4.1, etc."
                value={draft.model}
              />
            </label>
          )}
          {needsBaseUrl && (
            <label>
              Base URL
              <input
                onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://api.example.com/v1"
                value={draft.baseUrl}
              />
            </label>
          )}
          {needsApiKey && (
            <label>
              API Key
              <input
                autoComplete="off"
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="저장 시 .env에만 기록"
                type="password"
                value={draft.apiKey}
              />
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <p className="hint">입력값은 별도 설정 파일에 저장하지 않고 .env 생성/수정에만 사용합니다.</p>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-action compact" disabled={!canSave || saving} onClick={submit} type="button">
            {saving ? "Saving..." : "Save to .env"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function EditSnsAccountModal({
  account,
  onCancel,
  onChange,
  onConfirm
}: {
  account: SnsAccountConfig;
  onCancel: () => void;
  onChange: <Key extends keyof SnsAccountConfig>(key: Key, value: SnsAccountConfig[Key]) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <section className="modal-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Edit SNS account">
        <header className="modal-header">
          <div>
            <p className="eyebrow">SNS Setting</p>
            <h2>Edit SNS Account</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <label>
            Name
            <input
              onChange={(event) => onChange("label", event.target.value)}
              placeholder="Mom FB, Work Instagram, Project Blog, etc."
              value={account.label}
            />
          </label>
          <label>
            Platform
            <select
              onChange={(event) => onChange("platform", event.target.value as SnsPlatform)}
              value={account.platform}
            >
              {Object.entries(platformLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Account URL
            <input
              onChange={(event) => onChange("url", event.target.value)}
              placeholder="https://..."
              value={account.url}
            />
          </label>
          <label className="inline-check">
            <input
              checked={account.requiresLogin}
              onChange={(event) => onChange("requiresLogin", event.target.checked)}
              type="checkbox"
            />
            Login Required
          </label>
          {account.requiresLogin && (
            <>
              <div className="login-required-note">
                This does not store a password. It only tells SNS Reader that future imports must use a secure login session or OS keychain entry.
              </div>
              <div className="number-row">
                <label>
                  Account ID
                  <input
                    onChange={(event) => onChange("username", event.target.value)}
                    placeholder="Optional"
                    value={account.username ?? ""}
                  />
                </label>
                <label>
                  Keychain Name
                  <input
                    onChange={(event) => onChange("credentialKey", event.target.value)}
                    placeholder="ex: instagram-main"
                    value={account.credentialKey ?? ""}
                  />
                </label>
              </div>
            </>
          )}
          <label className="inline-check">
            <input
              checked={account.exportToObsidian}
              onChange={(event) => onChange("exportToObsidian", event.target.checked)}
              type="checkbox"
            />
            Import to Obsidian
          </label>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-action compact" onClick={onConfirm} type="button">
            Confirm
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmResetModal({
  onCancel,
  onConfirm
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <section className="modal-shell confirm-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Confirm reset">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Warning</p>
            <h2>Reset settings?</h2>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <p className="confirm-copy">
            This will remove saved settings from this app and restore the default sample configuration.
            Saved SNS URLs and account options in local settings will be cleared.
          </p>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger-action compact" onClick={onConfirm} type="button">
            Reset
          </button>
        </footer>
      </section>
    </div>
  );
}

function getPlatformIcon(platform: SnsPlatform) {
  switch (platform) {
    case "facebook":
      return <Facebook size={20} />;
    case "instagram":
      return <Instagram size={20} />;
    case "threads":
      return <Bot size={20} />;
    case "youtube":
      return <Youtube size={20} />;
    case "x":
      return <Twitter size={20} />;
    case "naver-blog":
      return <Rss size={20} />;
    default:
      return <Archive size={20} />;
  }
}



