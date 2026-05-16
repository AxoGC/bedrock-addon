import { world } from "@minecraft/server";

function sanitize(s) {
  return String(s || "").replace(/["\r\n]/g, "");
}

export function handleWhitelistAdd(data) {
  if (!data || typeof data.name !== "string") return { added: false };
  const name = sanitize(data.name);
  if (!name) return { added: false };
  try {
    world.getDimension("overworld").runCommand(`allowlist add "${name}"`);
    return { added: true };
  } catch (e) {
    console.warn("[whitelist add] failed", e);
    return { added: false };
  }
}

export function handleWhitelistRemove(data) {
  if (!data || typeof data.name !== "string") return { removed: false };
  const name = sanitize(data.name);
  if (!name) return { removed: false };
  try {
    world.getDimension("overworld").runCommand(`allowlist remove "${name}"`);
    return { removed: true };
  } catch (e) {
    console.warn("[whitelist remove] failed", e);
    return { removed: false };
  }
}
