import { world } from "@minecraft/server";

export function handleBroadcast(data) {
  if (!data || typeof data.message !== "string") return;
  try {
    world.sendMessage(`§e[公告]§r ${data.message}`);
  } catch (e) {
    console.warn("[broadcast] failed", e);
  }
}
