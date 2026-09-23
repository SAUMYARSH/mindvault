/**
 * Optional tool-level metrics for the MindVault MCP server.
 *
 * Opt-in via the MINDVAULT_METRICS env var. When disabled a no-op recorder is
 * used, so there is no bookkeeping and no output. Metrics only ever contain tool
 * names, counts, and durations — never arguments, wallets, or API keys — so a
 * snapshot is always safe to surface to an agent. This module is pure and
 * side-effect free (no I/O, no globals beyond `performance.now`) for
 * deterministic testing.
 */

/** Per-tool counters. Durations are milliseconds. */
export interface ToolMetric {
  calls: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
  budgetExceeded: number;
}

/**
 * The x402 payment leg of a single paid request: `settled` when the facilitator
 * confirmed the payment, `failed` when a payment was submitted but never
 * confirmed, and `none` when the request finished without paying because no 402
 * challenge was ever answered.
 */
export type PaymentLeg = "settled" | "failed" | "none";

/**
 * Outcome of one request made through a paid fetch. The two legs are
 * independent: `payment` says whether money moved, `ok` whether the request the
 * payment bought returned a usable response. A publish that pays and is then
 * rejected on content grounds is a settled payment and a failed settlement, not
 * a failed payment.
 */
export interface PaidRequestOutcome {
  payment: PaymentLeg;
  ok: boolean;
}

/** Attempt and failure counters for one leg of the paid request flow. */
export interface LegMetric {
  attempts: number;
  failures: number;
}

export interface MetricsSnapshot {
  enabled: boolean;
  /** ISO timestamp of when collection (re)started, or null when disabled. */
  since: string | null;
  toolDurationBudgetMs: number | null;
  totals: { calls: number; errors: number; budgetExceeded: number };
  /** Requests that carried an x402 payment, with the subset that never settled. */
  payments: LegMetric;
  /** Requests made through a paid fetch, with the subset that did not deliver. */
  settlements: LegMetric;
  tools: Record<string, ToolMetric>;
}

export interface MetricsRecorder {
  readonly enabled: boolean;
  readonly toolDurationBudgetMs: number;
  recordToolCall(tool: string, durationMs: number, ok: boolean): void;
  recordPaidRequest(outcome: PaidRequestOutcome): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

/**
 * The part of the x402 client surface needed to observe the payment leg. Kept
 * structural so this module stays free of transport and protocol imports.
 */
export interface PaymentLifecycle {
  onAfterPaymentCreation(hook: (context: unknown) => Promise<void>): unknown;
  onPaymentResponse(
    hook: (context: { settleResponse?: { success: boolean } }) => Promise<void>,
  ): unknown;
}

/**
 * Watch an x402 client and report the payment leg of the requests it makes.
 *
 * The client announces a created payload once it answers a 402 challenge and a
 * settle response once the paid request completes, so a request that never paid
 * stays distinguishable from one that paid and was then rejected downstream.
 * A client is built per paid operation, so the returned reader describes that
 * operation's request.
 */
export function trackPaymentLeg(client: PaymentLifecycle): () => PaymentLeg {
  let submitted = false;
  let settled = false;
  client.onAfterPaymentCreation(async () => {
    submitted = true;
  });
  client.onPaymentResponse(async (context) => {
    submitted = true;
    if (context.settleResponse?.success === true) settled = true;
  });
  return () => {
    if (!submitted) return "none";
    return settled ? "settled" : "failed";
  };
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Metrics are opt-in: enabled only when MINDVAULT_METRICS is a truthy string. */
export function metricsEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MINDVAULT_METRICS;
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

export const TOOL_DURATION_BUDGET_ENV_VAR = "MINDVAULT_TOOL_DURATION_BUDGET_MS";
export const DEFAULT_TOOL_DURATION_BUDGET_MS = 30000;

export function resolveToolDurationBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TOOL_DURATION_BUDGET_ENV_VAR];
  if (!raw || raw.trim() === "") return DEFAULT_TOOL_DURATION_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TOOL_DURATION_BUDGET_MS;
  return Math.floor(parsed);
}

function emptyToolMetric(): ToolMetric {
  return { calls: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0, budgetExceeded: 0 };
}

function emptyLegMetric(): LegMetric {
  return { attempts: 0, failures: 0 };
}

/** Disabled recorder — zero overhead, always reports an empty, disabled snapshot. */
class NoopMetricsRecorder implements MetricsRecorder {
  readonly enabled = false;
  readonly toolDurationBudgetMs = 0;
  recordToolCall(): void {}
  recordPaidRequest(): void {}
  reset(): void {}
  snapshot(): MetricsSnapshot {
    return {
      enabled: false,
      since: null,
      toolDurationBudgetMs: null,
      totals: { calls: 0, errors: 0, budgetExceeded: 0 },
      payments: emptyLegMetric(),
      settlements: emptyLegMetric(),
      tools: {},
    };
  }
}

class ActiveMetricsRecorder implements MetricsRecorder {
  readonly enabled = true;
  readonly toolDurationBudgetMs: number;
  private since = new Date();
  private tools = new Map<string, ToolMetric>();
  private payments = emptyLegMetric();
  private settlements = emptyLegMetric();

  constructor(budgetMs: number) {
    this.toolDurationBudgetMs = budgetMs;
  }

  recordToolCall(tool: string, durationMs: number, ok: boolean): void {
    const metric = this.tools.get(tool) ?? emptyToolMetric();
    metric.calls += 1;
    if (!ok) metric.errors += 1;
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    metric.totalDurationMs += duration;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
    if (duration > this.toolDurationBudgetMs) metric.budgetExceeded += 1;
    this.tools.set(tool, metric);
  }

  recordPaidRequest(outcome: PaidRequestOutcome): void {
    if (outcome.payment !== "none") {
      this.payments.attempts += 1;
      if (outcome.payment === "failed") this.payments.failures += 1;
    }
    this.settlements.attempts += 1;
    if (!outcome.ok) this.settlements.failures += 1;
  }

  reset(): void {
    this.since = new Date();
    this.tools.clear();
    this.payments = emptyLegMetric();
    this.settlements = emptyLegMetric();
  }

  snapshot(): MetricsSnapshot {
    const tools: Record<string, ToolMetric> = {};
    let calls = 0;
    let errors = 0;
    let budgetExceeded = 0;
    for (const [name, metric] of this.tools) {
      tools[name] = { ...metric };
      calls += metric.calls;
      errors += metric.errors;
      budgetExceeded += metric.budgetExceeded;
    }
    return {
      enabled: true,
      since: this.since.toISOString(),
      toolDurationBudgetMs: this.toolDurationBudgetMs,
      totals: { calls, errors, budgetExceeded },
      payments: { ...this.payments },
      settlements: { ...this.settlements },
      tools,
    };
  }
}

export function createMetricsRecorder(enabled: boolean, budgetMs: number): MetricsRecorder {
  return enabled ? new ActiveMetricsRecorder(budgetMs) : new NoopMetricsRecorder();
}

/**
 * Run a tool handler while recording its call count, error count, and duration.
 * Errors are re-thrown unchanged so the caller's existing error handling (and
 * the deterministic `Error: …` response shape) is preserved.
 */
export async function measureTool<T>(
  recorder: MetricsRecorder,
  tool: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recorder.recordToolCall(tool, performance.now() - start, true);
    return result;
  } catch (err) {
    recorder.recordToolCall(tool, performance.now() - start, false);
    throw err;
  }
}
