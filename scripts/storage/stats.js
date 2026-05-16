import { world } from "@minecraft/server";
import { STATS_KEY_PREFIX } from "../config.js";

const cache = new Map();
const dirty = new Set();

function keyOf(name) {
  return STATS_KEY_PREFIX + name;
}

export function load(name) {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = world.getDynamicProperty(keyOf(name));
  let s = {};
  if (typeof raw === "string") {
    try { s = JSON.parse(raw) || {}; } catch (_) { s = {}; }
  }
  cache.set(name, s);
  return s;
}

export function getStats(name) {
  const raw = world.getDynamicProperty(keyOf(name));
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

export function incrStats(name, field, delta) {
  if (!name) return;
  const s = load(name);
  s[field] = (Number(s[field]) || 0) + delta;
  dirty.add(name);
}

export function setField(name, field, value) {
  if (!name) return;
  const s = load(name);
  s[field] = value;
  dirty.add(name);
}

export function ensureFirstJoin(name, ts) {
  const s = load(name);
  if (!s.first_join_at) {
    s.first_join_at = ts;
    dirty.add(name);
  }
  s.last_seen_at = ts;
  dirty.add(name);
}

export function flushOne(name) {
  const s = cache.get(name);
  if (!s) return;
  try {
    world.setDynamicProperty(keyOf(name), JSON.stringify(s));
  } catch (e) {
    console.warn("[stats] flush failed", name, e);
  }
  dirty.delete(name);
}

export function flushAll() {
  for (const name of dirty) flushOne(name);
}

export function dropFromCache(name) {
  cache.delete(name);
}

export function listStatsKeys() {
  const ids = world.getDynamicPropertyIds();
  const out = [];
  for (const k of ids) {
    if (k.startsWith(STATS_KEY_PREFIX)) out.push(k);
  }
  return out;
}
