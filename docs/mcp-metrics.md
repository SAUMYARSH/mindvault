# MCP Tool Metrics

The MindVault MCP server can collect **optional, opt-in metrics** about tool
usage: how often each tool is called, how many calls fail, how long they take,
and how x402 payments and the requests they buy fare. This is useful for
operators who want lightweight visibility into an agent's activity without
wiring up a full observability stack.

Metrics are **off by default** and add zero bookkeeping unless enabled.

## Enabling

Set the `MINDVAULT_METRICS` environment variable to a truthy value
(`1`, `true`, `yes`, or `on`) before starting the server:

```bash
MINDVAULT_METRICS=1 node /path/to/mindvault/mcp/dist/index.js
```

When disabled, the `mindvault_metrics` tool returns a short note explaining how
to turn it on rather than any counters.

## Reading metrics

Call the `mindvault_metrics` tool. Pass `reset: true` to clear the counters
after reading (useful for periodic sampling).

Example output when enabled:

```json
{
  "enabled": true,
  "since": "2026-07-23T18:00:00.000Z",
  "totals": { "calls": 7, "errors": 1 },
  "payments": { "attempts": 2, "failures": 0 },
  "settlements": { "attempts": 3, "failures": 1 },
  "tools": {
    "mindvault_browse": { "calls": 3, "errors": 0, "totalDurationMs": 41, "maxDurationMs": 18 },
    "mindvault_buy": { "calls": 2, "errors": 1, "totalDurationMs": 220, "maxDurationMs": 140 }
  }
}
```

- `totals` — aggregate call and error counts across all tools.
- `payments` — requests on `mindvault_publish` (content verification) and
  `mindvault_buy` that actually carried an x402 payment, with the subset the
  facilitator never confirmed as settled. A request that finishes without
  answering a 402 challenge is not a payment attempt and is not counted here.
- `settlements` — every request made through a paid fetch, with the subset that
  did not return a usable response.
- `tools` — per-tool call/error counts and durations in milliseconds
  (`totalDurationMs` is the sum, `maxDurationMs` the slowest single call).

## Payments versus settlements

The two payment counters answer different questions, and neither is derivable
from the other:

- `payments` measures the money leg. It is driven by what the x402 client
  reports — whether it created and submitted a payment payload, and whether the
  facilitator confirmed settlement — not by the status code of the response.
- `settlements` measures the delivery leg: whether the request the payment
  bought came back with a usable response.

A publish that pays and is then rejected on content grounds therefore shows as
one settled payment and one failed settlement. The money moved, so counting it
as a payment failure would misreport spend. In the other direction, a request
that fails before any 402 challenge — a 404, or a timeout on the first leg —
never paid anything, so it adds a failed settlement and no payment attempt.

`failures` remains a subset of `attempts` within each group. If a paid request
throws after the payment was submitted, the payment is recorded as a failure:
the client has no settlement confirmation to go on, so the counter reports the
uncertainty rather than assuming the payment landed.

## Safety

Metrics contain **only tool names, counts, and durations** — never tool
arguments, wallet keys, or API keys. Snapshots are safe to surface to an agent.
When metrics are disabled, no data is collected at all. Failures are still
reported through each tool's normal deterministic `Error: …` response; the
metrics layer only counts them and never alters the message.

The behavior is covered by unit tests in
[`mcp/src/metrics.test.ts`](../mcp/src/metrics.test.ts), including the success
and failure counter paths, the paid-then-rejected split, and the no-secret-leak
guarantee.
