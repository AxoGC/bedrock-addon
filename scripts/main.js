import { world, system } from "@minecraft/server";
import {
  STATS_FLUSH_INTERVAL_TICKS,
  HEARTBEAT_INTERVAL_TICKS,
  LEADERBOARD_INTERVAL_TICKS,
  CLEANUP_INTERVAL_TICKS,
  TOKEN,
} from "./config.js";
import { registerEventSubscriptions, startPlayTimeTicker, startWalkSampler } from "./observation/events.js";
import { registerBindCommand } from "./commands/bind.js";
import { startPoll } from "./transport/poll.js";
import { dispatchEvent } from "./handlers/dispatch.js";
import { flushAll } from "./storage/stats.js";
import { startLeaderboardJob } from "./rank/leaderboard.js";
import { cleanupOldStats } from "./storage/cleanup.js";
import { postSrv } from "./transport/http.js";

// === early execution: 自定义命令必须在 startup 阶段注册 ===
registerBindCommand();

// === 文件顶层注册事件订阅（不访问 world state，安全）===
registerEventSubscriptions();

// === 玩家和 world state 相关的初始化在 worldLoad 之后 ===
world.afterEvents.worldLoad.subscribe(() => {
  if (!TOKEN) {
    console.warn("[platform] serverToken is empty — addon will not connect to platform.");
    return;
  }

  // play_time 累加（每秒）
  startPlayTimeTicker();

  // walk_distance_m 累加（每秒按水平坐标差）
  startWalkSampler();

  // stats flush 定期落盘
  system.runInterval(() => flushAll(), STATS_FLUSH_INTERVAL_TICKS);

  // 心跳（首条成功打一行 INFO 便于确认链路；之后只在失败时打 WARN）
  let heartbeatOk = false;
  system.runInterval(() => {
    const players = world.getAllPlayers();
    const names = players.map(p => p.name);
    postSrv("heartbeat", {
      online: players.length,
      max: 20,
      players: names,
    }).then(resp => {
      if (!heartbeatOk && resp.status >= 200 && resp.status < 300) {
        heartbeatOk = true;
        console.warn(`[platform] heartbeat ok (online=${players.length})`);
      }
    }).catch(err => console.warn("[heartbeat] failed", err));
  }, HEARTBEAT_INTERVAL_TICKS);

  // 排行汇总
  startLeaderboardJob(LEADERBOARD_INTERVAL_TICKS);

  // 老玩家清理
  system.runInterval(() => system.runJob(cleanupOldStats()), CLEANUP_INTERVAL_TICKS);

  // 长轮询启动
  startPoll(dispatchEvent);

  console.warn("[platform] bridge online");
});
