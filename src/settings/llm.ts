import type { LlmProviderOption } from "../types/domain";

const providerCatalog: Record<string, LlmProviderOption> = {
  "local-preview": {
    id: "local-preview",
    label: "Local (No LLM)",
    modelLabel: "No LLM",
  },
  "openai-frontier": {
    id: "openai-frontier",
    label: "OpenAI",
    modelLabel: import.meta.env.VITE_LLM_OPENAI_FRONTIER_MODEL || "gpt-5.6-sol",
    serverKeyName: "OPENAI_API_KEY",
  },
  "openai-balanced": {
    id: "openai-balanced",
    label: "OpenAI",
    modelLabel: import.meta.env.VITE_LLM_OPENAI_BALANCED_MODEL || "gpt-5.6-terra",
    serverKeyName: "OPENAI_API_KEY",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    modelLabel: import.meta.env.VITE_LLM_OPENAI_MODEL || "Server-side model",
    serverKeyName: "OPENAI_API_KEY",
  },
  "anthropic-opus": {
    id: "anthropic-opus",
    label: "Anthropic",
    modelLabel: import.meta.env.VITE_LLM_ANTHROPIC_OPUS_MODEL || "claude-opus-4-8",
    serverKeyName: "ANTHROPIC_API_KEY",
  },
  "anthropic-sonnet": {
    id: "anthropic-sonnet",
    label: "Anthropic",
    modelLabel: import.meta.env.VITE_LLM_ANTHROPIC_SONNET_MODEL || "claude-sonnet-4-6",
    serverKeyName: "ANTHROPIC_API_KEY",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    modelLabel: import.meta.env.VITE_LLM_ANTHROPIC_MODEL || "Server-side model",
    serverKeyName: "ANTHROPIC_API_KEY",
  },
  "gemini-pro": {
    id: "gemini-pro",
    label: "Google Gemini",
    modelLabel: import.meta.env.VITE_LLM_GEMINI_PRO_MODEL || "gemini-3-pro",
    serverKeyName: "GEMINI_API_KEY",
  },
  "gemini-flash": {
    id: "gemini-flash",
    label: "Google Gemini",
    modelLabel: import.meta.env.VITE_LLM_GEMINI_FLASH_MODEL || "gemini-3.6-flash",
    serverKeyName: "GEMINI_API_KEY",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    modelLabel: import.meta.env.VITE_LLM_GEMINI_MODEL || "Server-side model",
    serverKeyName: "GEMINI_API_KEY",
  },
  "deepseek-pro": {
    id: "deepseek-pro",
    label: "DeepSeek",
    modelLabel: import.meta.env.VITE_LLM_DEEPSEEK_PRO_MODEL || "deepseek-v4-pro",
    serverKeyName: "DEEPSEEK_API_KEY",
  },
  "deepseek-flash": {
    id: "deepseek-flash",
    label: "DeepSeek",
    modelLabel: import.meta.env.VITE_LLM_DEEPSEEK_FLASH_MODEL || "deepseek-v4-flash",
    serverKeyName: "DEEPSEEK_API_KEY",
  },
  "mistral-large": {
    id: "mistral-large",
    label: "Mistral AI",
    modelLabel: import.meta.env.VITE_LLM_MISTRAL_LARGE_MODEL || "mistral-large-latest",
    serverKeyName: "MISTRAL_API_KEY",
  },
  "mistral-small": {
    id: "mistral-small",
    label: "Mistral AI",
    modelLabel: import.meta.env.VITE_LLM_MISTRAL_SMALL_MODEL || "mistral-small-latest",
    serverKeyName: "MISTRAL_API_KEY",
  },
  "qwen-max": {
    id: "qwen-max",
    label: "Qwen",
    modelLabel: import.meta.env.VITE_LLM_QWEN_MAX_MODEL || "qwen3.7-max",
    serverKeyName: "QWEN_API_KEY",
  },
  "ollama-llama": {
    id: "ollama-llama",
    label: "Local Ollama",
    modelLabel: import.meta.env.VITE_LLM_OLLAMA_LLAMA_MODEL || "llama3.3:70b",
    serverKeyName: "OLLAMA_BASE_URL",
  },
  "ollama-gemma": {
    id: "ollama-gemma",
    label: "Local Ollama",
    modelLabel: import.meta.env.VITE_LLM_OLLAMA_GEMMA_MODEL || "gemma4:latest",
    serverKeyName: "OLLAMA_BASE_URL",
  },
  "ollama-qwen": {
    id: "ollama-qwen",
    label: "Local Ollama",
    modelLabel: import.meta.env.VITE_LLM_OLLAMA_QWEN_MODEL || "qwen3.5:35b",
    serverKeyName: "OLLAMA_BASE_URL",
  },
  "ollama-deepseek": {
    id: "ollama-deepseek",
    label: "Local Ollama",
    modelLabel: import.meta.env.VITE_LLM_OLLAMA_DEEPSEEK_MODEL || "deepseek-r1:8b",
    serverKeyName: "OLLAMA_BASE_URL",
  },
  "ollama-mistral": {
    id: "ollama-mistral",
    label: "Local Ollama",
    modelLabel: import.meta.env.VITE_LLM_OLLAMA_MISTRAL_MODEL || "mistral-small3.2:24b",
    serverKeyName: "OLLAMA_BASE_URL",
  },
  ollama: {
    id: "ollama",
    label: "Local Ollama",
    modelLabel: import.meta.env.VITE_LLM_OLLAMA_MODEL || "gemma4:latest",
    serverKeyName: "OLLAMA_BASE_URL",
  },
  custom: {
    id: "custom",
    label: import.meta.env.VITE_LLM_CUSTOM_PROVIDER_LABEL || "Custom Provider",
    modelLabel: import.meta.env.VITE_LLM_CUSTOM_MODEL || "Custom model",
    serverKeyName: "SNS_READER_LLM_API_KEY",
  },
};

const compactProviderIds = ["local-preview", "ollama", "openai-frontier", "gemini-flash", "custom"];

function normalizeProviderId(providerId: string) {
  return providerId.startsWith("ollama-") ? "ollama" : providerId;
}

export function getAvailableLlmProviders(): LlmProviderOption[] {
  const providerIds = Array.from(new Set(compactProviderIds));
  const providers = providerIds
    .map((providerId) => providerCatalog[providerId])
    .filter((provider): provider is LlmProviderOption => Boolean(provider));

  if (!providers.some((provider) => provider.id === "local-preview")) {
    return [providerCatalog["local-preview"], ...providers];
  }

  return providers;
}

export function getPreferredLlmProvider(providers: LlmProviderOption[], selectedProviderId: string) {
  const normalizedSelectedProviderId = normalizeProviderId(selectedProviderId);
  const normalizedDefaultProviderId = normalizeProviderId(import.meta.env.VITE_LLM_DEFAULT_PROVIDER ?? "");

  return (
    providers.find((provider) => provider.id === normalizedSelectedProviderId) ??
    providers.find((provider) => provider.id === normalizedDefaultProviderId) ??
    providers[0] ??
    providerCatalog["local-preview"]
  );
}
