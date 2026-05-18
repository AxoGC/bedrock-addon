import { replyEvent } from "../transport/http.js";
import { handleNotify } from "./notify.js";
import { handleBroadcast } from "./broadcast.js";
import { handleKick } from "./kick.js";
import { handleWhitelistAdd, handleWhitelistRemove } from "./whitelist.js";
import { handleStatsFetch } from "./stats_fetch.js";
import { handleChatFromWeb } from "./chat_from_web.js";
import { handleAdminCommand } from "./admin_command.js";

export async function dispatchEvent(event) {
  if (!event || typeof event !== "object") return;
  const id = event.id;
  const command = event.command;
  const data = event.data || {};

  try {
    switch (command) {
      case "player.notify":
        handleNotify(data);
        return;
      case "server.broadcast":
        handleBroadcast(data);
        return;
      case "player.kick":
        handleKick(data);
        return;
      case "chat.from_web":
        handleChatFromWeb(data);
        return;
      case "player.whitelist.add": {
        const r = handleWhitelistAdd(data);
        if (id) await replyEvent(id, true, r).catch(e => console.warn("[reply] add", e));
        return;
      }
      case "player.whitelist.remove": {
        const r = handleWhitelistRemove(data);
        if (id) await replyEvent(id, true, r).catch(e => console.warn("[reply] rm", e));
        return;
      }
      case "player.stats.fetch": {
        const r = handleStatsFetch(data);
        if (id) await replyEvent(id, true, r).catch(e => console.warn("[reply] stats", e));
        return;
      }
      case "admin.command.run": {
        const r = handleAdminCommand(data);
        if (id) await replyEvent(id, r.ok, r).catch(e => console.warn("[reply] admin", e));
        return;
      }
      default:
        console.warn("[dispatch] unknown command:", command);
        if (id) {
          await replyEvent(id, false, null, "UNKNOWN_COMMAND")
            .catch(e => console.warn("[reply] unknown", e));
        }
    }
  } catch (err) {
    console.warn("[dispatch] handler error", command, err);
    if (id) {
      await replyEvent(id, false, null, "HANDLER_ERROR")
        .catch(e => console.warn("[reply] err", e));
    }
  }
}
