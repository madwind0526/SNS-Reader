import type { AppSettings, ExportField, PdfStyleTarget, PdfTextStyle, SnsPlatform } from "../types/domain";

import type { PdfFontConfig } from "../types/domain";

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
  colorDark: "#e8e6df",
  bold: false,
  italic: false,
  underline: false,
  lineHeight: 1.2
};

export const defaultPdfFonts: PdfFontConfig[] = [
  {
    id: "malgun-gothic",
    label: "Malgun Gothic",
    fontFamily: "Malgun Gothic",
    regularPath: "C:\\Windows\\Fonts\\malgun.ttf",
    boldPath: "C:\\Windows\\Fonts\\malgunbd.ttf"
  },
  {
    id: "noto-sans-kr",
    label: "Noto Sans KR",
    fontFamily: "Noto Sans KR",
    regularPath: "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf",
    boldPath: "C:\\Windows\\Fonts\\NotoSansKR-Bold.ttf"
  },
  {
    id: "nanum-gothic",
    label: "Nanum Gothic",
    fontFamily: "NanumGothic",
    regularPath: "C:\\Windows\\Fonts\\NanumGothic.ttf",
    boldPath: "C:\\Windows\\Fonts\\NanumGothicBold.ttf"
  },
  {
    id: "kopub-batang",
    label: "KoPub Batang",
    fontFamily: "KoPub Batang",
    regularPath: "C:\\Windows\\Fonts\\KoPubBatangMedium.ttf",
    boldPath: "C:\\Windows\\Fonts\\KoPubBatangBold.ttf"
  }
];

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
  pdfPlatforms: [],
  pdfSplitMode: "year",
  pdfYear: "",
  pdfDateFrom: "",
  pdfDateTo: "",
  pdfPageCount: 0,
  pdfPageOrientation: "portrait",
  pdfTextColumnCount: 2,
  pdfPortraitCoverImagePath: "assets\\Cover-Long3.jpeg",
  pdfLandscapeCoverImagePath: "assets\\Cover-Wide2.png",
  pdfCoverImagePath: "assets\\Cover-Long3.jpeg",
  pdfCornerPatternPath: "assets\\korean-corner-pattern-1.jpeg",
  pdfFonts: defaultPdfFonts,
  pdfStyles: {
    title: { ...defaultPdfTextStyle, fontSize: 16, color: "#111111", colorDark: "#f5f5f0", bold: true, lineHeight: 1.18 },
    date: { ...defaultPdfTextStyle, fontSize: 8, color: "#666666", colorDark: "#b7bdb9", lineHeight: 1.05 },
    body: { ...defaultPdfTextStyle, fontSize: 9.5, color: "#222222", colorDark: "#e8e6df", lineHeight: 1.18 },
    comments: { ...defaultPdfTextStyle, fontSize: 8.5, color: "#555555", colorDark: "#c7ccc8", lineHeight: 1.15 },
    summary: { ...defaultPdfTextStyle, fontSize: 8.8, color: "#333333", colorDark: "#d8d5cb", italic: true, lineHeight: 1.16 },
    tags: { ...defaultPdfTextStyle, fontSize: 8.5, color: "#1f6f68", colorDark: "#8ed8c8", bold: true, lineHeight: 1.12 }
  },
  imageLayout: "collage",
  selectedLlmProvider: "openai-frontier",
  maxTags: 10,
  summaryLines: 2,
  snsUpdateLookbackDays: 3,
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

