import { world } from "@minecraft/server";

/**
 * Admin console command handler. Maps a typed (kind, target, reason, raw)
 * request from core into a Bedrock command and runs it on the overworld
 * dimension's command queue. Bedrock's CommandResult only carries a
 * successCount (no stdout text) — we surface that as a synthetic output line.
 *
 * Bedrock-specific notes:
 *  - Uses "allowlist" (Bedrock's spelling), not "whitelist".
 *  - ban/pardon are intentionally not supported — Bedrock has no equivalent
 *    server-side; core's UI greys these buttons out for mc-bedrock servers.
 */
export function handleAdminCommand(data) {
  if (!data || typeof data.kind !== "string") {
    return { ok: false, output: "missing kind" };
  }
  const kind = data.kind;
  const target = sanitize(data.target);
  const reason = sanitize(data.reason);
  const raw = sanitize(data.raw);

  const cmd = buildCommand(kind, target, reason, raw);
  if (!cmd) {
    return { ok: false, output: "invalid request" };
  }
  try {
    const res = world.getDimension("overworld").runCommand(cmd);
    const success = (res && typeof res.successCount === "number") ? res.successCount : 0;
    return {
      ok: success > 0,
      output: success > 0 ? `executed (successCount=${success})` : "executed (no effect)",
      dispatched: cmd,
    };
  } catch (e) {
    return { ok: false, output: `error: ${e && e.message ? e.message : String(e)}`, dispatched: cmd };
  }
}

function buildCommand(kind, target, reason, raw) {
  switch (kind) {
    case "raw": {
      if (!raw) return null;
      const stripped = raw.startsWith("/") ? raw.slice(1) : raw;
      return stripped.trim();
    }
    case "kick":
      if (!target) return null;
      return reason ? `kick "${target}" ${reason}` : `kick "${target}"`;
    case "whitelist_add":
      if (!target) return null;
      return `allowlist add "${target}"`;
    case "whitelist_remove":
      if (!target) return null;
      return `allowlist remove "${target}"`;
    default:
      return null;
  }
}

function sanitize(s) {
  return String(s || "").replace(/["\r\n]/g, "").trim();
}
