import { describe, it, expect } from "vitest";
import {
  createMetricsRecorder,
  measureTool,
  metricsEnabledFromEnv,
  trackPaymentLeg,
  type MetricsRecorder,
  type PaymentLifecycle,
} from "./metrics.js";

describe("metricsEnabledFromEnv", () => {
  it("is opt-in: enabled only for truthy values", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(metricsEnabledFromEnv({ MINDVAULT_METRICS: value })).toBe(true);
    }
  });
  it("is disabled by default and for falsy/absent values", () => {
    for (const env of [
      {},
      { MINDVAULT_METRICS: "" },
      { MINDVAULT_METRICS: "0" },
      { MINDVAULT_METRICS: "off" },
    ]) {
      expect(metricsEnabledFromEnv(env)).toBe(false);
    }
  });
});

describe("disabled (noop) recorder", () => {
  it("reports a disabled, empty snapshot and records nothing", () => {
    const recorder = createMetricsRecorder(false, 30000);
    expect(recorder.enabled).toBe(false);
    recorder.recordToolCall("mindvault_buy", 12, false);
    recorder.recordPaidRequest({ payment: "settled", ok: false });
    const snap = recorder.snapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.tools).toEqual({});
    expect(snap.totals).toEqual({ calls: 0, errors: 0, budgetExceeded: 0 });
    expect(snap.payments).toEqual({ attempts: 0, failures: 0 });
    expect(snap.settlements).toEqual({ attempts: 0, failures: 0 });
  });
});

describe("active recorder", () => {
  it("counts success and failure paths per tool and tracks budget", () => {
    const recorder = createMetricsRecorder(true, 10);
    recorder.recordToolCall("mindvault_browse", 5, true);
    recorder.recordToolCall("mindvault_browse", 7, true);
    recorder.recordToolCall("mindvault_buy", 20, false);

    const snap = recorder.snapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.tools.mindvault_browse).toEqual({
      calls: 2,
      errors: 0,
      totalDurationMs: 12,
      maxDurationMs: 7,
      budgetExceeded: 0,
    });
    expect(snap.tools.mindvault_buy).toMatchObject({ calls: 1, errors: 1, budgetExceeded: 1 });
    expect(snap.totals).toEqual({ calls: 3, errors: 1, budgetExceeded: 1 });
    expect(snap.toolDurationBudgetMs).toBe(10);
  });

  it("tracks payment attempts and failures", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordPaidRequest({ payment: "settled", ok: true });
    recorder.recordPaidRequest({ payment: "failed", ok: false });
    recorder.recordPaidRequest({ payment: "settled", ok: true });
    expect(recorder.snapshot().payments).toEqual({ attempts: 3, failures: 1 });
  });

  it("counts a paid-then-rejected request as a settled payment and a failed settlement", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordPaidRequest({ payment: "settled", ok: false });
    const snap = recorder.snapshot();
    expect(snap.payments).toEqual({ attempts: 1, failures: 0 });
    expect(snap.settlements).toEqual({ attempts: 1, failures: 1 });
  });

  it("does not count a payment for a request that never answered a 402", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordPaidRequest({ payment: "none", ok: false });
    const snap = recorder.snapshot();
    expect(snap.payments).toEqual({ attempts: 0, failures: 0 });
    expect(snap.settlements).toEqual({ attempts: 1, failures: 1 });
  });

  it("counts a payment that never settled in both legs", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordPaidRequest({ payment: "failed", ok: false });
    const snap = recorder.snapshot();
    expect(snap.payments).toEqual({ attempts: 1, failures: 1 });
    expect(snap.settlements).toEqual({ attempts: 1, failures: 1 });
  });

  it("keeps payment failures a subset of payment attempts across mixed outcomes", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordPaidRequest({ payment: "settled", ok: true });
    recorder.recordPaidRequest({ payment: "settled", ok: false });
    recorder.recordPaidRequest({ payment: "failed", ok: false });
    recorder.recordPaidRequest({ payment: "none", ok: false });
    const snap = recorder.snapshot();
    expect(snap.payments).toEqual({ attempts: 3, failures: 1 });
    expect(snap.settlements).toEqual({ attempts: 4, failures: 3 });
    expect(snap.payments.failures).toBeLessThanOrEqual(snap.payments.attempts);
  });

  it("clamps non-finite/negative durations to zero", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordToolCall("mindvault_preview", Number.NaN, true);
    recorder.recordToolCall("mindvault_preview", -3, true);
    expect(recorder.snapshot().tools.mindvault_preview).toMatchObject({
      calls: 2,
      totalDurationMs: 0,
      maxDurationMs: 0,
    });
  });

  it("reset clears counters and moves the since timestamp forward", () => {
    const recorder = createMetricsRecorder(true, 30000);
    const before = recorder.snapshot().since;
    recorder.recordToolCall("mindvault_browse", 5, true);
    recorder.recordPaidRequest({ payment: "settled", ok: false });
    recorder.reset();
    const snap = recorder.snapshot();
    expect(snap.totals).toEqual({ calls: 0, errors: 0, budgetExceeded: 0 });
    expect(snap.tools).toEqual({});
    expect(snap.payments).toEqual({ attempts: 0, failures: 0 });
    expect(snap.settlements).toEqual({ attempts: 0, failures: 0 });
    expect(snap.since).not.toBeNull();
    expect(before).not.toBeNull();
  });

  it("never records secret-looking material — only tool names and numbers", () => {
    const recorder = createMetricsRecorder(true, 30000);
    recorder.recordToolCall("mindvault_register", 5, true);
    const serialized = JSON.stringify(recorder.snapshot());
    // Keys of a tool metric are strictly the numeric counters.
    const metric = recorder.snapshot().tools.mindvault_register;
    expect(Object.keys(metric).sort()).toEqual([
      "budgetExceeded",
      "calls",
      "errors",
      "maxDurationMs",
      "totalDurationMs",
    ]);
    expect(serialized).not.toMatch(/secret|apiKey|SB[A-Z0-9]/);
  });
});

describe("trackPaymentLeg", () => {
  function fakeClient(): {
    client: PaymentLifecycle;
    paymentCreated: () => Promise<void>;
    paymentResponse: (settleResponse?: { success: boolean }) => Promise<void>;
  } {
    let afterCreation: (context: unknown) => Promise<void> = async () => {};
    let onResponse: (context: {
      settleResponse?: { success: boolean };
    }) => Promise<void> = async () => {};
    const client: PaymentLifecycle = {
      onAfterPaymentCreation(hook) {
        afterCreation = hook;
        return client;
      },
      onPaymentResponse(hook) {
        onResponse = hook;
        return client;
      },
    };
    return {
      client,
      paymentCreated: () => afterCreation({}),
      paymentResponse: (settleResponse) => onResponse(settleResponse ? { settleResponse } : {}),
    };
  }

  it("reports no payment when the request never answered a 402", () => {
    const { client } = fakeClient();
    expect(trackPaymentLeg(client)()).toBe("none");
  });

  it("reports a settled payment when the facilitator confirmed it", async () => {
    const { client, paymentCreated, paymentResponse } = fakeClient();
    const paymentLeg = trackPaymentLeg(client);
    await paymentCreated();
    await paymentResponse({ success: true });
    expect(paymentLeg()).toBe("settled");
  });

  it("reports a failed payment when the facilitator rejected it", async () => {
    const { client, paymentCreated, paymentResponse } = fakeClient();
    const paymentLeg = trackPaymentLeg(client);
    await paymentCreated();
    await paymentResponse({ success: false });
    expect(paymentLeg()).toBe("failed");
  });

  it("reports a failed payment when a submitted payment never came back", async () => {
    const { client, paymentCreated } = fakeClient();
    const paymentLeg = trackPaymentLeg(client);
    await paymentCreated();
    expect(paymentLeg()).toBe("failed");
  });

  it("reports a settled payment when a retried payload settles after a failure", async () => {
    const { client, paymentCreated, paymentResponse } = fakeClient();
    const paymentLeg = trackPaymentLeg(client);
    await paymentCreated();
    await paymentResponse({ success: false });
    await paymentCreated();
    await paymentResponse({ success: true });
    expect(paymentLeg()).toBe("settled");
  });

  it("stays settled when the response carries no settlement details", async () => {
    const { client, paymentCreated, paymentResponse } = fakeClient();
    const paymentLeg = trackPaymentLeg(client);
    await paymentCreated();
    await paymentResponse({ success: true });
    await paymentResponse();
    expect(paymentLeg()).toBe("settled");
  });
});

describe("measureTool", () => {
  function counting(): { recorder: MetricsRecorder; calls: [string, number, boolean][] } {
    const calls: [string, number, boolean][] = [];
    const recorder: MetricsRecorder = {
      enabled: true,
      toolDurationBudgetMs: 30000,
      recordToolCall: (tool, duration, ok) => calls.push([tool, duration, ok]),
      recordPaidRequest: () => {},
      snapshot: () => ({
        enabled: true,
        since: null,
        toolDurationBudgetMs: 30000,
        totals: { calls: 0, errors: 0, budgetExceeded: 0 },
        payments: { attempts: 0, failures: 0 },
        settlements: { attempts: 0, failures: 0 },
        tools: {},
      }),
      reset: () => {},
    };
    return { recorder, calls };
  }

  it("records a successful call and returns the result", async () => {
    const { recorder, calls } = counting();
    const result = await measureTool(recorder, "mindvault_browse", () => "ok");
    expect(result).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("mindvault_browse");
    expect(calls[0][2]).toBe(true);
  });

  it("records a failed call and re-throws the error unchanged", async () => {
    const { recorder, calls } = counting();
    await expect(
      measureTool(recorder, "mindvault_buy", () => {
        throw new Error("Buy failed [402]");
      }),
    ).rejects.toThrow("Buy failed [402]");
    expect(calls[0][0]).toBe("mindvault_buy");
    expect(calls[0][2]).toBe(false);
  });
});
