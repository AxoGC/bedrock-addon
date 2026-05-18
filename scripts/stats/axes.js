// Six unified radar axes shared by the player-detail page on all games.
// Order here = wire order = radar display order.
//
// Raw counters live in dynamic property storage (see storage/stats.js +
// observation/events.js). This module derives the final values + percent
// against fixed scale baselines, so core/web stay metric-agnostic — they
// just plot what we ship.
//
// Tune scales here when balance shifts. The protocol carries percent so
// no platform-side change is required for a tune.

export const AXIS_KEYS = [
  "walk_total_m",
  "play_time",
  "survival_index",
  "blocks_placed",
  "blocks_broken",
  "kills_total",
];

const UNITS = {
  walk_total_m: "m",
  play_time: "s",
  survival_index: "",
  blocks_placed: "",
  blocks_broken: "",
  kills_total: "",
};

const SCALES = {
  walk_total_m: 50000,    // 50 km
  play_time: 360000,      // 100 h
  survival_index: 8000,
  blocks_placed: 80000,
  blocks_broken: 80000,
  kills_total: 5000,
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function roundWire(v) {
  if (!Number.isFinite(v)) return 0;
  if (v >= 0 && v % 1 === 0) return v;
  return round2(v);
}

// Derive the six axis values from the raw dynamic-property record.
// Accepts a possibly-empty / partial object; missing fields become 0.
export function deriveValues(stats) {
  const s = stats || {};
  const playTime = num(s.play_time);
  const deaths = num(s.deaths);
  return {
    walk_total_m: num(s.walk_distance_m),
    play_time: playTime,
    survival_index: playTime / (deaths + 30),
    blocks_placed: num(s.blocks_placed_total),
    blocks_broken: num(s.blocks_broken_total),
    kills_total: num(s.mob_kills_total) + num(s.pvp_kills),
  };
}

// Wire-format array suitable for `stats.update` entries and `stats.fetch` reply.
export function buildAxesArray(stats) {
  const v = deriveValues(stats);
  return AXIS_KEYS.map(key => {
    const raw = v[key];
    const scale = SCALES[key];
    return {
      key,
      unit: UNITS[key],
      value: roundWire(raw),
      percent: scale > 0 ? round2(raw / scale * 100) : 0,
    };
  });
}

// Single axis value (used by leaderboard scan).
export function valueForMetric(stats, metricKey) {
  return deriveValues(stats)[metricKey] ?? 0;
}
