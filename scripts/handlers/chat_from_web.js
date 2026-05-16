import { world } from "@minecraft/server";
import { markIncomingFromWeb } from "../chat/chat.js";

export function handleChatFromWeb(data) {
  if (!data || typeof data.content !== "string") return;
  const sender = typeof data.sender === "string" ? data.sender : "web";
  const content = data.content;
  const line = `§7[Web] §f${sender}: ${content}`;
  markIncomingFromWeb(content);
  try {
    world.sendMessage(line);
  } catch (e) {
    console.warn("[chat.from_web] failed", e);
  }
}
