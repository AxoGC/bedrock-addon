import { variables } from "@minecraft/server-admin";

function readVar(key, fallback) {
  try {
    const v = variables.get(key);
    if (typeof v === "string" && v.length > 0) return v;
  } catch (_) { /* variable 未配置时 .get 会抛 */ }
  return fallback;
}

export const BASE_URL = readVar("platformBaseUrl", "http://localhost:8080").replace(/\/+$/, "");
export const TOKEN    = readVar("serverToken", "");

export const POLL_TIMEOUT_SEC = 35;
export const POST_TIMEOUT_SEC = 10;

export const STATS_KEY_PREFIX = "stats:";
export const STATS_FLUSH_INTERVAL_TICKS = 60 * 20;
export const HEARTBEAT_INTERVAL_TICKS   = 30 * 20;
export const LEADERBOARD_INTERVAL_TICKS = 60 * 60 * 20;
export const CLEANUP_INTERVAL_TICKS     = 7 * 24 * 3600 * 20;
export const PLAY_TIME_TICK_INTERVAL    = 20;

export const LEADERBOARD_METRICS = [
  "play_time",
  "mob_kills_total",
  "pvp_kills",
  "blocks_broken_total",
  "blocks_placed_total",
  "valuable_broken",
];

export const STATS_RETENTION_MS = 90 * 24 * 3600 * 1000;
