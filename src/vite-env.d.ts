/// <reference types="vite/client" />

import type { AppSettings } from "./types/domain";

declare global {
  interface ImportMetaEnv {
    readonly VITE_LLM_PROVIDERS?: string;
    readonly VITE_LLM_DEFAULT_PROVIDER?: string;
    readonly VITE_LLM_OPENAI_FRONTIER_MODEL?: string;
    readonly VITE_LLM_OPENAI_BALANCED_MODEL?: string;
    readonly VITE_LLM_OPENAI_MODEL?: string;
    readonly VITE_LLM_ANTHROPIC_OPUS_MODEL?: string;
    readonly VITE_LLM_ANTHROPIC_SONNET_MODEL?: string;
    readonly VITE_LLM_ANTHROPIC_MODEL?: string;
    readonly VITE_LLM_GEMINI_PRO_MODEL?: string;
    readonly VITE_LLM_GEMINI_FLASH_MODEL?: string;
    readonly VITE_LLM_GEMINI_MODEL?: string;
    readonly VITE_LLM_DEEPSEEK_PRO_MODEL?: string;
    readonly VITE_LLM_DEEPSEEK_FLASH_MODEL?: string;
    readonly VITE_LLM_MISTRAL_LARGE_MODEL?: string;
    readonly VITE_LLM_MISTRAL_SMALL_MODEL?: string;
    readonly VITE_LLM_QWEN_MAX_MODEL?: string;
    readonly VITE_LLM_OLLAMA_LLAMA_MODEL?: string;
    readonly VITE_LLM_OLLAMA_GEMMA_MODEL?: string;
    readonly VITE_LLM_OLLAMA_QWEN_MODEL?: string;
    readonly VITE_LLM_OLLAMA_DEEPSEEK_MODEL?: string;
    readonly VITE_LLM_OLLAMA_MISTRAL_MODEL?: string;
    readonly VITE_LLM_OLLAMA_MODEL?: string;
    readonly VITE_LLM_CUSTOM_PROVIDER_LABEL?: string;
    readonly VITE_LLM_CUSTOM_MODEL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    readonly snsReader?: {
      clearSettings?: () => Promise<boolean>;
      loadSettings?: () => Promise<Partial<AppSettings> | null>;
      platform: string;
      saveSettings?: (settings: AppSettings) => Promise<boolean>;
    };
  }
}

export {};
