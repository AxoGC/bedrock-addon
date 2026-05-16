import { world } from "@minecraft/server";
import { STATS_KEY_PREFIX, STATS_RETENTION_MS } from "../config.js";
import { dropFromCache } from "./stats.js";

export function* cleanupOldStats() {
  const cutoff = Date.now() - STATS_RETENTION_MS;
  const ids = world.getDynamicPropertyIds();
  for (const key of ids) {
    if (!key.startsWith(STATS_KEY_PREFIX)) { yield; continue; }
    const raw = world.getDynamicProperty(key);
    if (typeof raw !== "string") { yield; continue; }
    let lastSeen = 0;
    let bad = false;
    try {
      const s = JSON.parse(raw);
      lastSeen = Number(s && s.last_seen_at) || 0;
    } catch (_) {
      bad = true;
    }
    if (bad || lastSeen < cutoff) {
      try {
        world.setDynamicProperty(key, undefined);
        dropFromCache(key.slice(STATS_KEY_PREFIX.length));
      } catch (e) {
        console.warn("[cleanup] delete failed", key, e);
      }
    }
    yield;
  }
}
