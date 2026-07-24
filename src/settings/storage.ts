import { defaultSettings, SETTINGS_STORAGE_KEY } from "./defaults";
import type { AppSettings } from "../types/domain";

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

function normalizeSettings(parsed: Partial<AppSettings>): AppSettings {
  const pdfFields = (parsed.pdfFields ?? defaultSettings.pdfFields) as AppSettings["pdfFields"];

  return {
    ...defaultSettings,
    ...parsed,
    pdfFields: Array.from(new Set([...pdfFields, "comments"])) as AppSettings["pdfFields"],
    pdfYear: parsed.pdfYear ?? defaultSettings.pdfYear,
    pdfDateFrom: parsed.pdfDateFrom ?? defaultSettings.pdfDateFrom,
    pdfDateTo: parsed.pdfDateTo ?? defaultSettings.pdfDateTo,
    pdfPageCount: parsed.pdfPageCount ?? defaultSettings.pdfPageCount,
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
