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

const TRANSIENT_PROVIDER_PATTERNS: RegExp[] = [
  /\b(?:service|model|provider)\s+unavailable\b/i,
  /\btemporar(?:y|ily)\s+unavailable\b/i,
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /\brate\s*limit(?:ed)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bHTTP\s*429\b/i,
  /\btry\s+again\s+(?:later|soon)\b/i,
];

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

function looksLikeTransientProviderFailure(result: AdapterExecutionResult): { matched: boolean; message: string } {
  const fragments = [
    typeof result.errorMessage === "string" ? result.errorMessage : "",
    typeof result.summary === "string" ? result.summary : "",
  ];

  if (result.resultJson) {
    fragments.push(JSON.stringify(result.resultJson));
  }

  const haystack = fragments.filter(Boolean).join("\n");
  const match = TRANSIENT_PROVIDER_PATTERNS.find((pattern) => pattern.test(haystack));
  return {
    matched: Boolean(match),
    message: match
      ? `Upstream model/provider unavailable (${match.source}).`
      : "",
  };
}

function firstMatchingTransientLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (TRANSIENT_PROVIDER_PATTERNS.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

function hasMeaningfulModelOutput(result: AdapterExecutionResult): boolean {
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (summary.length > 0) return true;
  const outputTokens = result.usage?.outputTokens ?? 0;
  return outputTokens > 0;
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

  const runConfig = {
    ...ctx.config,
    url: `ws://localhost:${status.gatewayPort}`,
    ...(status.gatewayToken ? { authToken: status.gatewayToken } : {}),
  };

  const runOnce = async (): Promise<{
    result: AdapterExecutionResult;
    transient: { matched: boolean; message: string };
  }> => {
    let transientFromLogs: string | null = null;
    const result = await openclawExecute({
      ...ctx,
      onLog: async (stream, chunk) => {
        if (transientFromLogs === null && (stream === "stderr" || stream === "stdout")) {
          transientFromLogs = firstMatchingTransientLine(chunk);
        }
        await ctx.onLog(stream, chunk);
      },
      config: runConfig,
    });

    const transientFromResult = looksLikeTransientProviderFailure(result);
    if (transientFromResult.matched) {
      return { result, transient: transientFromResult };
    }

    if (transientFromLogs && !hasMeaningfulModelOutput(result)) {
      return {
        result,
        transient: {
          matched: true,
          message: `Upstream model/provider unavailable (${transientFromLogs}).`,
        },
      };
    }

    return { result, transient: { matched: false, message: "" } };
  };

  const attempt = await runOnce();
  const result = attempt.result;
  const transient = attempt.transient;

  if (transient.matched) {
    await ctx.onLog(
      "stderr",
      "[crewdeck] transient provider availability detected; failing this run so scheduler/manual retry can use a fresh run id\n",
    );
    await syncBack(agentId);
    return {
      ...result,
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "crewdeck_provider_unavailable",
      errorMessage: result.errorMessage ?? transient.message,
    };
  }

  await syncBack(agentId);

  return result;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return openclawTestEnvironment(ctx);
}
