import type { AppSettings, ExportField, SnsPlatform } from "../types/domain";

export const SETTINGS_STORAGE_KEY = "sns-reader.settings.v2";

export const platformLabels: Record<SnsPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  youtube: "YouTube",
  x: "X",
  "naver-blog": "Naver Blog",
  other: "Other"
};

export const fieldLabels: Record<ExportField, string> = {
  comments: "Comments",
  images: "Images",
  summary: "Summary",
  tags: "Tags"
};

export const defaultSettings: AppSettings = {
  theme: "light",
  ownerUrl: "",
  obsidianRootFolder: "C:\\Users\\me\\Obsidian\\SNS",
  pdfOutputFolder: "C:\\Users\\me\\Documents\\SNS Books",
  publicOnly: true,
  storageLayout: "platform-month",
  optionalFields: ["images", "summary", "tags"],
  pdfFields: ["comments", "images", "summary", "tags"],
  pdfSplitMode: "year",
  pdfYear: "2026",
  pdfDateFrom: "2026-01-01",
  pdfDateTo: "2026-12-31",
  pdfPageCount: 200,
  imageLayout: "collage",
  selectedLlmProvider: "openai-frontier",
  maxTags: 10,
  summaryLines: 2,
  accounts: [
    {
      id: "sample-facebook",
      platform: "facebook",
      label: "Family FB",
      url: "https://facebook.com/example",
      requiresLogin: false,
      exportToObsidian: true
    },
    {
      id: "sample-instagram",
      platform: "instagram",
      label: "Travel Insta",
      url: "https://instagram.com/example",
      requiresLogin: false,
      exportToObsidian: true
    },
    {
      id: "sample-youtube",
      platform: "youtube",
      label: "Study YouTube",
      url: "https://youtube.com/@example",
      requiresLogin: true,
      exportToObsidian: true
    },
    {
      id: "sample-x",
      platform: "x",
      label: "Daily X",
      url: "https://x.com/example",
      requiresLogin: false,
      exportToObsidian: false
    },
    {
      id: "sample-naver",
      platform: "naver-blog",
      label: "Naver Blog",
      url: "https://blog.naver.com/example",
      requiresLogin: false,
      exportToObsidian: true
    }
  ]
};
