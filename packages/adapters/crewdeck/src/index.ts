/**
 * CrewDeck adapter — thin shim that routes execution through CrewDeck Service.
 *
 * CrewDeck Service handles:
 * - Sandbox readiness gating and provisioning
 * - OpenClaw gateway routing (per-agent sandbox)
 * - Snapshot restore/export of OpenClaw filesystem state
 */

export const agentConfigurationDoc = `
## CrewDeck Adapter

This agent runs in an isolated OpenShell sandbox managed by CrewDeck Service.
Sandbox provisioning, snapshot restore, and sync-back are handled automatically.

Required config:
- profileAdapterType: selected local adapter profile from onboarding/create flow
- model: preferred provider/model (for example anthropic/claude-opus-4-6)
`;

export const models = [
  { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "openai/gpt-5.4", label: "GPT-5.4" },
  { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "xai/grok-4", label: "Grok 4" },
];
