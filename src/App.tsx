import {
  Archive,
  Database,
  Bot,
  Eye,
  Facebook,
  FileText,
  FolderOpen,
  Instagram,
  KeyRound,
  ListFilter,
  Moon,
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
  Sun,
  Tags,
  Trash2,
  Twitter,
  X,
  Youtube
} from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultSettings, fieldLabels, platformLabels } from "./settings/defaults";
import { getAvailableLlmProviders, getPreferredLlmProvider } from "./settings/llm";
import { clearSettings, loadSettings, loadSettingsFile, saveSettings } from "./settings/storage";
import type { AppSettings, ExportField, LlmProviderOption, SnsAccountConfig, SnsPlatform } from "./types/domain";

type ViewMode = "sns-read" | "pdf-write" | "settings";
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
  createdAt: string;
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
  commentAuthor: "",
  tagText: ""
};

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
  const [selectedPost, setSelectedPost] = useState<ConvertedPost | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ConvertedPost | null>(null);
  const [isSnsReading, setIsSnsReading] = useState(false);
  const [isImportingArchive, setIsImportingArchive] = useState(false);
  const [isEnrichingMarkdown, setIsEnrichingMarkdown] = useState(false);
  const [isUpdatingSns, setIsUpdatingSns] = useState(false);
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

  const visiblePosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return querySourcePosts.filter((post) => {
      const commentAuthorTerms = splitCommaTerms(cardFilters.commentAuthor);
      const tagTerms = splitCommaTerms(cardFilters.tagText);
      const filterMatches =
        (!cardFilters.imagesOnly || post.imageCount > 0) &&
        (!cardFilters.commentsOnly || post.commentCount > 0) &&
        (!cardFilters.tagsOnly || post.tags.length > 0) &&
        (cardFilters.platforms.length === 0 || cardFilters.platforms.includes(post.platform)) &&
        (!cardFilters.dateFrom || post.dateIso >= cardFilters.dateFrom) &&
        (!cardFilters.dateTo || post.dateIso <= cardFilters.dateTo) &&
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
  }, [cardFilters, query, querySourcePosts]);

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
    setSystemMessage(message);
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

  return (
    <main className={`app-shell ${settings.theme}`}>
      <TopToolbar
        query={query}
        settings={settings}
        view={view}
        onQueryChange={setQuery}
        onRestartServer={restartServer}
        onSnsRead={runSnsRead}
        onThemeToggle={() => updateSettings("theme", settings.theme === "light" ? "dark" : "light")}
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
            pdfBooks={samplePdfBooks}
            onCreate={() => {
              setPdfModalMode("creator");
              setSelectedPdf(null);
              setSystemMessage("PDF creation settings opened.");
            }}
            onOpenPdf={(pdf) => {
              setSelectedPdf(pdf);
              setPdfModalMode("viewer");
              setSystemMessage(`${pdf.title} opened in preview.`);
            }}
          />
        )}

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
          settings={settings}
          toggleField={toggleField}
          updateSettings={updateSettings}
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
  settings,
  view,
  onQueryChange,
  onRestartServer,
  onSnsRead,
  onThemeToggle,
  onViewChange,
  snsReadBusy
}: {
  query: string;
  settings: AppSettings;
  view: ViewMode;
  onQueryChange: (query: string) => void;
  onRestartServer: () => void;
  onSnsRead: () => void;
  onThemeToggle: () => void;
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
          className={view === "sns-read" ? "icon-button active" : "icon-button"}
          disabled={snsReadBusy}
          onClick={onSnsRead}
          title={snsReadBusy ? "SNS Read running" : "SNS Read"}
          type="button"
        >
          <Database size={20} />
        </button>
        <button
          className={view === "pdf-write" ? "icon-button active" : "icon-button"}
          onClick={() => onViewChange("pdf-write", "PDF writer view opened.")}
          title="PDF Write"
          type="button"
        >
          <FileText size={20} />
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
          className="icon-button"
          onClick={onThemeToggle}
          title={settings.theme === "light" ? "Dark mode" : "Light mode"}
          type="button"
        >
          {settings.theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
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

function PdfWriteView({
  pdfBooks,
  onCreate,
  onOpenPdf
}: {
  pdfBooks: PdfBook[];
  onCreate: () => void;
  onOpenPdf: (pdf: PdfBook) => void;
}) {
  return (
    <section className="pdf-page">
      <div className="library-header">
        <div>
          <p className="eyebrow">PDF Library</p>
          <h1>Created PDFs</h1>
        </div>
        <button className="primary-action compact" onClick={onCreate} type="button">
          <Plus size={18} />
          Create PDF
        </button>
      </div>

      <div className="pdf-card-grid">
        {pdfBooks.map((pdf) => (
          <button className="pdf-card" key={pdf.id} onClick={() => onOpenPdf(pdf)} type="button">
            <div className="pdf-card-cover">
              <FileText size={38} />
              <span>PDF</span>
            </div>
            <div className="pdf-card-body">
              <div className="post-meta">
                <span>{pdf.createdAt}</span>
                <strong>{pdf.pageCount} pages</strong>
              </div>
              <strong>{pdf.title}</strong>
              <p>{pdf.dateRange}</p>
              <small>{pdf.filePath}</small>
              <div className="pdf-card-action">
                <Eye size={18} />
                Preview
              </div>
            </div>
          </button>
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
          Obsidian Output Folder
          <input
            onChange={(event) => updateSettings("obsidianRootFolder", event.target.value)}
            value={settings.obsidianRootFolder}
          />
        </label>
        <label>
          PDF Output Folder
          <input
            onChange={(event) => updateSettings("pdfOutputFolder", event.target.value)}
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
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="PDF Preview">
        <header className="modal-header">
          <div>
            <p className="eyebrow">PDF Preview</p>
            <h2>{pdf.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <div className="pdf-preview-frame">
            <FileText size={42} />
            <strong>{pdf.title}</strong>
            <span>{pdf.filePath}</span>
            <p>{pdf.pageCount} pages / {pdf.dateRange}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function PdfCreatorModal({
  settings,
  toggleField,
  updateSettings,
  onClose
}: {
  settings: AppSettings;
  toggleField: (target: "optionalFields" | "pdfFields", field: ExportField) => void;
  updateSettings: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="modal-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Create PDF">
        <header className="modal-header">
          <div>
            <p className="eyebrow">PDF Write</p>
            <h2>Create PDF</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close" type="button">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <Panel title="Source" icon={<Database size={18} />}>
            <ReadOnlyLine label="Obsidian DB Folder" value={settings.obsidianRootFolder} />
            <ReadOnlyLine label="PDF Output Folder" value={settings.pdfOutputFolder} />
          </Panel>
          <Panel title="PDF Setting" icon={<FileText size={18} />}>
            <label>
              Split Mode
              <select
                onChange={(event) =>
                  updateSettings("pdfSplitMode", event.target.value as AppSettings["pdfSplitMode"])
                }
                value={settings.pdfSplitMode}
              >
                <option value="year">By Year</option>
                <option value="date-range">Date Range</option>
                <option value="page-count">Page Count</option>
              </select>
            </label>
            <PdfSplitControls settings={settings} updateSettings={updateSettings} />
            <label>
              Image Layout
              <select
                onChange={(event) =>
                  updateSettings("imageLayout", event.target.value as AppSettings["imageLayout"])
                }
                value={settings.imageLayout}
              >
                <option value="collage">Collage</option>
                <option value="individual">Individual Images</option>
              </select>
            </label>
            <RequiredFields />
            <FieldSelector selectedFields={settings.pdfFields} onToggle={(field) => toggleField("pdfFields", field)} />
          </Panel>
        </div>
        <footer className="modal-footer">
          <button className="ghost-action compact" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-action compact" onClick={onClose} type="button">
            Create
          </button>
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
            inputMode="numeric"
            maxLength={4}
            onChange={(event) => updateSettings("pdfYear", event.target.value)}
            placeholder="2026"
            value={settings.pdfYear}
          />
        </label>
        <p className="hint">One PDF will be created for posts written in this year.</p>
      </div>
    );
  }

  if (settings.pdfSplitMode === "date-range") {
    return (
      <div className="split-control-panel">
        <div className="number-row">
          <label>
            From
            <input
              onChange={(event) => updateSettings("pdfDateFrom", event.target.value)}
              type="date"
              value={settings.pdfDateFrom}
            />
          </label>
          <label>
            To
            <input
              onChange={(event) => updateSettings("pdfDateTo", event.target.value)}
              type="date"
              value={settings.pdfDateTo}
            />
          </label>
        </div>
        <p className="hint">Only posts within this date range will be included.</p>
      </div>
    );
  }

  return (
    <div className="split-control-panel">
      <label>
        Pages per PDF
        <input
          min={1}
          onChange={(event) => updateSettings("pdfPageCount", Number(event.target.value))}
          type="number"
          value={settings.pdfPageCount}
        />
      </label>
      <p className="hint">New PDF files will be started after this page count.</p>
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
  filters,
  platformOptions,
  onApply,
  onClear,
  onClose
}: {
  filters: CardFilters;
  platformOptions: Array<{ platform: SnsPlatform; label: string }>;
  onApply: (filters: CardFilters) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draftFilters, setDraftFilters] = useState<CardFilters>(filters);
  const [dateError, setDateError] = useState("");

  const updateDraft = <Key extends keyof CardFilters>(key: Key, value: CardFilters[Key]) => {
    if (key === "dateFrom" || key === "dateTo") {
      setDateError("");
    }

    setDraftFilters((current) => ({
      ...current,
      [key]: value
    }));
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
                With Images
              </label>
              <label className="check-tile">
                <input
                  checked={draftFilters.tagsOnly}
                  onChange={(event) => updateDraft("tagsOnly", event.target.checked)}
                  type="checkbox"
                />
                With Tags
              </label>
              <label className="check-tile">
                <input
                  checked={draftFilters.commentsOnly}
                  onChange={(event) => updateDraft("commentsOnly", event.target.checked)}
                  type="checkbox"
                />
                With Comments
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
      ? `파일명은 ${platformLabels[detectedPlatform]} archive처럼 보입니다. 현재 선택된 Provider는 ${platformLabels[platform]}입니다.`
      : "";
  const canImport = Boolean(selectedFile) && !disabled;
  const importHint =
    platform === "youtube"
      ? "Google Takeout에서 YouTube 및 YouTube Music의 게시물 데이터를 포함한 zip을 선택하세요."
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
