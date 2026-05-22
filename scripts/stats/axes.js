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

// Plugin-owned axis metadata (PLAN §10.6). Shipped verbatim to core via the
// `metrics.list` reply so core/web stay metric-agnostic: a future axis tweak
// is a plugin-only change. Order here = wire order = radar display order.
export const METRICS = [
  { key: "walk_total_m",   unit: "m", label_zh: "移动距离", label_en: "Distance",       scale: 50000,  order: 1, champion: true },
  { key: "play_time",      unit: "s", label_zh: "在线时长", label_en: "Play Time",      scale: 360000, order: 2, champion: true },
  { key: "survival_index", unit: "",  label_zh: "存活指数", label_en: "Survival Index", scale: 8000,   order: 3, champion: true },
  { key: "blocks_placed",  unit: "",  label_zh: "放置方块", label_en: "Blocks Placed",  scale: 80000,  order: 4, champion: true },
  { key: "blocks_broken",  unit: "",  label_zh: "破坏方块", label_en: "Blocks Broken",  scale: 80000,  order: 5, champion: true },
  { key: "kills_total",    unit: "",  label_zh: "击杀数",   label_en: "Kills",          scale: 5000,   order: 6, champion: true },
];

export const AXIS_KEYS = METRICS.map(m => m.key);

const UNITS = Object.fromEntries(METRICS.map(m => [m.key, m.unit]));
const SCALES = Object.fromEntries(METRICS.map(m => [m.key, m.scale]));

// Plain copy for `metrics.list` reply — protects METRICS from accidental
// mutation by handler code on its way out the wire.
export function metricsPayload() {
  return METRICS.map(m => ({
    key: m.key,
    unit: m.unit,
    label_zh: m.label_zh,
    label_en: m.label_en,
    scale: m.scale,
    order: m.order,
    champion: m.champion,
  }));
}

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
