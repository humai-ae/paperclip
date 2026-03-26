import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  execute as openclawExecute,
  testEnvironment as openclawTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";

const CREWDECK_SERVICE_URL = process.env.CREWDECK_SERVICE_URL ?? "http://localhost:3200";

interface SandboxStatus {
  ready: boolean;
  status: string;
  gatewayPort: number;
  gatewayToken: string | null;
}

async function getSandboxStatus(agentId: string): Promise<SandboxStatus | null> {
  try {
    const res = await fetch(`${CREWDECK_SERVICE_URL}/api/agents/${agentId}/status`);
    if (!res.ok) return null;
    return (await res.json()) as SandboxStatus;
  } catch {
    return null;
  }
}

async function hydrate(agentId: string): Promise<void> {
  try {
    await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/hydrate`, { method: "POST" });
  } catch {
    // Non-fatal — agent can still run without stored configs
  }
}

async function syncBack(agentId: string): Promise<void> {
  try {
    await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/sync-back`, { method: "POST" });
  } catch {
    // Non-fatal — configs will be synced on next opportunity
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const agentId = ctx.agent.id;

  // Check sandbox readiness with CrewDeck Service
  const status = await getSandboxStatus(agentId);

  if (!status) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Agent not registered with CrewDeck Service",
      errorCode: "crewdeck_agent_not_found",
    };
  }

  if (!status.ready) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Sandbox not ready (status: ${status.status}). Will retry on next heartbeat.`,
      errorCode: "crewdeck_sandbox_not_ready",
    };
  }

  // Override adapter config with sandbox-specific gateway details
  const overriddenCtx: AdapterExecutionContext = {
    ...ctx,
    config: {
      ...ctx.config,
      url: `ws://localhost:${status.gatewayPort}`,
      ...(status.gatewayToken ? { authToken: status.gatewayToken } : {}),
    },
  };

  // Hydrate sandbox with stored configs before execution
  await hydrate(agentId);

  // Delegate to OpenClaw gateway adapter
  const result = await openclawExecute(overriddenCtx);

  // Sync config changes back to CrewDeck Service DB
  await syncBack(agentId);

  return result;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  // Delegate to OpenClaw's test
  return openclawTestEnvironment(ctx);
}
