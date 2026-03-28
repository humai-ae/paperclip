export const LOCAL_PROFILE_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
] as const;

export type LocalProfileAdapterType = (typeof LOCAL_PROFILE_ADAPTER_TYPES)[number];

const LOCAL_PROFILE_ADAPTER_TYPE_SET = new Set<LocalProfileAdapterType>(LOCAL_PROFILE_ADAPTER_TYPES);

export function isLocalProfileAdapterType(value: string): value is LocalProfileAdapterType {
  return LOCAL_PROFILE_ADAPTER_TYPE_SET.has(value as LocalProfileAdapterType);
}

export const LOCAL_PROFILE_DEFAULT_MODEL_BY_TYPE: Record<LocalProfileAdapterType, string> = {
  claude_local: "anthropic/claude-opus-4-6",
  codex_local: "openai/gpt-5.4",
  gemini_local: "google/gemini-2.5-pro",
  opencode_local: "openai/gpt-5.4",
  pi_local: "anthropic/claude-opus-4-6",
  cursor: "openai/gpt-5.4",
};
