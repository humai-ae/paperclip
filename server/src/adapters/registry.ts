import type { ServerAdapterModule } from "./types.js";
import {
  execute as crewdeckExecute,
  testEnvironment as crewdeckTestEnvironment,
} from "@paperclipai/adapter-crewdeck/server";
import {
  agentConfigurationDoc as crewdeckAgentConfigurationDoc,
  models as crewdeckModels,
} from "@paperclipai/adapter-crewdeck";

// ── CrewDeck: single adapter, all agents use sandboxed OpenClaw ──

const crewdeckAdapter: ServerAdapterModule = {
  type: "crewdeck",
  execute: crewdeckExecute,
  testEnvironment: crewdeckTestEnvironment,
  models: crewdeckModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: crewdeckAgentConfigurationDoc,
};

const adaptersByType = new Map<string, ServerAdapterModule>(
  [crewdeckAdapter].map((a) => [a.type, a]),
);

export function getServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // All agents use crewdeck adapter
    return crewdeckAdapter;
  }
  return adapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type) ?? crewdeckAdapter;
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}
