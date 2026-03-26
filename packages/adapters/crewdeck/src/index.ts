/**
 * CrewDeck adapter — thin shim that routes execution through CrewDeck Service.
 *
 * CrewDeck Service handles:
 * - Sandbox readiness gating
 * - Config hydration (SOULS.md, TOOLS.md, SKILLS)
 * - OpenClaw gateway routing (per-agent sandbox)
 * - Config sync-back after runs
 */

export const agentConfigurationDoc = `
## CrewDeck Adapter

This agent runs in an isolated OpenShell sandbox managed by CrewDeck Service.
Sandbox provisioning, config hydration, and sync-back are handled automatically.

No configuration needed — the adapter is pre-configured for your environment.
`;

export const models = [
  { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
];
