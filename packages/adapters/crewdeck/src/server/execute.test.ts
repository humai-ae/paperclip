import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  looksLikeTransientProviderFailure,
  looksLikeProviderAuthFailure,
  looksLikeApprovalRequired,
  isGatewayConnectivityFailure,
  COMPLETION_SIGNAL_RE,
} from "./execute.js";

function makeResult(overrides: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transient provider failure detection
// ---------------------------------------------------------------------------

describe("looksLikeTransientProviderFailure", () => {
  it.each([
    "service unavailable",
    "model unavailable",
    "provider unavailable",
    "temporarily unavailable",
    "The model is overloaded right now",
    "rate limited",
    "rate limit exceeded",
    "too many requests",
    "HTTP 429",
    "try again later",
    "try again soon",
  ])("matches: %s", (text) => {
    expect(looksLikeTransientProviderFailure(makeResult({ errorMessage: text })).matched).toBe(true);
  });

  it("does not match normal output", () => {
    expect(looksLikeTransientProviderFailure(makeResult({ summary: "Task completed successfully" })).matched).toBe(false);
  });

  it("checks summary field", () => {
    expect(looksLikeTransientProviderFailure(makeResult({ summary: "Error: model unavailable" })).matched).toBe(true);
  });

  it("checks resultJson", () => {
    expect(looksLikeTransientProviderFailure(makeResult({ resultJson: { error: "rate limited" } })).matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider auth failure detection
// ---------------------------------------------------------------------------

describe("looksLikeProviderAuthFailure", () => {
  it.each([
    "HTTP 401",
    "authentication_error",
    "invalid bearer token",
    "unauthorized",
    "invalid api key",
    'failoverReason: "auth"',
    "failoverReason:'auth'",
  ])("matches: %s", (text) => {
    expect(looksLikeProviderAuthFailure(makeResult({ errorMessage: text })).matched).toBe(true);
  });

  it("does not match normal output", () => {
    expect(looksLikeProviderAuthFailure(makeResult({ summary: "authenticated successfully" })).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approval required detection
// ---------------------------------------------------------------------------

describe("looksLikeApprovalRequired", () => {
  it.each([
    "/approve abc123 allow-always",
    "/approve e7dc3cd6 allow-always",
    "I need approval to proceed",
    "please run: /approve",
    "please run: `/approve abc`",
    "approval required",
  ])("matches: %s", (text) => {
    expect(looksLikeApprovalRequired(makeResult({ errorMessage: text })).matched).toBe(true);
  });

  it("does not match normal text", () => {
    expect(looksLikeApprovalRequired(makeResult({ summary: "The PR has been approved" })).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gateway connectivity failure detection
// ---------------------------------------------------------------------------

describe("isGatewayConnectivityFailure", () => {
  it("detects gateway request failure", () => {
    expect(isGatewayConnectivityFailure(makeResult({
      exitCode: 1,
      errorCode: "openclaw_gateway_request_failed",
      errorMessage: "websocket connection refused",
    }))).toBe(true);
  });

  it("detects gateway timeout", () => {
    expect(isGatewayConnectivityFailure(makeResult({
      exitCode: 1,
      errorCode: "openclaw_gateway_timeout",
      errorMessage: "gateway connect timeout",
    }))).toBe(true);
  });

  it("ignores if there is meaningful output", () => {
    expect(isGatewayConnectivityFailure(makeResult({
      exitCode: 1,
      errorCode: "openclaw_gateway_request_failed",
      errorMessage: "connection refused",
      summary: "The agent produced meaningful output before failing",
    }))).toBe(false);
  });

  it("ignores unrelated error codes", () => {
    expect(isGatewayConnectivityFailure(makeResult({
      exitCode: 1,
      errorCode: "crewdeck_missing_run_api_key",
      errorMessage: "connection refused",
    }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Completion signal
// ---------------------------------------------------------------------------

describe("COMPLETION_SIGNAL_RE", () => {
  it("matches standalone line", () => {
    expect(COMPLETION_SIGNAL_RE.test("CREWDECK_RUN_COMPLETE")).toBe(true);
  });

  it("matches with trailing whitespace", () => {
    expect(COMPLETION_SIGNAL_RE.test("CREWDECK_RUN_COMPLETE  ")).toBe(true);
  });

  it("matches in multiline output", () => {
    const text = "Some work done.\nCREWDECK_RUN_COMPLETE\n";
    expect(COMPLETION_SIGNAL_RE.test(text)).toBe(true);
  });

  it("matches as last line without trailing newline", () => {
    const text = "Task finished.\nCREWDECK_RUN_COMPLETE";
    expect(COMPLETION_SIGNAL_RE.test(text)).toBe(true);
  });

  it("does not match as substring in prose", () => {
    expect(COMPLETION_SIGNAL_RE.test("The CREWDECK_RUN_COMPLETE signal was sent")).toBe(false);
  });

  it("does not match partial token", () => {
    expect(COMPLETION_SIGNAL_RE.test("CREWDECK_RUN_COMPLET")).toBe(false);
  });

  it("does not match when prefixed with text on same line", () => {
    expect(COMPLETION_SIGNAL_RE.test("output: CREWDECK_RUN_COMPLETE")).toBe(false);
  });
});
