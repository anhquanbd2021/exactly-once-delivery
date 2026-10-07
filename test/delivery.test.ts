import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  CHARGE_CENTS,
  LOST_ACK_IDS,
  MESSAGE_COUNT,
  buildScenario,
  createDedupeStore,
  runDelivery,
  transmit,
} from '../app/delivery.ts';
import { createStaticServer } from '../app/server.ts';

test('scenario is 12 charge events with stable idempotency keys', () => {
  const msgs = buildScenario();
  assert.equal(msgs.length, MESSAGE_COUNT);
  assert.equal(msgs.length, 12);
  for (const m of msgs) {
    assert.equal(m.amountCents, CHARGE_CENTS);
    assert.match(m.idemKey, /^charge-evt-\d{2}$/);
  }
  assert.equal(new Set(msgs.map(m => m.idemKey)).size, 12, 'keys must be unique');
});

test('the lossy link delivers every packet but drops two first-attempt ACKs', () => {
  const msgs = buildScenario();
  for (const m of msgs) {
    const first = transmit(m, 1);
    assert.equal(first.arrived, true, 'message packets always land');
    assert.equal(first.acked, !LOST_ACK_IDS.includes(m.id));
    // retries always get their ACK — only the first attempt is lossy
    assert.equal(transmit(m, 2).acked, true);
  }
});

test('at-most-once: fire and forget leaves 2 messages unaccounted', () => {
  const r = runDelivery('at-most-once');
  const s = r.summary;
  assert.equal(s.sent, 12, 'one transmission per message, never retried');
  assert.equal(s.arrived, 12, 'all packets still physically arrived');
  assert.equal(s.acked, 10);
  assert.equal(s.unaccounted, 2, 'sender can never confirm or safely resend these');
  assert.equal(s.duplicates, 0);
  // The cruel part: the ledger is correct *by luck* and nobody can prove it.
  assert.equal(s.chargedCents, 12 * CHARGE_CENTS);
});

test('at-least-once: retry duplicates 2 deliveries and double-charges', () => {
  const r = runDelivery('at-least-once');
  const s = r.summary;
  assert.equal(s.sent, 14, '12 sends + 2 retries');
  assert.equal(s.arrived, 14);
  assert.equal(s.uniqueProcessed, 12);
  assert.equal(s.duplicates, 2, 'the failure mode: the same event processed twice');
  assert.equal(s.unaccounted, 0, 'retries got every message confirmed');
  assert.deepEqual(s.doubleCharged.sort(), [...LOST_ACK_IDS].sort());
  assert.equal(s.chargedCents, 14 * CHARGE_CENTS);
  assert.equal(s.overchargedCents, 2 * CHARGE_CENTS, 'the $98 the post warns about');
});

test('dedupe: same wire, same retries — duplicates rejected by key', () => {
  const r = runDelivery('dedupe');
  const s = r.summary;
  assert.equal(s.sent, 14, 'sender still retries — the wire did not change');
  assert.equal(s.arrived, 14);
  assert.equal(s.rejected, 2, 'dedupe store refuses the replays');
  assert.equal(s.processed, 12);
  assert.equal(s.duplicates, 0);
  assert.equal(s.chargedCents, 12 * CHARGE_CENTS, 'exactly-once as a consumer property');
  assert.equal(s.dedupeSize, 12, 'one key stored per unique event');
  assert.deepEqual(
    r.arrivals.filter(a => a.outcome === 'rejected-duplicate').map(a => a.id).sort(),
    [...LOST_ACK_IDS].sort()
  );
});

test('dedupe store admits each key once', () => {
  const store = createDedupeStore();
  assert.equal(store.admit('charge-evt-01'), 'new');
  assert.equal(store.admit('charge-evt-01'), 'duplicate');
  assert.equal(store.admit('charge-evt-02'), 'new');
  assert.equal(store.size, 2);
});

test('the wire is identical across modes — only the policy changes', () => {
  for (const mode of ['at-least-once', 'dedupe'] as const) {
    const r = runDelivery(mode);
    const lostAckTxs = r.transmissions.filter(t => !t.acked).map(t => t.id);
    assert.deepEqual(lostAckTxs.sort(), [...LOST_ACK_IDS].sort(), `${mode} hit the same lost ACKs`);
  }
});

async function listen() {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('/health, /version, /api endpoints, stripped model, and 404', async () => {
  const server = await listen();
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`http://127.0.0.1:${port}/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).name, 'exactly-once-delivery-demo');

    // The browser-facing model is the SAME delivery.ts, type-stripped.
    const model = await fetch(`http://127.0.0.1:${port}/app/delivery.js`);
    assert.equal(model.status, 200);
    const src = await model.text();
    assert.ok(src.includes('runDelivery'));
    assert.ok(!src.includes('interface '), 'types must be stripped for the browser');

    const scenario = await fetch(`http://127.0.0.1:${port}/api/scenario`);
    const sc = await scenario.json();
    assert.equal(sc.messages.length, 12);
    assert.deepEqual(sc.lostAckIds, LOST_ACK_IDS);

    // The real endpoint the UI drives: at-least-once shows the double charge.
    const run = await fetch(`http://127.0.0.1:${port}/api/run?mode=at-least-once`);
    assert.equal(run.status, 200);
    const report = await run.json();
    assert.equal(report.summary.duplicates, 2);
    assert.equal(report.summary.overchargedCents, 2 * CHARGE_CENTS);

    const bad = await fetch(`http://127.0.0.1:${port}/api/run?mode=bogus`);
    assert.equal(bad.status, 400);

    for (const path of ['/', '/tokens.css', '/app/app.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, path);
    }
    for (const path of ['/package.json', '/nope', '/app/delivery.ts']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, path);
    }
  } finally {
    server.close();
  }
});
