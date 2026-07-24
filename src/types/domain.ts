export type SnsPlatform = "facebook" | "instagram" | "threads" | "youtube" | "x" | "naver-blog" | "other";

export type ExportField = "comments" | "images" | "summary" | "tags";

export type ImageLayout = "collage" | "individual";

export type PdfSplitMode = "year" | "date-range" | "page-count";

export type StorageLayout = "platform-month" | "month-platform";

export type ThemeMode = "light" | "dark";

export type LlmProviderId = string;

export interface LlmProviderOption {
  id: LlmProviderId;
  label: string;
  modelLabel: string;
  serverKeyName?: string;
}

export interface SnsAccountConfig {
  id: string;
  platform: SnsPlatform;
  label: string;
  url: string;
  requiresLogin: boolean;
  exportToObsidian: boolean;
  username?: string;
  credentialKey?: string;
}

export interface ObsidianExportConfig {
  ownerUrl: string;
  accounts: SnsAccountConfig[];
  vaultPath: string;
  selectedFields: ExportField[];
  storageLayout: StorageLayout;
}

export interface PdfExportConfig {
  sourceFolder: string;
  outputFolder: string;
  splitMode: PdfSplitMode;
  selectedFields: ExportField[];
  imageLayout: ImageLayout;
  year: string;
  dateFrom: string;
  dateTo: string;
  pageCount: number;
}

export interface AppSettings {
  theme: ThemeMode;
  ownerUrl: string;
  obsidianRootFolder: string;
  pdfOutputFolder: string;
  publicOnly: boolean;
  storageLayout: StorageLayout;
  optionalFields: ExportField[];
  pdfFields: ExportField[];
  pdfSplitMode: PdfSplitMode;
  pdfYear: string;
  pdfDateFrom: string;
  pdfDateTo: string;
  pdfPageCount: number;
  imageLayout: ImageLayout;
  selectedLlmProvider: LlmProviderId;
  maxTags: number;
  summaryLines: number;
  accounts: SnsAccountConfig[];
}
