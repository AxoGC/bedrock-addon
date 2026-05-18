import { world, system, Player } from "@minecraft/server";
import { ensureFirstJoin, incrStats, flushOne, dropFromCache, load } from "../storage/stats.js";
import { postSrv } from "../transport/http.js";
import { onChatSend } from "../chat/chat.js";

const VALUABLE_BREAK = new Set([
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:ancient_debris",
]);

const CONTAINER_TYPES = new Set([
  "minecraft:chest", "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:undyed_shulker_box", "minecraft:shulker_box",
  "minecraft:white_shulker_box", "minecraft:orange_shulker_box",
  "minecraft:magenta_shulker_box", "minecraft:light_blue_shulker_box",
  "minecraft:yellow_shulker_box", "minecraft:lime_shulker_box",
  "minecraft:pink_shulker_box", "minecraft:gray_shulker_box",
  "minecraft:light_gray_shulker_box", "minecraft:cyan_shulker_box",
  "minecraft:purple_shulker_box", "minecraft:blue_shulker_box",
  "minecraft:brown_shulker_box", "minecraft:green_shulker_box",
  "minecraft:red_shulker_box", "minecraft:black_shulker_box",
  "minecraft:dispenser", "minecraft:dropper",
  "minecraft:hopper",
  "minecraft:ender_chest",
]);

export function registerEventSubscriptions() {
  world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
    if (!initialSpawn) return;
    const now = Date.now();
    ensureFirstJoin(player.name, now);
    flushOne(player.name);
    postSrv("player.joined", { name: player.name }).catch(err => {
      console.warn("[event] player.joined failed", err);
    });
  });

  world.afterEvents.playerLeave.subscribe(({ playerName }) => {
    if (!playerName) return;
    const s = load(playerName);
    s.last_seen_at = Date.now();
    flushOne(playerName);
    dropFromCache(playerName);
    postSrv("player.left", { name: playerName }).catch(err => {
      console.warn("[event] player.left failed", err);
    });
  });

  world.afterEvents.playerBreakBlock.subscribe((e) => {
    const name = e.player && e.player.name;
    if (!name) return;
    const beforeId = e.brokenBlockPermutation && e.brokenBlockPermutation.type && e.brokenBlockPermutation.type.id;
    incrStats(name, "blocks_broken_total", 1);
    if (beforeId && VALUABLE_BREAK.has(beforeId)) {
      incrStats(name, "valuable_broken", 1);
    }
  });

  world.afterEvents.playerPlaceBlock.subscribe((e) => {
    const name = e.player && e.player.name;
    if (!name) return;
    incrStats(name, "blocks_placed_total", 1);
  });

  world.afterEvents.playerInteractWithBlock.subscribe((e) => {
    const name = e.player && e.player.name;
    if (!name) return;
    const blockId = e.block && e.block.typeId;
    if (blockId && CONTAINER_TYPES.has(blockId)) {
      incrStats(name, "chests_opened", 1);
    }
  });

  world.afterEvents.entityDie.subscribe((e) => {
    const victim = e.deadEntity;
    const killer = e.damageSource && e.damageSource.damagingEntity;
    if (victim instanceof Player) {
      incrStats(victim.name, "deaths", 1);
      if (killer instanceof Player) {
        incrStats(killer.name, "pvp_kills", 1);
      }
      const payload = { name: victim.name, cause: (e.damageSource && e.damageSource.cause) || "" };
      if (killer instanceof Player) {
        payload.killer = killer.name;
        payload.killer_kind = "player";
      } else if (killer && typeof killer.typeId === "string") {
        payload.killer = killer.typeId.replace(/^minecraft:/, "");
        payload.killer_kind = "mob";
      } else {
        payload.killer = "";
        payload.killer_kind = "";
      }
      postSrv("player.died", payload).catch(err => {
        console.warn("[event] player.died failed", err);
      });
    } else if (killer instanceof Player) {
      incrStats(killer.name, "mob_kills_total", 1);
    }
  });

  world.afterEvents.entityHurt.subscribe((e) => {
    const dmg = Number(e.damage) || 0;
    if (dmg <= 0) return;
    const hurt   = e.hurtEntity;
    const source = e.damageSource && e.damageSource.damagingEntity;
    if (source instanceof Player) {
      incrStats(source.name, "damage_dealt", dmg);
    }
    if (hurt instanceof Player) {
      incrStats(hurt.name, "damage_taken", dmg);
    }
  });

  // chatSend 在 @minecraft/server 2.0 stable 中被移除；优先 afterEvents，
  // 兜底 beforeEvents。两个都不存在就放弃聊天镜像上报（其余功能不受影响）。
  const chatHook = world.afterEvents && world.afterEvents.chatSend
    ? world.afterEvents.chatSend
    : (world.beforeEvents && world.beforeEvents.chatSend);
  if (chatHook && typeof chatHook.subscribe === "function") {
    chatHook.subscribe((e) => {
      const sender = e.sender && e.sender.name;
      const message = e.message;
      if (!sender || typeof message !== "string") return;
      if (message.length === 0 || message.charAt(0) === "/") return;
      system.run(() => onChatSend(sender, message));
    });
  } else {
    console.warn("[platform] world.*.chatSend unavailable in this Bedrock build; skip chat mirror");
  }
}

export function startPlayTimeTicker() {
  system.runInterval(() => {
    for (const p of world.getAllPlayers()) {
      incrStats(p.name, "play_time", 1);
    }
  }, 20);
}

// Per-second horizontal walk distance sampler. Bedrock has no Bukkit-style
// WALK_ONE_CM statistic, so we approximate by Δxz between samples. A jump
// > 20m in one second is treated as a teleport / respawn and discarded.
// Y axis is ignored so falls / climbs don't inflate the meter.
const _lastPos = new Map();

export function startWalkSampler() {
  system.runInterval(() => {
    const seen = new Set();
    for (const p of world.getAllPlayers()) {
      const name = p.name;
      seen.add(name);
      const loc = p.location;
      if (!loc) continue;
      const prev = _lastPos.get(name);
      if (prev) {
        const dx = loc.x - prev.x;
        const dz = loc.z - prev.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > 0.1 && d <= 20) {
          incrStats(name, "walk_distance_m", d);
        }
      }
      _lastPos.set(name, { x: loc.x, z: loc.z });
    }
    for (const name of _lastPos.keys()) {
      if (!seen.has(name)) _lastPos.delete(name);
    }
  }, 20);
}
