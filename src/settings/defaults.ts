import type { AppSettings, ExportField, PdfStyleTarget, PdfTextStyle, SnsPlatform } from "../types/domain";

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

const defaultPdfTextStyle: PdfTextStyle = {
  fontFamily: "Malgun Gothic",
  fontSize: 9.5,
  color: "#222222",
  bold: false,
  italic: false,
  underline: false,
  lineHeight: 1.2
};

export const pdfStyleLabels: Record<PdfStyleTarget, string> = {
  title: "제목",
  date: "날짜",
  body: "본문",
  comments: "댓글",
  summary: "요약",
  tags: "TAG"
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
  pdfYear: "",
  pdfDateFrom: "",
  pdfDateTo: "",
  pdfPageCount: 0,
  pdfPageOrientation: "portrait",
  pdfTextColumnCount: 2,
  pdfCoverImagePath: "assets\\heart-food-journal-cover.jpeg",
  pdfStyles: {
    title: { ...defaultPdfTextStyle, fontSize: 16, color: "#111111", bold: true, lineHeight: 1.18 },
    date: { ...defaultPdfTextStyle, fontSize: 8, color: "#666666", lineHeight: 1.05 },
    body: { ...defaultPdfTextStyle, fontSize: 9.5, color: "#222222", lineHeight: 1.18 },
    comments: { ...defaultPdfTextStyle, fontSize: 8.5, color: "#555555", lineHeight: 1.15 },
    summary: { ...defaultPdfTextStyle, fontSize: 8.8, color: "#333333", italic: true, lineHeight: 1.16 },
    tags: { ...defaultPdfTextStyle, fontSize: 8.5, color: "#1f6f68", bold: true, lineHeight: 1.12 }
  },
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

