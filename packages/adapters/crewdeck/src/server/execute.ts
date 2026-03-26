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

interface EnsureReadyResponse {
  ready: boolean;
  gatewayPort: number;
  gatewayToken: string | null;
  error?: string;
}

async function ensureReady(agentId: string): Promise<EnsureReadyResponse | null> {
  try {
    const res = await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/ensure-ready`, {
      method: "POST",
    });
    if (!res.ok) return null;
    return (await res.json()) as EnsureReadyResponse;
  } catch {
    return null;
  }
}

async function syncBack(agentId: string): Promise<void> {
  try {
    await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/sync-back`, { method: "POST" });
  } catch {
    // non-fatal
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const agentId = ctx.agent.id;

  const status = await ensureReady(agentId);

  if (!status || !status.ready) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: status?.error ?? "Failed to ensure sandbox is ready",
      errorCode: "crewdeck_sandbox_not_ready",
    };
  }

  const result = await openclawExecute({
    ...ctx,
    config: {
      ...ctx.config,
      url: `ws://localhost:${status.gatewayPort}`,
      ...(status.gatewayToken ? { authToken: status.gatewayToken } : {}),
    },
  });

  await syncBack(agentId);

  return result;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return openclawTestEnvironment(ctx);
}
