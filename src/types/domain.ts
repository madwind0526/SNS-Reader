export type SnsPlatform = "facebook" | "instagram" | "threads" | "youtube" | "x" | "naver-blog" | "other";

export type ExportField = "comments" | "images" | "summary" | "tags";

export type ImageLayout = "collage" | "individual" | "collage-individual";

export type PdfSplitMode = "year" | "date-range" | "page-count";

export type PdfPageOrientation = "portrait" | "landscape";

export type PdfTextColumnCount = 1 | 2 | 3;

export type PdfStyleTarget = "title" | "date" | "body" | "comments" | "summary" | "tags";

export interface PdfTextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  colorDark: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  lineHeight: number;
}

export interface PdfFontConfig {
  id: string;
  label: string;
  fontFamily: string;
  regularPath: string;
  boldPath?: string;
}

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
  pdfPlatforms: SnsPlatform[];
  pdfSplitMode: PdfSplitMode;
  pdfYear: string;
  pdfDateFrom: string;
  pdfDateTo: string;
  pdfPageCount: number;
  pdfPageOrientation: PdfPageOrientation;
  pdfTextColumnCount: PdfTextColumnCount;
  pdfPortraitCoverImagePath: string;
  pdfLandscapeCoverImagePath: string;
  pdfCoverImagePath: string;
  pdfCornerPatternPath: string;
  pdfFonts: PdfFontConfig[];
  pdfStyles: Record<PdfStyleTarget, PdfTextStyle>;
  imageLayout: ImageLayout;
  selectedLlmProvider: LlmProviderId;
  maxTags: number;
  summaryLines: number;
  accounts: SnsAccountConfig[];
}
