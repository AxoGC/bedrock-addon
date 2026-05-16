// 运行时配置 —— 直接硬编码即可。
// Bedrock addon 不需要打包/编译，本文件就是配置文件本身：
// 部署到具体 BDS 时把下面两行改成真实值。仓库内保留占位，避免泄露。
export const BASE_URL = "REPLACE_WITH_PLATFORM_URL";   // 例：https://www.axogc.net
export const TOKEN    = "REPLACE_WITH_SERVER_TOKEN";

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
