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

interface EnsureReadySuccess {
  ready: true;
  gatewayPort: number;
  gatewayToken: string | null;
}

interface EnsureReadyError {
  ready: false;
  error: string;
  errorCode: string;
}

type EnsureReadyResult = EnsureReadySuccess | EnsureReadyError;

async function ensureReady(agentId: string): Promise<EnsureReadyResult> {
  try {
    const res = await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/ensure-ready`, {
      method: "POST",
    });
    if (res.status === 404) {
      return { ready: false, error: "Agent not registered with CrewDeck Service", errorCode: "crewdeck_agent_not_found" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ready: false, error: `CrewDeck Service error (${res.status}): ${text}`, errorCode: "crewdeck_service_error" };
    }
    return (await res.json()) as EnsureReadySuccess;
  } catch (err) {
    return { ready: false, error: `CrewDeck Service unreachable: ${err instanceof Error ? err.message : String(err)}`, errorCode: "crewdeck_service_unreachable" };
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

  if (!status.ready) {
    const err = status as EnsureReadyError;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: err.error,
      errorCode: err.errorCode,
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
