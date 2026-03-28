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
const ENSURE_READY_TIMEOUT_MS = 180_000;

interface EnsureReadySuccess {
  ready: true;
  gatewayPort: number;
  gatewayToken: string | null;
  sandboxCreated?: boolean;
  workspaceRestored?: boolean;
  gatewayStarted?: boolean;
  forwardStarted?: boolean;
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
const PROVIDER_AUTH_PATTERNS: RegExp[] = [
  /\bHTTP\s*401\b/i,
  /\bauthentication_error\b/i,
  /\binvalid bearer token\b/i,
  /\bunauthorized\b/i,
  /\binvalid api key\b/i,
  /\bfailoverReason["']?\s*:\s*["']auth\b/i,
];
const APPROVAL_REQUIRED_PATTERNS: RegExp[] = [
  /\/approve\s+[a-z0-9_-]+\s+allow-always/i,
  /\bi need approval\b/i,
  /\bplease run:\s*`?\/approve\b/i,
  /\bapproval required\b/i,
];

export const COMPLETION_SIGNAL_RE = /^CREWDECK_RUN_COMPLETE\s*$/m;

const GATEWAY_CONNECTIVITY_ERROR_CODES = new Set<string>([
  "openclaw_gateway_request_failed",
  "openclaw_gateway_timeout",
]);
const LOCAL_PROFILE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
]);
const DEFAULT_SANDBOX_PAPERCLIP_API_URL = "http://paperclip.openshell.svc.cluster.local:3100";

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSandboxPaperclipApiUrl(): string {
  const configured =
    asNonEmptyString(process.env.PAPERCLIP_SANDBOX_API_URL) ??
    asNonEmptyString(process.env.PAPERCLIP_API_URL);
  if (!configured) return DEFAULT_SANDBOX_PAPERCLIP_API_URL;

  try {
    const parsed = new URL(configured);
    const normalizedHost = parsed.hostname.trim().toLowerCase();
    if (
      normalizedHost === "paperclip" ||
      normalizedHost === "localhost" ||
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "::1"
    ) {
      return DEFAULT_SANDBOX_PAPERCLIP_API_URL;
    }
    return parsed.toString();
  } catch {
    return DEFAULT_SANDBOX_PAPERCLIP_API_URL;
  }
}

/**
 * Read an NDJSON stream from the service. Logs each step line in real-time
 * and returns the final result object.
 */
async function readNdjsonResponse(
  res: Response,
  onLog?: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<EnsureReadyResult> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body — fall back to reading the full response as JSON.
    const text = await res.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (json.ready === false && typeof json.error === "string") {
        return json as unknown as EnsureReadyError;
      }
      return json as unknown as EnsureReadySuccess;
    } catch {}
    return { ready: false, error: text || "Empty response", errorCode: "crewdeck_service_error" };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: EnsureReadyResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "step" && onLog) {
          await onLog("stdout", `[crewdeck] ${event.step}: ${event.status}\n`);
        } else if (event.type === "result") {
          if (event.ready) {
            result = event as unknown as EnsureReadySuccess;
          } else {
            return {
              ready: false,
              error: typeof event.error === "string" ? event.error : "Service error",
              errorCode: "crewdeck_service_error",
            } as EnsureReadyError;
          }
        }
      } catch {}
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer) as Record<string, unknown>;
      if (event.type === "result" && event.ready) {
        result = event as unknown as EnsureReadySuccess;
      } else if (event.type === "result") {
        return { ready: false, error: typeof event.error === "string" ? event.error : "Service error", errorCode: "crewdeck_service_error" } as EnsureReadyError;
      }
    } catch {}
  }

  return result ?? { ready: false, error: "No result from service", errorCode: "crewdeck_service_error" };
}

async function servicePost(
  url: string,
  body: string,
  timeoutMs: number,
  onLog?: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<EnsureReadyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body,
    });
    if (res.status === 404) {
      return { ready: false, error: "Agent not registered with CrewDeck Service", errorCode: "crewdeck_agent_not_found" };
    }
    if (res.headers.get("content-type")?.includes("ndjson")) {
      return await readNdjsonResponse(res, onLog);
    }
    // Fallback for non-streaming responses
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ready: false, error: `CrewDeck Service error (${res.status}): ${text}`, errorCode: "crewdeck_service_error" };
    }
    return (await res.json()) as EnsureReadySuccess;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ready: false, error: `CrewDeck Service timed out after ${Math.round(timeoutMs / 1000)}s`, errorCode: "crewdeck_service_timeout" };
    }
    return { ready: false, error: `CrewDeck Service unreachable: ${err instanceof Error ? err.message : String(err)}`, errorCode: "crewdeck_service_unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureReady(
  agentId: string,
  runApiKey: string,
  options: { profileAdapterType: string; model: string },
  onLog?: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<EnsureReadyResult> {
  return servicePost(
    `${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/ensure-ready`,
    JSON.stringify({ runApiKey, profileAdapterType: options.profileAdapterType, model: options.model }),
    ENSURE_READY_TIMEOUT_MS,
    onLog,
  );
}

const ENSURE_CONNECTIVITY_TIMEOUT_MS = 60_000;

async function ensureConnectivity(
  agentId: string,
  runApiKey: string,
  onLog?: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<EnsureReadyResult> {
  return servicePost(
    `${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/ensure-connectivity`,
    JSON.stringify({ runApiKey }),
    ENSURE_CONNECTIVITY_TIMEOUT_MS,
    onLog,
  );
}

async function syncBack(agentId: string): Promise<void> {
  try {
    await fetch(`${CREWDECK_SERVICE_URL}/api/sandbox/${agentId}/sync-back`, { method: "POST" });
  } catch {
    // non-fatal
  }
}

export function looksLikeTransientProviderFailure(result: AdapterExecutionResult): { matched: boolean; message: string } {
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

export function looksLikeProviderAuthFailure(result: AdapterExecutionResult): { matched: boolean; message: string } {
  const fragments = [
    typeof result.errorMessage === "string" ? result.errorMessage : "",
    typeof result.summary === "string" ? result.summary : "",
  ];

  if (result.resultJson) {
    fragments.push(JSON.stringify(result.resultJson));
  }

  const haystack = fragments.filter(Boolean).join("\n");
  const match = PROVIDER_AUTH_PATTERNS.find((pattern) => pattern.test(haystack));
  return {
    matched: Boolean(match),
    message: match
      ? `Upstream provider auth failed (${match.source}).`
      : "",
  };
}

function firstMatchingAuthLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (PROVIDER_AUTH_PATTERNS.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

export function looksLikeApprovalRequired(result: AdapterExecutionResult): { matched: boolean; message: string } {
  const fragments = [
    typeof result.errorMessage === "string" ? result.errorMessage : "",
    typeof result.summary === "string" ? result.summary : "",
  ];

  if (result.resultJson) {
    fragments.push(JSON.stringify(result.resultJson));
  }

  const haystack = fragments.filter(Boolean).join("\n");
  const match = APPROVAL_REQUIRED_PATTERNS.find((pattern) => pattern.test(haystack));
  return {
    matched: Boolean(match),
    message: match
      ? `OpenClaw requested interactive approval (${match.source}).`
      : "",
  };
}

function firstMatchingApprovalLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (APPROVAL_REQUIRED_PATTERNS.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

export function isGatewayConnectivityFailure(result: AdapterExecutionResult): boolean {
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

  const configuredProfileAdapterType = asNonEmptyString((ctx.config as Record<string, unknown>).profileAdapterType);
  const agentAdapterType = asNonEmptyString(ctx.agent.adapterType);
  const fallbackProfileAdapterType = agentAdapterType && LOCAL_PROFILE_ADAPTER_TYPES.has(agentAdapterType)
    ? agentAdapterType
    : null;
  const profileAdapterType = configuredProfileAdapterType ?? fallbackProfileAdapterType;
  if (!configuredProfileAdapterType && fallbackProfileAdapterType) {
    await ctx.onLog(
      "stderr",
      `[crewdeck] adapterConfig.profileAdapterType missing; inferred '${fallbackProfileAdapterType}' from agent.adapterType for ensure-ready\n`,
    );
  }
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
  await ctx.onLog("stdout", `[crewdeck] run ${ctx.runId} starting for agent ${agentId}\n`);
  await ctx.onLog("stdout", `[crewdeck] profile: ${profileAdapterType} model: ${model}\n`);

  await ctx.onLog("stdout", "[crewdeck] connecting to crewdeck service...\n");
  const ensureReadyStart = Date.now();
  const status = await ensureReady(agentId, runApiKey, { profileAdapterType, model }, ctx.onLog);

  if (!status.ready) {
    const err = status as EnsureReadyError;
    await ctx.onLog("stderr", `[crewdeck] ensure-ready failed (${err.errorCode}): ${err.error}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: err.error,
      errorCode: err.errorCode,
    };
  }

  const ensureReadySec = ((Date.now() - ensureReadyStart) / 1000).toFixed(1);
  await ctx.onLog(
    "stdout",
    `[crewdeck] sandbox ready in ${ensureReadySec}s (port: ${status.gatewayPort}, created: ${status.sandboxCreated}, restored: ${status.workspaceRestored}, gateway: ${status.gatewayStarted ? "started" : "existed"})\n`,
  );

  const configuredPaperclipApiUrl = asNonEmptyString((ctx.config as Record<string, unknown>).paperclipApiUrl);
  const paperclipApiUrl = configuredPaperclipApiUrl ?? resolveSandboxPaperclipApiUrl();

  const runOnce = async (ready: EnsureReadySuccess): Promise<{
    result: AdapterExecutionResult;
    transient: { matched: boolean; message: string };
    auth: { matched: boolean; message: string };
    approval: { matched: boolean; message: string };
  }> => {
    const existingTemplate = (ctx.config as Record<string, unknown>).payloadTemplate as Record<string, unknown> | undefined;
    const existingMessage = typeof existingTemplate?.message === "string" ? existingTemplate.message : "";
    const completionSignal = [
      "IMPORTANT — Completion signal:",
      "When ALL work is finished (including any sub-agent work), output exactly:",
      "  CREWDECK_RUN_COMPLETE",
      "This MUST be in your final response. Without it, the run is marked incomplete.",
      "If you delegate to sub-agents, wait for them to finish before outputting this signal.",
    ].join("\n");
    const runConfig = {
      ...ctx.config,
      url: `ws://localhost:${ready.gatewayPort}`,
      ...(ready.gatewayToken ? { authToken: ready.gatewayToken } : {}),
      ...(paperclipApiUrl ? { paperclipApiUrl } : {}),
      payloadTemplate: {
        ...(existingTemplate ?? {}),
        message: existingMessage
          ? `${existingMessage}\n\n${completionSignal}`
          : completionSignal,
      },
    };
    let transientFromLogs: string | null = null;
    let authFromLogs: string | null = null;
    let approvalFromLogs: string | null = null;
    const result = await openclawExecute({
      ...ctx,
      onLog: async (stream, chunk) => {
        if (transientFromLogs === null && (stream === "stderr" || stream === "stdout")) {
          transientFromLogs = firstMatchingTransientLine(chunk);
        }
        if (authFromLogs === null && (stream === "stderr" || stream === "stdout")) {
          authFromLogs = firstMatchingAuthLine(chunk);
        }
        if (approvalFromLogs === null && (stream === "stderr" || stream === "stdout")) {
          approvalFromLogs = firstMatchingApprovalLine(chunk);
        }
        await ctx.onLog(stream, chunk);
      },
      config: runConfig,
    });

    const transientFromResult = looksLikeTransientProviderFailure(result);
    if (transientFromResult.matched) {
      return {
        result,
        transient: transientFromResult,
        auth: { matched: false, message: "" },
        approval: { matched: false, message: "" },
      };
    }

    if (transientFromLogs && !hasMeaningfulModelOutput(result)) {
      return {
        result,
        transient: {
          matched: true,
          message: `Upstream model/provider unavailable (${transientFromLogs}).`,
        },
        auth: { matched: false, message: "" },
        approval: { matched: false, message: "" },
      };
    }

    const authFromResult = looksLikeProviderAuthFailure(result);
    if (authFromResult.matched) {
      return {
        result,
        transient: { matched: false, message: "" },
        auth: authFromResult,
        approval: { matched: false, message: "" },
      };
    }

    if (authFromLogs && !hasMeaningfulModelOutput(result)) {
      return {
        result,
        transient: { matched: false, message: "" },
        auth: {
          matched: true,
          message: `Upstream provider auth failed (${authFromLogs}).`,
        },
        approval: { matched: false, message: "" },
      };
    }

    const approvalFromResult = looksLikeApprovalRequired(result);
    if (approvalFromResult.matched) {
      return {
        result,
        transient: { matched: false, message: "" },
        auth: { matched: false, message: "" },
        approval: approvalFromResult,
      };
    }

    if (approvalFromLogs && !hasMeaningfulModelOutput(result)) {
      return {
        result,
        transient: { matched: false, message: "" },
        auth: { matched: false, message: "" },
        approval: {
          matched: true,
          message: `OpenClaw requested interactive approval (${approvalFromLogs}).`,
        },
      };
    }

    return {
      result,
      transient: { matched: false, message: "" },
      auth: { matched: false, message: "" },
      approval: { matched: false, message: "" },
    };
  };

  await ctx.onLog("stdout", `[crewdeck] connecting to gateway ws://localhost:${status.gatewayPort}...\n`);
  const runStart = Date.now();
  const attempt = await runOnce(status);
  const runDurationSec = ((Date.now() - runStart) / 1000).toFixed(1);
  const result = attempt.result;
  const transient = attempt.transient;
  const auth = attempt.auth;
  const approval = attempt.approval;
  await ctx.onLog(
    "stdout",
    `[crewdeck] run completed in ${runDurationSec}s (exitCode: ${result.exitCode ?? "null"}, outputTokens: ${result.usage?.outputTokens ?? 0})\n`,
  );

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

  if (auth.matched) {
    await ctx.onLog(
      "stderr",
      "[crewdeck] provider auth failure detected; re-running ensure-ready and retrying once\n",
    );
    await ctx.onLog("stdout", "[crewdeck] retry: checking connectivity...\n");
    const refreshed = await ensureConnectivity(agentId, runApiKey, ctx.onLog);
    if (!refreshed.ready) {
      const err = refreshed as EnsureReadyError;
      await ctx.onLog("stderr", `[crewdeck] retry: connectivity check failed (${err.errorCode}): ${err.error}\n`);
    }
    if (refreshed.ready) {
      await ctx.onLog("stdout", `[crewdeck] retry: connected (port: ${refreshed.gatewayPort}, gateway: ${refreshed.gatewayStarted ? "restarted" : "ok"}, forward: ${refreshed.forwardStarted ? "restarted" : "ok"})\n`);
      const retry = await runOnce(refreshed);
      await ctx.onLog("stdout", `[crewdeck] retry: run completed (exitCode: ${retry.result.exitCode ?? "null"})\n`);
      if (retry.transient.matched) {
        await ctx.onLog(
          "stderr",
          "[crewdeck] transient provider availability detected after auth refresh; failing run for retry\n",
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
      if (retry.auth.matched) {
        await syncBack(agentId);
        return {
          ...retry.result,
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "crewdeck_provider_auth_failed",
          errorMessage: retry.result.errorMessage ?? retry.auth.message,
        };
      }
      await syncBack(agentId);
      return retry.result;
    }
  }

  if (approval.matched) {
    await syncBack(agentId);
    return {
      ...result,
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "crewdeck_interactive_approval_required",
      errorMessage: result.errorMessage ?? approval.message,
    };
  }

  if (isGatewayConnectivityFailure(result)) {
    await ctx.onLog(
      "stderr",
      "[crewdeck] gateway connectivity failure detected; re-running ensure-ready and retrying once\n",
    );
    await ctx.onLog("stdout", "[crewdeck] retry: checking connectivity...\n");
    const refreshed = await ensureConnectivity(agentId, runApiKey, ctx.onLog);
    if (!refreshed.ready) {
      const err = refreshed as EnsureReadyError;
      await ctx.onLog("stderr", `[crewdeck] retry: connectivity check failed (${err.errorCode}): ${err.error}\n`);
    }
    if (refreshed.ready) {
      await ctx.onLog("stdout", `[crewdeck] retry: connected (port: ${refreshed.gatewayPort}, gateway: ${refreshed.gatewayStarted ? "restarted" : "ok"}, forward: ${refreshed.forwardStarted ? "restarted" : "ok"})\n`);
      const retry = await runOnce(refreshed);
      await ctx.onLog("stdout", `[crewdeck] retry: run completed (exitCode: ${retry.result.exitCode ?? "null"})\n`);
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
      if (retry.auth.matched) {
        await syncBack(agentId);
        return {
          ...retry.result,
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "crewdeck_provider_auth_failed",
          errorMessage: retry.result.errorMessage ?? retry.auth.message,
        };
      }
      if (retry.approval.matched) {
        await syncBack(agentId);
        return {
          ...retry.result,
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "crewdeck_interactive_approval_required",
          errorMessage: retry.result.errorMessage ?? retry.approval.message,
        };
      }
      await syncBack(agentId);
      return retry.result;
    }
  }

  await ctx.onLog("stdout", "[crewdeck] syncing workspace snapshot...\n");
  await syncBack(agentId);
  await ctx.onLog("stdout", "[crewdeck] sync complete\n");

  // Guard: if the adapter returned success but the agent didn't actually complete
  // the workflow (e.g. it spawned sub-agents and the main session exited early),
  // check for the completion signal. If missing, poll the issue status to wait
  // for sub-agents to finish before giving up.
  if (
    (result.exitCode ?? 0) === 0 &&
    !result.errorMessage
  ) {
    const summary = typeof result.summary === "string" ? result.summary : "";
    let hasCompletionSignal = COMPLETION_SIGNAL_RE.test(summary);
    if (!hasCompletionSignal && result.resultJson) {
      hasCompletionSignal = COMPLETION_SIGNAL_RE.test(JSON.stringify(result.resultJson));
    }

    if (!hasCompletionSignal) {
      const issueId = asNonEmptyString(ctx.context.issueId) ?? asNonEmptyString(ctx.context.taskId);
      if (issueId && runApiKey) {
        await ctx.onLog(
          "stdout",
          "[crewdeck] no completion signal — sub-agents may still be working; polling issue status...\n",
        );
        // Poll from the host side (not sandbox), so use the host-reachable Paperclip URL.
        // paperclipApiUrl is sandbox-reachable (k8s DNS) and won't resolve from here.
        const paperclipUrl = asNonEmptyString(process.env.PAPERCLIP_API_URL) ?? "http://localhost:3100";
        const POLL_INTERVAL_MS = 10_000;
        const POLL_TIMEOUT_MS = 5 * 60 * 1000;
        const pollStart = Date.now();
        let issueCompleted = false;

        while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const res = await fetch(`${paperclipUrl}/api/issues/${issueId}`, {
              headers: { authorization: `Bearer ${runApiKey}` },
              signal: AbortSignal.timeout(8_000),
            });
            if (res.ok) {
              const issue = (await res.json()) as Record<string, unknown>;
              const status = typeof issue.status === "string" ? issue.status.toLowerCase() : "";
              await ctx.onLog(
                "stdout",
                `[crewdeck] polling issue ${issueId}: status=${status} (${Math.round((Date.now() - pollStart) / 1000)}s elapsed)\n`,
              );
              if (status === "done" || status === "cancelled") {
                issueCompleted = true;
                break;
              }
            }
          } catch {
            // Polling failure is non-fatal; keep trying
          }
        }

        if (issueCompleted) {
          await ctx.onLog("stdout", "[crewdeck] issue completed by sub-agent; marking run as succeeded\n");
          return result;
        }

        await ctx.onLog(
          "stderr",
          "[crewdeck] issue still open after polling; marking run as incomplete\n",
        );
      }

      return {
        ...result,
        exitCode: 1,
        errorCode: "crewdeck_incomplete_run",
        errorMessage: "Agent session ended without signaling task completion. Work may still be in progress via sub-agents.",
      };
    }
  }

  return result;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return openclawTestEnvironment(ctx);
}
