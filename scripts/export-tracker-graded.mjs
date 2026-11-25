// Pulls server-side graded tracker rows from the worker's /tracker/graded
// endpoint (a rolling 60-day window for NBA + WNBA) and merges them into
// src/data/trackerGraded.json, deduped by game id (newest grade wins). Run
// daily by .github/workflows/refresh-tracker-graded.yml so the graded record
// lives in the repo instead of only in one browser's localStorage.
//
// Env: WORKER_URL (default prod), TRACKER_EXPORT_TOKEN (must match the
// worker's EXPORT_TOKEN secret). Node 18+ (global fetch).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const WORKER = (process.env.WORKER_URL || 'https://dbp-tracker-worker.jordan-c-stratton.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.TRACKER_EXPORT_TOKEN;
const OUT = new URL('../src/data/trackerGraded.json', import.meta.url);

if (!TOKEN) {
  console.error('TRACKER_EXPORT_TOKEN is not set — cannot call the export endpoint.');
  process.exit(1);
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const today = new Date();
const from = new Date(today);
from.setDate(from.getDate() - 59); // 60-day window = the endpoint's range cap
const fromStr = ymd(from);
const toStr = ymd(today);

async function pull(league) {
  const url = `${WORKER}/tracker/graded?league=${league}&from=${fromStr}&to=${toStr}`;
  const res = await fetch(url, { headers: { 'x-export-token': TOKEN } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${league}: HTTP ${res.status} — ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  if (!body.ok) throw new Error(`${league}: ${body.error || 'worker error'}`);
  return body.rows || [];
}

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const byId = new Map(existing.map((r) => [r.id, r]));
const before = byId.size;

let pulled = 0;
for (const league of ['nba', 'wnba']) {
  const rows = await pull(league);
  pulled += rows.length;
  for (const r of rows) byId.set(r.id, r); // add or refresh
}

const merged = [...byId.values()];
// We only ever add/replace by id, never delete — so the file must not shrink.
if (merged.length < before) {
  console.error(`refusing to write: merged ${merged.length} < existing ${before}`);
  process.exit(1);
}
merged.sort((a, b) => (new Date(a.date) - new Date(b.date)) || String(a.id).localeCompare(String(b.id)));
writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');
console.log(`trackerGraded.json: ${merged.length} rows (+${merged.length - before} new; pulled ${pulled} graded over ${fromStr}–${toStr}).`);
