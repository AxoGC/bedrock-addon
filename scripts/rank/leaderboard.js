import { world, system } from "@minecraft/server";
import { STATS_KEY_PREFIX } from "../config.js";
import { flushAll } from "../storage/stats.js";
import { AXIS_KEYS, valueForMetric } from "../stats/axes.js";

const MAX_ENTRIES = 200;

// metric -> sorted [{name, score}] (descending). Replaced atomically by
// rebuildLeaderboard so handlers never see a half-built table.
let snapshot = Object.create(null);

export function snapshotSlice(metric, limit) {
  const list = snapshot[metric];
  if (!Array.isArray(list)) return [];
  const n = Math.max(0, Math.min(limit, list.length));
  return list.slice(0, n);
}

function* scanAllStats(into) {
  const ids = world.getDynamicPropertyIds();
  for (const key of ids) {
    if (!key.startsWith(STATS_KEY_PREFIX)) { yield; continue; }
    const raw = world.getDynamicProperty(key);
    if (typeof raw !== "string") { yield; continue; }
    let s = null;
    try { s = JSON.parse(raw); } catch (_) { /* skip */ }
    if (s && typeof s === "object") {
      const name = key.slice(STATS_KEY_PREFIX.length);
      into.push({ name, stats: s });
    }
    yield;
  }
}

function buildEntries(rows, metric) {
  const out = [];
  for (const r of rows) {
    const v = Number(valueForMetric(r.stats, metric));
    if (!isFinite(v) || v <= 0) continue;
    out.push({ name: r.name, score: v });
  }
  out.sort((a, b) => b.score - a.score);
  if (out.length > MAX_ENTRIES) out.length = MAX_ENTRIES;
  return out;
}

/**
 * Periodically rebuild the in-memory snapshot (PLAN §10.6 pull mode). core
 * asks for slices via `leaderboard.fetch`; we never POST. Cooperative
 * generator so a large scan doesn't block the tick.
 */
export function* rebuildLeaderboard() {
  flushAll();
  const rows = [];
  yield* scanAllStats(rows);

  const next = Object.create(null);
  for (const metric of AXIS_KEYS) {
    next[metric] = buildEntries(rows, metric);
    yield;
  }
  snapshot = next;
}

export function startLeaderboardJob(intervalTicks) {
  // First rebuild fires at ~10s so an early `leaderboard.fetch` from core
  // doesn't return empty for the full intervalTicks window.
  system.runTimeout(() => system.runJob(rebuildLeaderboard()), 200);
  system.runInterval(() => system.runJob(rebuildLeaderboard()), intervalTicks);
}
