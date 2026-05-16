import {
  system,
  world,
  Player,
  CustomCommandStatus,
  CustomCommandParamType,
  CommandPermissionLevel,
} from "@minecraft/server";
import { postSrv } from "../transport/http.js";

const FAIL_LIMIT     = 3;
const LOCKOUT_MS     = 10 * 60 * 1000;
const failTracker    = new Map();

function isLocked(name) {
  const rec = failTracker.get(name);
  if (!rec) return 0;
  const left = rec.lockedUntil - Date.now();
  return left > 0 ? left : 0;
}

function recordFail(name) {
  const now = Date.now();
  const rec = failTracker.get(name) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= FAIL_LIMIT) {
    rec.lockedUntil = now + LOCKOUT_MS;
    rec.fails = 0;
  }
  failTracker.set(name, rec);
}

function clearFails(name) {
  failTracker.delete(name);
}

function notifyPlayer(player, msg) {
  try { player.sendMessage(msg); } catch (e) { console.warn("[bind] sendMessage failed", e); }
}

function findOnlinePlayer(name) {
  for (const p of world.getAllPlayers()) {
    if (p.name === name) return p;
  }
  return null;
}

async function handleBind(playerName, code) {
  const lockedLeft = isLocked(playerName);
  if (lockedLeft > 0) {
    const mins = Math.ceil(lockedLeft / 60000);
    const p = findOnlinePlayer(playerName);
    if (p) notifyPlayer(p, `§c[平台]§r 失败次数过多，请 ${mins} 分钟后重试。`);
    return;
  }

  const trimmed = String(code || "").trim().toUpperCase();
  if (!trimmed) {
    const p = findOnlinePlayer(playerName);
    if (p) notifyPlayer(p, "§c[平台]§r 验证码不能为空。用法：/platform:bind <CODE>");
    return;
  }

  let resp;
  try {
    resp = await postSrv("binding.request", {
      code: trimmed,
      player: { name: playerName },
    });
  } catch (err) {
    console.warn("[bind] request error", err);
    const p = findOnlinePlayer(playerName);
    if (p) notifyPlayer(p, "§c[平台]§r 网络异常，请稍后重试。");
    return;
  }

  let payload = null;
  try { payload = JSON.parse(resp.body || "{}"); } catch (_) { payload = null; }
  const code200 = resp.status >= 200 && resp.status < 300;
  const okEnvelope = payload && payload.code === "OK";

  if (code200 && okEnvelope) {
    clearFails(playerName);
    // 绑定成功的反馈走 player.notify 下行（core 端处理），这里也兜底回一条
    const p = findOnlinePlayer(playerName);
    if (p) notifyPlayer(p, "§a[平台]§r 绑定请求已提交，结果将稍后通知。");
    return;
  }

  recordFail(playerName);
  const errCode = (payload && payload.code) || `HTTP_${resp.status}`;
  const p = findOnlinePlayer(playerName);
  if (p) notifyPlayer(p, `§c[平台]§r 绑定失败：${errCode}`);
}

export function registerBindCommand() {
  system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    customCommandRegistry.registerCommand(
      {
        name: "platform:bind",
        description: "绑定平台账号 (用法: /platform:bind <验证码>)",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
          { type: CustomCommandParamType.String, name: "code" },
        ],
      },
      (origin, code) => {
        const ent = origin.sourceEntity;
        if (!(ent instanceof Player)) {
          return { status: CustomCommandStatus.Failure };
        }
        const name = ent.name;
        system.run(() => { handleBind(name, code); });
        return { status: CustomCommandStatus.Success };
      }
    );
  });
}
