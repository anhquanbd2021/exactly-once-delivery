import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStaticServer } from '../app/server.ts';

// End-to-end: boot the real server on an ephemeral port and drive it with
// fetch() — same routes, same bytes the browser gets.

async function withServer(fn: (base: string) => Promise<void>) {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('GET / serves the Lab page with nav and the ids app.js drives', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    // Primary nav: Lab / Guide / Source, Lab marked current.
    assert.match(html, /<nav aria-label="Primary">/);
    assert.match(html, /aria-current="page" href="\/"/);
    assert.match(html, /href="\/guide\.html"/);
    assert.match(html, /https:\/\/github\.com\/anhquanbd2021\/exactly-once-delivery/);
    // Every id public/app.js queries must exist in the DOM contract.
    for (const id of [
      'wire', 'btn-at-most-once', 'btn-at-least-once', 'btn-dedupe',
      'modeLabel', 'statSent', 'statArrived', 'statOnce', 'statOnceLabel',
      'statExtra', 'statExtraLabel', 'statCharged', 'verdict',
      'lane', 'ledgerTotal', 'ledgerNote', 'ledgerList', 'trace',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    // Policy toggles carry the data-mode the click handler reads.
    for (const mode of ['at-most-once', 'at-least-once', 'dedupe']) {
      assert.ok(html.includes(`data-mode="${mode}"`), `missing data-mode=${mode}`);
    }
    assert.match(html, /<script type="module" src="\/app\/app\.js">/);
  });
});

test('GET /guide.html serves the Guide page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/guide.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /aria-current="page" href="\/guide\.html"/);
    assert.match(html, /class="guide-section"/);
    assert.match(html, /<dt>Proves<\/dt>/);
    assert.match(html, /<dt>Key detail<\/dt>/);
  });
});

test('/health, /version, and a real API endpoint respond live', async () => {
  await withServer(async (base) => {
    assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
    const version = await (await fetch(`${base}/version`)).json();
    assert.equal(version.name, 'exactly-once-delivery-demo');
    assert.equal(version.version, '1.0.0');
    // One real API endpoint, end to end: dedupe rejects the 2 replays.
    const run = await fetch(`${base}/api/run?mode=dedupe`);
    assert.equal(run.status, 200);
    const report = await run.json();
    assert.equal(report.mode, 'dedupe');
    assert.equal(report.summary.rejected, 2);
    assert.equal(report.summary.chargedCents, 12 * 4900);
  });
});

test('/app/*.js serves type-stripped JS — no TS syntax in the body', async () => {
  await withServer(async (base) => {
    for (const path of ['/app/delivery.js', '/app/app.js']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /javascript/);
      const body = await res.text();
      assert.ok(!body.includes('interface '), `${path} still contains TS syntax`);
    }
  });
});
