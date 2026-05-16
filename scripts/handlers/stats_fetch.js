import { getStats } from "../storage/stats.js";

export function handleStatsFetch(data) {
  if (!data || typeof data.name !== "string") return { stats: null };
  const stats = getStats(data.name);
  return { stats: stats || {} };
}
