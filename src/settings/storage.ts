import { defaultSettings, SETTINGS_STORAGE_KEY } from "./defaults";
import type { AppSettings, PdfStyleTarget, PdfTextStyle } from "../types/domain";

function persistSettingsFile(settings: AppSettings) {
  const fileSave =
    window.snsReader?.saveSettings?.(settings) ??
    fetch("/api/settings", {
      body: JSON.stringify(settings),
      headers: {
        "Content-Type": "application/json"
      },
      method: "PUT"
    }).then((response) => response.ok);

  void fileSave.catch((error: unknown) => {
    console.error("Failed to save settings file.", error);
  });
}

function normalizeLlmProviderId(providerId: AppSettings["selectedLlmProvider"] | undefined) {
  return providerId?.startsWith("ollama-") ? "ollama" : providerId;
}

const legacyPdfStyles: Partial<Record<PdfStyleTarget, Partial<PdfTextStyle>>> = {
  title: { fontSize: 18, lineHeight: 1.25 },
  date: { fontSize: 9, lineHeight: 1.2 },
  body: { fontSize: 11, lineHeight: 1.55 },
  comments: { fontSize: 9, lineHeight: 1.4 },
  summary: { fontSize: 10, lineHeight: 1.4 },
  tags: { fontSize: 9, lineHeight: 1.25 }
};

function normalizePdfStyleTarget(target: PdfStyleTarget, parsedStyle: Partial<PdfTextStyle> | undefined) {
  if (!parsedStyle) {
    return defaultSettings.pdfStyles[target];
  }

  const legacyStyle = legacyPdfStyles[target];
  const isLegacyDefault =
    legacyStyle &&
    Object.entries(legacyStyle).every(([key, value]) => parsedStyle[key as keyof PdfTextStyle] === value);

  if (isLegacyDefault) {
    return defaultSettings.pdfStyles[target];
  }

  return { ...defaultSettings.pdfStyles[target], ...parsedStyle };
}

function normalizeSettings(parsed: Partial<AppSettings>): AppSettings {
  const pdfFields = (parsed.pdfFields ?? defaultSettings.pdfFields) as AppSettings["pdfFields"];
  const parsedPdfStyles = (parsed.pdfStyles ?? {}) as Partial<Record<PdfStyleTarget, Partial<PdfTextStyle>>>;
  const isLegacyDefaultPdfRange =
    parsed.pdfYear === "2026" &&
    parsed.pdfDateFrom === "2026-01-01" &&
    parsed.pdfDateTo === "2026-12-31" &&
    parsed.pdfPageCount === 200;

  return {
    ...defaultSettings,
    ...parsed,
    pdfFields: Array.from(new Set([...pdfFields, "comments"])) as AppSettings["pdfFields"],
    pdfYear: isLegacyDefaultPdfRange ? defaultSettings.pdfYear : parsed.pdfYear ?? defaultSettings.pdfYear,
    pdfDateFrom: isLegacyDefaultPdfRange ? defaultSettings.pdfDateFrom : parsed.pdfDateFrom ?? defaultSettings.pdfDateFrom,
    pdfDateTo: isLegacyDefaultPdfRange ? defaultSettings.pdfDateTo : parsed.pdfDateTo ?? defaultSettings.pdfDateTo,
    pdfPageCount: isLegacyDefaultPdfRange ? defaultSettings.pdfPageCount : parsed.pdfPageCount ?? defaultSettings.pdfPageCount,
    pdfPageOrientation: parsed.pdfPageOrientation ?? defaultSettings.pdfPageOrientation,
    pdfTextColumnCount:
      parsed.pdfPageOrientation === "landscape" && parsed.pdfTextColumnCount === 1
        ? 2
        : parsed.pdfTextColumnCount === 3 && parsed.pdfPageOrientation !== "landscape"
          ? 2
          : parsed.pdfTextColumnCount ?? defaultSettings.pdfTextColumnCount,
    pdfCoverImagePath: parsed.pdfCoverImagePath ?? defaultSettings.pdfCoverImagePath,
    pdfStyles: {
      title: normalizePdfStyleTarget("title", parsedPdfStyles.title),
      date: normalizePdfStyleTarget("date", parsedPdfStyles.date),
      body: normalizePdfStyleTarget("body", parsedPdfStyles.body),
      comments: normalizePdfStyleTarget("comments", parsedPdfStyles.comments),
      summary: normalizePdfStyleTarget("summary", parsedPdfStyles.summary),
      tags: normalizePdfStyleTarget("tags", parsedPdfStyles.tags)
    },
    selectedLlmProvider: normalizeLlmProviderId(parsed.selectedLlmProvider) ?? defaultSettings.selectedLlmProvider,
    accounts: (parsed.accounts ?? defaultSettings.accounts).map((account) => ({
      ...account,
      exportToObsidian: account.exportToObsidian ?? true
    }))
  };
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return defaultSettings;
  }

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

  if (!raw) {
    return defaultSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const settings = normalizeSettings(parsed);

    persistSettingsFile(settings);
    return settings;
  } catch {
    return defaultSettings;
  }
}

export async function loadSettingsFile(): Promise<AppSettings | null> {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const parsed =
      (await window.snsReader?.loadSettings?.()) ??
      (await fetch("/api/settings")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null));

    if (!parsed) {
      return null;
    }

    const settings = normalizeSettings(parsed as Partial<AppSettings>);

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return settings;
  } catch (error) {
    console.error("Failed to load settings file.", error);
    return null;
  }
}

export function saveSettings(settings: AppSettings) {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  persistSettingsFile(settings);
}

export function clearSettings() {
  window.localStorage.removeItem(SETTINGS_STORAGE_KEY);

  const fileClear =
    window.snsReader?.clearSettings?.() ??
    fetch("/api/settings", {
      method: "DELETE"
    }).then((response) => response.ok);

  void fileClear.catch((error: unknown) => {
    console.error("Failed to clear settings file.", error);
  });
}
