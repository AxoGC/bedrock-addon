import { world } from "@minecraft/server";

export function handleNotify(data) {
  if (!data || typeof data.name !== "string") return;
  const message = typeof data.message === "string" ? data.message : "";
  for (const p of world.getAllPlayers()) {
    if (p.name === data.name) {
      try { p.sendMessage(message); } catch (e) { console.warn("[notify] failed", e); }
      return;
    }
  }
  // 玩家离线：直接丢弃
}
