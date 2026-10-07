// Dedupe Lab — the delivery model.
// One lossy link, three delivery policies. Shared by the server API, the
// browser UI, and the test suite: the browser imports this exact file
// (type-stripped at serve time), so what you see is what is tested.

// --- The scenario ------------------------------------------------------

export interface Message {
  id: string;          // transport id — also stamped on the wire
  seq: number;         // 1..12, send order
  idemKey: string;     // idempotency key the consumer stores per event
  amountCents: number; // every event is a card charge
  label: string;
}

export const MESSAGE_COUNT = 12;
export const CHARGE_CENTS = 4900; // $49.00 per charge event
export const MAX_ATTEMPTS = 3;    // retry budget per message

// The lossy link: every message packet arrives at the consumer, but the
// ACK packet for these ids is dropped on the FIRST attempt only. The
// link never changes between modes — only the policies around it do.
export const LOST_ACK_IDS: readonly string[] = ['msg-03', 'msg-07'];

export function buildScenario(): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= MESSAGE_COUNT; i++) {
    const n = String(i).padStart(2, '0');
    out.push({
      id: `msg-${n}`,
      seq: i,
      idemKey: `charge-evt-${n}`,
      amountCents: CHARGE_CENTS,
      label: `charge card ${formatCents(CHARGE_CENTS)}`,
    });
  }
  return out;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// --- The link ----------------------------------------------------------

export interface TransmitResult {
  id: string;
  attempt: number;
  arrived: true;    // message packets always land in this lab
  acked: boolean;   // the ACK is what dies on the wire
}

export function transmit(msg: Message, attempt: number): TransmitResult {
  const ackLost = attempt === 1 && LOST_ACK_IDS.includes(msg.id);
  return { id: msg.id, attempt, arrived: true, acked: !ackLost };
}

// --- Delivery policies -------------------------------------------------

export const MODES = ['at-most-once', 'at-least-once', 'dedupe'] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  'at-most-once': 'At most once — fire and forget',
  'at-least-once': 'At least once — retry until acked',
  'dedupe': 'Exactly-once — retry + dedupe store',
};

export const MODE_VERDICTS: Record<Mode, string> = {
  'at-most-once':
    'Fire and forget: 2 ACKs never came back and nobody retried. The sender\'s books show 2 messages it can neither confirm lost nor safely resend — resending might double-charge, not resending might lose the order.',
  'at-least-once':
    'Retry until acked: nothing was lost on the wire — but 2 messages arrived twice, and a naive consumer charged the card twice. The ledger is $98 over.',
  'dedupe':
    'Same wire, same retries — but the consumer stores each idempotency key and refuses the replay: 2 duplicates rejected, every card charged exactly once.',
};

// --- The consumer's dedupe store ---------------------------------------

// A store of idempotency keys already processed. Real systems back this
// with Redis (`SET key 1 NX EX ttl`) or a unique constraint in Postgres;
// here it is a Set so the mechanism stays visible.
export function createDedupeStore() {
  const seen = new Set<string>();
  return {
    admit(key: string): 'new' | 'duplicate' {
      if (seen.has(key)) return 'duplicate';
      seen.add(key);
      return 'new';
    },
    get size(): number {
      return seen.size;
    },
    keys(): string[] {
      return [...seen];
    },
  };
}
export type DedupeStore = ReturnType<typeof createDedupeStore>;

// --- Run report ---------------------------------------------------------

export interface Arrival {
  id: string;
  attempt: number;
  outcome: 'processed' | 'rejected-duplicate';
  chargedCents: number; // what THIS arrival added to the ledger
}

export interface Charge {
  id: string;      // which message caused it
  attempt: number; // which transmission caused it
  cents: number;
}

export interface RunSummary {
  sent: number;            // transmissions on the wire
  arrived: number;         // packets that reached the consumer
  acked: number;           // ACKs the sender actually received
  unaccounted: number;     // sent, never ACKed, never retried
  retried: number;         // retransmissions issued
  processed: number;       // arrivals that ran the business logic
  rejected: number;        // arrivals refused by the dedupe store
  uniqueProcessed: number; // distinct message ids charged once or more
  duplicates: number;      // extra processed arrivals (double charges)
  chargedCents: number;    // ledger total
  expectedCents: number;   // messages.length * CHARGE_CENTS
  overchargedCents: number;
  doubleCharged: string[]; // ids charged more than once
  dedupeSize: number;      // keys stored (0 unless dedupe mode)
}

export interface RunReport {
  mode: Mode;
  transmissions: TransmitResult[];
  arrivals: Arrival[];
  ledger: Charge[];
  trace: string[];
  summary: RunSummary;
}

// runDelivery replays the 12-message scenario over the lossy link under
// one policy. The sender differs (retry or not); the consumer differs
// (naive or idempotent). The link is identical in every run.
export function runDelivery(mode: Mode, messages: Message[] = buildScenario()): RunReport {
  const transmissions: TransmitResult[] = [];
  const arrivals: Arrival[] = [];
  const ledger: Charge[] = [];
  const trace: string[] = [];
  const store = mode === 'dedupe' ? createDedupeStore() : null;
  const chargeCount = new Map<string, number>();
  const retry = mode !== 'at-most-once';

  for (const msg of messages) {
    let attempt = 0;
    let acked = false;
    do {
      attempt++;
      const tx = transmit(msg, attempt);
      transmissions.push(tx);
      trace.push(
        tx.acked
          ? `wire  ${msg.id} attempt ${attempt}: arrived, ack ok`
          : `wire  ${msg.id} attempt ${attempt}: arrived, ACK LOST`
      );

      const verdict = store ? store.admit(msg.idemKey) : 'new';
      if (verdict === 'duplicate') {
        arrivals.push({ id: msg.id, attempt, outcome: 'rejected-duplicate', chargedCents: 0 });
        trace.push(`  consumer ${msg.idemKey}: key already in dedupe store — rejected`);
      } else {
        arrivals.push({ id: msg.id, attempt, outcome: 'processed', chargedCents: msg.amountCents });
        ledger.push({ id: msg.id, attempt, cents: msg.amountCents });
        chargeCount.set(msg.id, (chargeCount.get(msg.id) ?? 0) + 1);
        trace.push(`  consumer ${msg.idemKey}: processed — charged ${formatCents(msg.amountCents)}`);
      }

      acked = tx.acked;
      if (!acked && !retry) {
        trace.push(`  sender  ${msg.id}: no ack, fire-and-forget — moving on`);
      } else if (!acked) {
        trace.push(`  sender  ${msg.id}: no ack — RETRYING`);
      }
    } while (!acked && retry && attempt < MAX_ATTEMPTS);
  }

  const processed = arrivals.filter(a => a.outcome === 'processed').length;
  const chargedCents = ledger.reduce((s, c) => s + c.cents, 0);
  const expectedCents = messages.length * CHARGE_CENTS;
  const doubleCharged = [...chargeCount.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);

  return {
    mode,
    transmissions,
    arrivals,
    ledger,
    trace,
    summary: {
      sent: transmissions.length,
      arrived: arrivals.length,
      acked: transmissions.filter(t => t.acked).length,
      unaccounted: messages.filter(
        m => !transmissions.some(t => t.id === m.id && t.acked)
      ).length,
      retried: transmissions.length - messages.length,
      processed,
      rejected: arrivals.filter(a => a.outcome === 'rejected-duplicate').length,
      uniqueProcessed: chargeCount.size,
      duplicates: processed - chargeCount.size,
      chargedCents,
      expectedCents,
      overchargedCents: Math.max(0, chargedCents - expectedCents),
      doubleCharged,
      dedupeSize: store ? store.size : 0,
    },
  };
}
