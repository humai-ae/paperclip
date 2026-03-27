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

const GATEWAY_CONNECTIVITY_ERROR_CODES = new Set<string>([
  "openclaw_gateway_request_failed",
  "openclaw_gateway_timeout",
]);

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function ensureReady(
  agentId: string,
  runApiKey: string,
  options: { profileAdapterType: string; model: string },
): Promise<EnsureReadyResult> {
  try {
    const res = await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/ensure-ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runApiKey,
        profileAdapterType: options.profileAdapterType,
        model: options.model,
      }),
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

function isGatewayConnectivityFailure(result: AdapterExecutionResult): boolean {
  const code = typeof result.errorCode === "string" ? result.errorCode : "";
  if (!GATEWAY_CONNECTIVITY_ERROR_CODES.has(code)) return false;
  if (hasMeaningfulModelOutput(result)) return false;
  const message = (typeof result.errorMessage === "string" ? result.errorMessage : "").trim().toLowerCase();
  if (!message) return true;
  return /websocket|gateway|connect|connection|socket|refused|not connected|closed/.test(message);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const agentId = ctx.agent.id;
  const runApiKey = typeof ctx.authToken === "string" ? ctx.authToken.trim() : "";
  if (!runApiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "CrewDeck requires a Paperclip run API token in auth context for ensure-ready.",
      errorCode: "crewdeck_missing_run_api_key",
    };
  }

  const profileAdapterType = asNonEmptyString((ctx.config as Record<string, unknown>).profileAdapterType);
  const model = asNonEmptyString((ctx.config as Record<string, unknown>).model);
  if (!profileAdapterType) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "crewdeck_missing_profile_adapter_type",
      errorMessage: "CrewDeck requires adapterConfig.profileAdapterType for strict provisioning.",
    };
  }
  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "crewdeck_missing_profile_model",
      errorMessage: "CrewDeck requires adapterConfig.model for strict provisioning.",
    };
  }
  const status = await ensureReady(agentId, runApiKey, { profileAdapterType, model });

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

  const runOnce = async (ready: EnsureReadySuccess): Promise<{
    result: AdapterExecutionResult;
    transient: { matched: boolean; message: string };
  }> => {
    const runConfig = {
      ...ctx.config,
      url: `ws://localhost:${ready.gatewayPort}`,
      ...(ready.gatewayToken ? { authToken: ready.gatewayToken } : {}),
    };
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

  const attempt = await runOnce(status);
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

  if (isGatewayConnectivityFailure(result)) {
    await ctx.onLog(
      "stderr",
      "[crewdeck] gateway connectivity failure detected; re-running ensure-ready and retrying once\n",
    );
    const refreshed = await ensureReady(agentId, runApiKey, { profileAdapterType, model });
    if (refreshed.ready) {
      const retry = await runOnce(refreshed);
      if (retry.transient.matched) {
        await ctx.onLog(
          "stderr",
          "[crewdeck] transient provider availability detected after connectivity retry; failing run for retry\n",
        );
        await syncBack(agentId);
        return {
          ...retry.result,
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "crewdeck_provider_unavailable",
          errorMessage: retry.result.errorMessage ?? retry.transient.message,
        };
      }
      await syncBack(agentId);
      return retry.result;
    }
  }

  await syncBack(agentId);

  return result;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return openclawTestEnvironment(ctx);
}
