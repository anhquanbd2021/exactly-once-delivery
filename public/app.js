// app.js — plain-JavaScript DOM wiring for Dedupe Lab.
// Browsers cannot strip TypeScript types and this project allows no build
// step, so this file is the documented .js exception: it wires DOM events
// and renders results. All domain logic lives in /app/delivery.js — the
// same delivery.ts the server type-strips and the tests exercise.

import {
  LOST_ACK_IDS,
  MODE_LABELS,
  MODE_VERDICTS,
  buildScenario,
  formatCents,
} from '/app/delivery.js';

const state = { mode: 'dedupe', report: null };
const scenario = buildScenario();

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderWire() {
  $('wire').innerHTML = scenario
    .map(m => `<span class="${LOST_ACK_IDS.includes(m.id) ? 'drop' : 'ok'}">${esc(m.id)}${LOST_ACK_IDS.includes(m.id) ? ' — ack dropped' : ''}</span>`)
    .join('');
}

function renderStats() {
  const s = state.report.summary;
  $('statSent').textContent = s.sent;
  $('statArrived').textContent = s.arrived;
  $('statCharged').textContent = formatCents(s.chargedCents);
  $('statCharged').classList.toggle('bad', s.overchargedCents > 0);

  if (state.mode === 'at-most-once') {
    $('statOnce').textContent = s.acked;
    $('statOnceLabel').textContent = 'confirmed by sender';
    $('statExtra').textContent = s.unaccounted;
    $('statExtraLabel').textContent = 'unaccounted (silent)';
    $('statExtra').classList.toggle('bad', s.unaccounted > 0);
    $('statOnce').classList.remove('bad');
  } else if (state.mode === 'at-least-once') {
    $('statOnce').textContent = s.uniqueProcessed;
    $('statOnceLabel').textContent = 'unique processed';
    $('statExtra').textContent = s.duplicates;
    $('statExtraLabel').textContent = 'duplicate charges';
    $('statExtra').classList.toggle('bad', s.duplicates > 0);
    $('statOnce').classList.remove('bad');
  } else {
    $('statOnce').textContent = s.uniqueProcessed;
    $('statOnceLabel').textContent = 'charged exactly once';
    $('statExtra').textContent = s.rejected;
    $('statExtraLabel').textContent = 'duplicates rejected';
    $('statExtra').classList.remove('bad');
    $('statOnce').classList.remove('bad');
  }
}

function renderLane() {
  const { arrivals, transmissions } = state.report;
  $('lane').innerHTML = scenario
    .map(m => {
      const txs = transmissions.filter(t => t.id === m.id);
      const arr = arrivals.filter(a => a.id === m.id);
      const dupCharged = arr.filter(a => a.outcome === 'processed').length > 1;
      const neverAcked = !txs.some(t => t.acked);
      const cls = dupCharged ? 'msg dup' : neverAcked ? 'msg lost' : 'msg';
      const evts = txs.map(t => {
        const marks = [`tx${t.attempt}`];
        marks.push(t.acked ? 'ack ok' : 'ack lost');
        return `<span class="evt ${t.acked ? (t.attempt > 1 ? 'retry' : '') : 'acklost'}">${esc(marks.join(' · '))}</span>`;
      });
      const outs = arr.map(a =>
        a.outcome === 'rejected-duplicate'
          ? `<span class="evt rej">duplicate — rejected by key</span>`
          : `<span class="evt ${a.attempt > 1 ? 'charge2' : 'charge'}">charged ${esc(formatCents(a.chargedCents))}${a.attempt > 1 ? ' AGAIN' : ''}</span>`
      );
      const unacc = neverAcked ? '<span class="evt acklost">sender: unaccounted</span>' : '';
      return `<div class="${cls}"><div class="mid">${esc(m.id)}</div><div class="key">${esc(m.idemKey)} · ${esc(m.label)}</div>${evts.join('')}${outs.join('')}${unacc}</div>`;
    })
    .join('');
}

function renderLedger() {
  const s = state.report.summary;
  $('ledgerTotal').textContent = formatCents(s.chargedCents);
  const note = $('ledgerNote');
  note.className = s.overchargedCents > 0 ? 'over' : 'fine';
  note.textContent =
    s.overchargedCents > 0
      ? `Expected ${formatCents(s.expectedCents)} — ${formatCents(s.overchargedCents)} over. Double-charged: ${s.doubleCharged.join(', ')}.`
      : `Matches the expected ${formatCents(s.expectedCents)}.` +
        (s.unaccounted > 0 ? ` But the sender can only vouch for ${s.acked} — ${s.unaccounted} charge(s) it can never confirm or safely resend.` : '');
  const byId = {};
  for (const c of state.report.ledger) {
    (byId[c.id] = byId[c.id] || []).push(c);
  }
  $('ledgerList').innerHTML = scenario
    .map(m => {
      const hits = byId[m.id] || [];
      return `<div class="evt ${hits.length > 1 ? 'charge2' : 'charge'}">${esc(m.idemKey)} — ${hits.length} charge(s): ${hits.map(c => esc(formatCents(c.cents))).join(' + ') || 'none'}</div>`;
    })
    .join('');
}

function renderAll() {
  $('modeLabel').textContent = MODE_LABELS[state.mode];
  $('verdict').textContent = MODE_VERDICTS[state.mode];
  $('trace').textContent = state.report.trace.join('\n');
  renderStats();
  renderLane();
  renderLedger();
  for (const btn of document.querySelectorAll('button.toggle')) {
    const on = btn.dataset.mode === state.mode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

async function run(mode) {
  state.mode = mode;
  const res = await fetch(`/api/run?mode=${mode}`);
  state.report = await res.json();
  renderAll();
}

for (const btn of document.querySelectorAll('button.toggle')) {
  btn.addEventListener('click', () => run(btn.dataset.mode));
}

renderWire();
run(state.mode);
