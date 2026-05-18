import { getStats } from "../storage/stats.js";
import { buildAxesArray } from "../stats/axes.js";

// Returns the ordered 6-axis array for the requested player.
// Always returns the full axis set (with zero values) so the radar shape
// is well-defined even for brand-new players — the frontend can choose to
// show a "no data" overlay if it wants.
export function handleStatsFetch(data) {
  if (!data || typeof data.name !== "string") {
    return { stats: buildAxesArray(null) };
  }
  const raw = getStats(data.name);
  return { stats: buildAxesArray(raw) };
}
