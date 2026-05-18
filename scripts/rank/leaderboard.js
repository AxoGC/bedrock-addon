import { world, system } from "@minecraft/server";
import { STATS_KEY_PREFIX } from "../config.js";
import { postSrv } from "../transport/http.js";
import { flushAll } from "../storage/stats.js";
import { AXIS_KEYS, valueForMetric } from "../stats/axes.js";

const MAX_ENTRIES = 100;

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

export function* rebuildLeaderboard() {
  flushAll();
  const rows = [];
  yield* scanAllStats(rows);

  for (const metric of AXIS_KEYS) {
    const entries = buildEntries(rows, metric);
    if (entries.length === 0) { yield; continue; }
    postSrv("leaderboard.update", { metric, entries }).catch(err => {
      console.warn("[leaderboard] post failed", metric, err);
    });
    yield;
  }
}

export function startLeaderboardJob(intervalTicks) {
  system.runInterval(() => system.runJob(rebuildLeaderboard()), intervalTicks);
}
