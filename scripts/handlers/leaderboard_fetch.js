import { snapshotSlice } from "../rank/leaderboard.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// `leaderboard.fetch` (reply): slice the in-memory rank snapshot. Snapshot is
// rebuilt on the addon's own cadence (rank/leaderboard.js); we just read here.
// Unknown metrics return an empty list — core caches that and the radar still
// renders a "no data" row.
export function handleLeaderboardFetch(data) {
  if (!data || typeof data.metric !== "string") return { entries: [] };
  let limit = Number(data.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return { entries: snapshotSlice(data.metric, limit) };
}
