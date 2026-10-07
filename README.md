# Dedupe Lab — companion demo

Interactive lab for the article on exactly-once delivery. Twelve card
charges go over a lossy link that drops two ACKs. Replay the same wire
under three policies and watch who pays the price: fire-and-forget leaves
two messages unaccounted, retry-until-acked double-charges two cards, and
an idempotency-key dedupe store rejects the replays.

Zero dependencies — Node 24+ only. The domain model (`app/delivery.ts`)
is TypeScript that Node type-strips natively; the server serves it
type-stripped to the browser, so the UI, the API, and the test suite all
run the same module.

Two tabs: **Lab** (`/`) is the interactive replay; **Guide**
(`/guide.html`) explains what each feature proves, how the demo is
built, and where its limits are.

Companion repo: https://github.com/anhquanbd2021/exactly-once-delivery

## What it proves

| Claim | How the lab proves it |
|---|---|
| **The network only offers at-most-once or at-least-once** | All three runs cross the identical lossy link — same packets, same two dropped ACKs. Only the sender/consumer policy changes. |
| **Fire-and-forget fails silently** | Under at-most-once the ledger happens to be right, but the sender can only vouch for 10 of 12 — two messages it can neither confirm nor safely resend. |
| **Retries turn lost ACKs into double charges** | Under at-least-once, 14 arrivals produce 12 unique events and 2 extra card charges — $686 on a $588 order. |
| **Exactly-once is a consumer property** | Same 14 arrivals, but the dedupe store rejects the 2 replays by idempotency key. Ledger: exactly $588. |

## Run it

```text
npm start   # serve the lab on http://localhost:3000 (Lab + Guide tabs)
npm test    # link semantics, all three policies, HTTP + e2e routes
npm run check  # test
```

`GET /api/scenario` returns the wire (12 events + dropped ACKs);
`GET /api/run?mode=at-most-once|at-least-once|dedupe` returns the full
trace, ledger, and summary for a replay.

## Honest limits

This is a **deterministic in-memory model of the delivery problem**, not
a networked system. Packet loss is fixed to two first-attempt ACKs; the
dedupe store is a `Set`, not Redis or Postgres; there is no clock, no
timeout jitter, and no broker. It exists to make the article's claim
legible: exactly-once emerges from consumer bookkeeping, never from the
wire.

This is an educational demo, not production infrastructure.
