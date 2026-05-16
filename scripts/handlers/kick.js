import { world } from "@minecraft/server";

function sanitize(s) {
  return String(s || "").replace(/["\r\n]/g, "");
}

export function handleKick(data) {
  if (!data || typeof data.name !== "string") return;
  const name = sanitize(data.name);
  const reason = sanitize(data.reason);
  if (!name) return;
  try {
    const dim = world.getDimension("overworld");
    if (reason) {
      dim.runCommand(`kick "${name}" ${reason}`);
    } else {
      dim.runCommand(`kick "${name}"`);
    }
  } catch (e) {
    console.warn("[kick] failed", e);
  }
}
