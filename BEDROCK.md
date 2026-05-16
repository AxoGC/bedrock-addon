# Minecraft Bedrock Script API 调研文档（v1）

> 范围：身份绑定、数据汇总上报、行为日志上报。
> 不含：领地系统（R 树、rbush）。
> 目标读者：要按计划书写 `bedrock-addon/scripts/**/*.ts` 的 AI。
> 计划书对应章节：4.5（事件表）/ 9（绑定流程）/ 10.3（Bedrock 数据采集）/ 15.3（插件结构）。

## 0. 一句话原则

Bedrock Addon 是一段跑在 BDS（Bedrock Dedicated Server）进程内的 JavaScript（QuickJS 引擎）。它能订阅游戏事件、读写 Dynamic Property 做持久化、用 `@minecraft/server-net` 发 HTTP，但**不能开端口、不能监听 HTTP**——所以平台 ↔ Addon 通信只能"Addon 当 HTTP client 主动连 core"，这正好和计划书第四章的长轮询设计契合。

---

## 1. 版本与依赖

### 1.1 模块矩阵（写代码时直接照抄）

`manifest.json` 的 `dependencies` 块：

```json
{
  "dependencies": [
    { "module_name": "@minecraft/server",       "version": "2.0.0" },
    { "module_name": "@minecraft/server-net",   "version": "1.0.0-beta" },
    { "module_name": "@minecraft/server-admin", "version": "1.0.0-beta" }
  ]
}
```

- `@minecraft/server` **走稳定 2.x 轨**（2.0.0 已于 2025 年 9 月转稳定，覆盖 Minecraft 1.21.84+）。1.x 仍然可用并长期维护，但新写的项目直接上 2.x。
- `@minecraft/server-net` **永远 beta**，写 `1.0.0-beta` 即可。需要在世界设置或 BDS 启动参数里开 "Beta APIs" 实验。
- `@minecraft/server-admin` 也是 beta，但有"Variables / Secrets"机制，让 server-token 不进二进制（详见 §6.4）。
- 上述 beta 模块**只在 BDS 上可用**，客户端单机/Realms 不可用——这对我们没影响，反正生产就是 BDS。

### 1.2 manifest 完整骨架

```json
{
  "format_version": 2,
  "header": {
    "name": "Platform Bridge",
    "description": "Bedrock 接入平台 core",
    "uuid": "<生成 UUID-1>",
    "version": [1, 0, 0],
    "min_engine_version": [1, 21, 84]
  },
  "modules": [
    {
      "type": "script",
      "language": "javascript",
      "entry": "scripts/main.js",
      "uuid": "<生成 UUID-2>",
      "version": [1, 0, 0]
    }
  ],
  "dependencies": [
    { "module_name": "@minecraft/server",       "version": "2.0.0" },
    { "module_name": "@minecraft/server-net",   "version": "1.0.0-beta" },
    { "module_name": "@minecraft/server-admin", "version": "1.0.0-beta" }
  ]
}
```

两个 UUID 必须不同，且 `entry` 永远填编译后的 `.js`（即使源码是 TS）。

### 1.3 BDS 侧 `permissions.json`（一次性配置）

`config/default/permissions.json` 或者 `config/<addon_uuid>/permissions.json`：

```json
{
  "allowed_modules": [
    "@minecraft/server",
    "@minecraft/server-ui",
    "@minecraft/server-net",
    "@minecraft/server-admin"
  ]
}
```

不写就用不了 `server-net`、`server-admin`。

---

## 2. 执行模型（**这一节理解错就什么都写不对**）

### 2.1 三种"特权模式"

| 模式 | 何时进入 | 能做什么 |
|---|---|---|
| **early execution** | 脚本首次加载、`system.beforeEvents.startup` 回调、`world.afterEvents.worldLoad` 之前 | 注册自定义命令 / 订阅事件 / 注册自定义组件；**不能**访问 `world.getAllPlayers()`、读写 dynamic property 等任何 world state |
| **restricted（read-only）** | 所有 `beforeEvents` 回调里 | 读 world state OK；写 state 必须套 `system.run(() => ...)` 延迟到下个 tick |
| **normal** | `afterEvents` 回调、`system.run/runTimeout/runInterval` 回调、`system.runJob` 生成器 | 完整 API |

### 2.2 启动顺序（v2 的关键变化）

```
脚本文件被 load（early execution，world 还没好）
  → system.beforeEvents.startup 回调（仍 early execution，但能注册命令/组件）
  → ... world 加载 ...
  → world.afterEvents.worldLoad 回调（normal mode，能访问 world state）
  → 第一个 game tick
```

**所有跟 world 打交道的初始化逻辑**（启动轮询、读 dynamic property、`getAllPlayers()` 等）**必须放进 `world.afterEvents.worldLoad`**，不能放在文件顶层；以下 v1 时代的代码在 v2 会直接报错：

```ts
// ❌ v2 这样写会爆
import { world } from "@minecraft/server";
for (const p of world.getAllPlayers()) p.sendMessage("hi"); // 顶层访问 world state

// ✅ 正确写法
world.afterEvents.worldLoad.subscribe(() => {
  for (const p of world.getAllPlayers()) p.sendMessage("hi");
});
```

事件订阅本身（如 `world.afterEvents.playerSpawn.subscribe(...)`）在文件顶层是 OK 的，因为订阅不访问 world state。

### 2.3 没有原生 `setTimeout`，用 `system`

QuickJS 引擎不暴露 `setTimeout`/`setInterval`。tick 调度都走 `system`：

```ts
import { system } from "@minecraft/server";

system.run(fn);                   // 下一个 tick 跑
system.runTimeout(fn, 20);        // 20 tick 后跑（20 tick = 1 秒）
const id = system.runInterval(fn, 60);  // 每 60 tick 跑，返回 handle
system.clearRun(id);              // 取消

// 长任务用生成器 + runJob，自动按帧切片避免 watchdog 杀脚本
function* longTask() {
  for (let i = 0; i < 10000; i++) {
    doSomething(i);
    yield;  // 让出一帧
  }
}
system.runJob(longTask());
```

需要"等 N tick" 的协程写法：

```ts
const sleep = (ticks: number) =>
  new Promise<void>(r => system.runTimeout(() => r(), ticks));

await sleep(20);  // 等 1 秒
```

### 2.4 Watchdog（不踩这个坑）

BDS 有性能 watchdog：单 tick 卡 >10s（`script-watchdog-hang-threshold`，默认 10000ms）或脚本内存 >250MB 会被强杀，世界保存关服。所以：

- **HTTP 不要 `await` 在 `beforeEvents`/`afterEvents` 里同步等返回**——promise 在 v2 里能 tick 内 flush，但 HTTP 本身耗时数十到数百毫秒，多个 await 串起来很容易超时。正确做法是发出去就走，回调里处理结果（用 `.then()` 而不是 `await`），见 §6.2。
- 全量扫 dynamic property 这种活用 `system.runJob` 切片，不要在一个 tick 里跑完。

可订阅 `system.beforeEvents.watchdogTerminate` 来兜底，但更好的是别让它触发。

---

## 3. 玩家身份与事件（绑定流程的基础）

### 3.1 Player 的标识字段

| 字段 | 类型 | 性质 | 备注 |
|---|---|---|---|
| `player.name` | string | **当前游戏名**（Bedrock 是 Xbox gamertag） | 改名会变。计划书第 9 章已经确定"身份绑定 = GameName 绑定，改名 = 新身份重新走绑定流程"，所以这个就是绑定的依据 |
| `player.id` | string | runtime entity id，例如 `-451021564564561` | **每次进服会变**，不能用来跨会话识别 |
| `player.nameTag` | string | 头顶显示的名字 | 可被脚本改，**不能**作为身份 |

**不要试图从 Script API 取 XUID**——`@minecraft/server` 没有暴露 XUID/Floodgate UUID。要拿 XUID 必须从 BDS 控制台日志里抓（玩家加入时 BDS 会打印 `Player connected: <name>, xuid: <xuid>`），但这超出 Addon 范围。计划书的设计是"游戏名由服务器报告"，所以**就用 `player.name`**，不要拼 XUID。

`POST /api/srv/player.joined` 的 `external_id` 字段可以**留空**，或者后续如果做改名容忍再说。

### 3.2 玩家加入/离开事件

```ts
import { world } from "@minecraft/server";

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;  // 死亡复活也会触发，要过滤
  // → POST /api/srv/player.joined { name: player.name }
});

world.afterEvents.playerLeave.subscribe(({ playerId, playerName }) => {
  // 注意：playerLeave 事件里只有 playerId + playerName，没有 player 对象（玩家已离线）
  // → POST /api/srv/player.left { name: playerName }
});
```

**坑**：

1. `playerSpawn` 既会在初次加入触发，也会在死亡复活后触发，必须用 `initialSpawn` 区分。计划书的 `player.joined` 只想要初次加入。
2. `playerLeave` **没有** `player` 对象，只有 `playerId` 和 `playerName`，因为玩家已经离开。所以"玩家离开时 flush 该玩家的 stats" 这件事，要在 `playerLeave` 触发的瞬间用 `playerName` 去查 dynamic property、构造 HTTP 请求——不能再调用 `player.sendMessage` 之类。
3. `playerSpawn` 触发瞬间玩家的实体未必完全可用。计划书里没有"加入瞬间立刻 teleport"这类需求，但如果以后要做，按官方建议加 `system.runTimeout(..., 20)` 推迟 1 秒。

### 3.3 玩家在线列表

```ts
const players = world.getAllPlayers();  // Player[]
// players.length 即在线人数
// players.map(p => p.name) 即在线名单
```

`getAllPlayers()` 是 normal mode 才能调，所以心跳上报必须在 `runInterval` 回调里跑，不能在 `worldLoad` 之前。

### 3.4 `world.getPlayers()` vs `world.getAllPlayers()`

`getPlayers(options?)` 支持 filter（按 tag、距离、游戏模式等），不传参时跟 `getAllPlayers()` 等价。心跳/排行汇总场景统一用 `getAllPlayers()` 写起来更直白。

---

## 4. 自定义命令（绑定 `/bind <CODE>` 走这条路，不要靠 chatSend）

### 4.1 为什么不用 `chatSend`

Bedrock 没有"斜杠命令前缀触发钩子"的事件——`/bind ABC123` 默认会被 BDS 当成未知命令拒掉，根本不会进 `chatSend`（`chatSend` 只触发于普通聊天消息）。v1 时代的 workaround 是让玩家发普通聊天 `bind ABC123` 然后用 `beforeEvents.chatSend` 截掉，体验差且容易和别的功能冲突。

**v2 给了正经的自定义命令 API**（`@minecraft/server` 2.1.0+），用 `system.beforeEvents.startup` 注册一个真斜杠命令 `/<namespace>:<name>`。这就是计划书第 9.4 节"`/bind <CODE>` 指令处理"的正确实现方式。

### 4.2 注册命令骨架

```ts
import {
  system,
  CustomCommandStatus,
  CustomCommandParamType,
  CommandPermissionLevel,
  Player,
} from "@minecraft/server";

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand(
    {
      name: "platform:bind",                    // 必须带 namespace
      description: "绑定平台账号",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,                    // 关键：不需要开作弊就能用
      mandatoryParameters: [
        { type: CustomCommandParamType.String, name: "code" }
      ],
    },
    (origin, code: string) => {
      // ⚠ 这个回调跑在 before 上下文（restricted execution）
      // 不能直接改 world state，要改的话套 system.run
      const player = origin.sourceEntity;
      if (!(player instanceof Player)) {
        return { status: CustomCommandStatus.Failure };
      }
      // 处理逻辑放进 system.run，回调本身立刻返回
      system.run(() => handleBind(player, code));
      return { status: CustomCommandStatus.Success };
    }
  );
});

function handleBind(player: Player, code: string) {
  // POST /api/srv/binding.request { code, player: { name: player.name } }
  //   → 等 reply
  //   → reply 成功后给玩家发"绑定成功"消息
  //   → reply 失败发"绑定失败：xxx"
  // 失败 3 次禁用 10 分钟的逻辑也在这里做（用 Map<name, {fails, lockedUntil}>）
}
```

### 4.3 命令注册的几个注意点

- **必须在 `system.beforeEvents.startup` 里注册**——early execution 阶段，世界还没加载好。游戏启动后想动态加新命令做不到。
- **`name` 必须带 namespace**（如 `platform:bind`），玩家输入时也要带：`/platform:bind ABC123`。我们的玩家可能不习惯命名空间，可以在 `/docs` 里说明，或者在游戏内提示用自动补全（Bedrock 客户端会补全的）。
- **`cheatsRequired: false`** 关键：默认所有命令需要开作弊，绑定显然要常态可用，必须显式关掉。
- **`permissionLevel: Any`** 任何玩家可执行。
- 命令回调跑在 before 上下文，**绝大多数写操作（teleport、setDynamicProperty、sendMessage 也算写）会抛错**。把所有副作用包到 `system.run(() => ...)` 里。
- 参数类型有 `String / Integer / Float / Boolean / Enum / Position / EntitySelector / PlayerSelector / BlockType / ItemType`。绑定码用 `String` 即可。

### 4.4 给玩家发反馈（实现 `player.notify`）

绑定结果反馈 = 计划书第 4.5 节下行命令 `player.notify` 的接收实现。Addon 收到 `player.notify` command 后：

```ts
function handleNotifyCommand(data: { name: string; message: string }) {
  // 玩家可能离线
  const target = world.getAllPlayers().find(p => p.name === data.name);
  if (!target) return;  // 离线就丢弃，业务层容忍

  // 简单字符串
  target.sendMessage(data.message);

  // 或者富文本（如果 core 下发的 message 已经包含 §c 等颜色码，sendMessage 会原样处理）
  target.sendMessage(`§a[平台]§r ${data.message}`);

  // RawMessage 形式（支持 translate、selector 等，但我们这版用不到）
  // target.sendMessage({ rawtext: [{ text: "Hello " }, { selector: "@s" }] });
}
```

颜色码用 `§` 加 hex digit / 字母（`§c` 红、`§a` 绿、`§e` 黄、`§r` 重置）。Bedrock **不支持** Java 的 hex 颜色，只能用这 16 + Minecoin Gold 一种。

### 4.5 全服广播（实现 `server.broadcast`）

```ts
world.sendMessage(`§e[公告]§r ${data.message}`);
```

---

## 5. Dynamic Property（数据汇总的本地主存储）

### 5.1 三种 scope

| API | 存哪 | 生命周期 |
|---|---|---|
| `world.setDynamicProperty(key, value)` | world LevelDB | 与世界同寿，重启不丢 |
| `player.setDynamicProperty(key, value)` | 该 Entity（包括玩家） | 玩家不在线时**取不到**，且每次重连 entity 是新的 |
| `itemStack.setDynamicProperty(...)` | 该 ItemStack | 物品扔了/合并就没了 |

计划书第 10.3 节的设计是**用 world-scope，key = `stats:<gamename>`**，每个玩家一个键。这样能取离线玩家数据（`world.getDynamicProperty("stats:Steve")` 不要求 Steve 在线），契合"按需查 + 排行全量扫"的需求。**这个设计正确，直接照做。**

不要把 stats 存 player-scope，否则离线玩家排行扫不到。

### 5.2 类型与上限

可存类型：`string | number | boolean | Vector3`。我们要塞复杂对象（30-50 个字段的 stats），**只能 JSON 序列化成 string**。

- 单 string 值上限：**32,767 字节**（≈32KB）。
- 数字范围：64-bit float。
- 单 key 长度：未明确文档化，但 200 字符内安全。
- world-scope 总容量：未明确限制，但**累积过大会影响世界加载速度**——所以计划书"每周扫一次 90 天未登录的玩家清理掉"的设计是有意义的。

实测单玩家 30-50 个字段约 0.5-1KB，远低于 32KB 上限，OK。

### 5.3 读写 API

```ts
import { world } from "@minecraft/server";

// 写（值传 undefined 等于删除）
world.setDynamicProperty("stats:Steve", JSON.stringify(statsObj));
world.setDynamicProperty("stats:Steve", undefined);  // 删

// 读
const raw = world.getDynamicProperty("stats:Steve");
// raw 的类型是 string | number | boolean | Vector3 | undefined，要 narrow
if (typeof raw === "string") {
  const stats = JSON.parse(raw);
}

// 批量写
world.setDynamicProperties({
  "stats:Steve": JSON.stringify(a),
  "stats:Alex":  JSON.stringify(b),
});

// 枚举所有 key
const allKeys: string[] = world.getDynamicPropertyIds();
const statsKeys = allKeys.filter(k => k.startsWith("stats:"));

// 总字节数（性能诊断用）
const totalBytes = world.getDynamicPropertyTotalByteCount();
```

### 5.4 注意点

- **不要在每次累加事件触发时都 setDynamicProperty**——LevelDB 写盘有成本。计划书的"内存累加 + 60s flush"是对的：

  ```ts
  // 内存层
  const dirty = new Map<string, StatsObj>();  // gamename → stats

  world.afterEvents.playerBreakBlock.subscribe(({ player, brokenBlockPermutation }) => {
    const s = getOrLoad(player.name);
    s.blocks_broken_total++;
    if (isValuable(brokenBlockPermutation.type.id)) s.valuable_broken++;
    dirty.set(player.name, s);
  });

  system.runInterval(() => flushDirtyStats(), 60 * 20);  // 60 秒 = 1200 tick
  ```

- **玩家离开时立即 flush 该玩家的键**（计划书要求），因为 `playerLeave` 之后内存里的累加就丢了。
- **枚举 `getDynamicPropertyIds()` 的成本**：随着玩家数增长（几百人）这个数组本身就几百项，每次扫一遍 + 解析 JSON 在主线程不可忽略。**每周清理**和**每小时排行汇总**用 `system.runJob` 切片：

  ```ts
  function* rebuildLeaderboard() {
    const entries: Array<{name: string, score: number}> = [];
    for (const key of world.getDynamicPropertyIds()) {
      if (!key.startsWith("stats:")) continue;
      const raw = world.getDynamicProperty(key);
      if (typeof raw !== "string") continue;
      try {
        const s = JSON.parse(raw);
        entries.push({ name: key.slice(6), score: s.play_time ?? 0 });
      } catch { /* 跳过坏数据 */ }
      yield;  // 让出一帧
    }
    // POST /api/srv/leaderboard.update { metric: "play_time", entries }
    postLeaderboard("play_time", entries);
  }

  system.runInterval(() => system.runJob(rebuildLeaderboard()), 60 * 60 * 20);  // 每小时
  ```

---

## 6. HTTP 通信（`@minecraft/server-net`）

### 6.1 基本用法

```ts
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";

const req = new HttpRequest("https://platform.example.com/api/srv/heartbeat?token=xxx");
req.method  = HttpRequestMethod.Post;
req.body    = JSON.stringify({ online: 5, max: 20 });
req.headers = [new HttpHeader("Content-Type", "application/json")];
req.timeout = 35;  // 秒，比 core 的 28s 长轮询稍长

const resp = await http.request(req);
// resp: { status: number, body: string, headers: HttpHeader[] }
if (resp.status === 200) {
  const data = JSON.parse(resp.body);  // 平台统一 envelope: { code: "OK", data: ... }
}
```

### 6.2 长轮询循环（核心）

```ts
async function pollLoop() {
  // 注意：用 .then 链 + 错误 catch，避免一个 await 抛错就把整个循环挂掉
  while (running) {
    try {
      const req = new HttpRequest(`${BASE_URL}/api/srv/poll?token=${TOKEN}`);
      req.method  = HttpRequestMethod.Get;
      req.timeout = 35;  // 比 core 的 28s 阻塞挂起时间长，避免客户端先超时
      const resp  = await http.request(req);

      if (resp.status === 204) {
        // 长轮询超时无事件，立刻重连
        continue;
      }
      if (resp.status === 200) {
        const event = JSON.parse(resp.body);  // { id, command, data }
        // 关键：不要 await handle —— 立刻 fire 下一次 poll
        dispatchEvent(event).catch(err => console.warn("dispatch error", err));
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        console.warn("token 失效，停止 poll");
        running = false;
        break;
      }
      // 其他错误，等一会儿重试
      await sleep(20);  // 1 秒
    } catch (err) {
      console.warn("poll error", err);
      await sleep(60);  // 3 秒，避免 core 挂了死循环打爆
    }
  }
}

// 在 worldLoad 里启动
world.afterEvents.worldLoad.subscribe(() => {
  running = true;
  pollLoop();  // 不 await
});
```

### 6.3 上行调用（普通 POST）

```ts
function postSrv(action: string, body: object): Promise<HttpResponse> {
  const req = new HttpRequest(`${BASE_URL}/api/srv/${action}?token=${TOKEN}`);
  req.method  = HttpRequestMethod.Post;
  req.body    = JSON.stringify(body);
  req.headers = [new HttpHeader("Content-Type", "application/json")];
  req.timeout = 10;
  return http.request(req);
}

// 用法
postSrv("heartbeat",     { online: 5, max: 20, players: ["Steve", "Alex"] });
postSrv("player.joined", { name: "Steve" });
postSrv("audit.log",     { logs: bufferedLogs });
```

### 6.4 关于 token：用 server-admin Secrets 还是直接写代码里？

计划书第 4.1 节："token 通过 query 参数 `?token=<server_token>` 传递……饥荒 Lua API 不支持自定义请求头，统一走 query 是唯一可行方案"。所以 Bedrock 这里**也是 query 参数**，跟其他游戏对齐。

token 来源两条路：

**A. 写死在源码常量**（最简单）：

```ts
const TOKEN = "abc123def456...";  // 部署前替换
```

部署一次就改一次 source。Addon 一般通过 `behavior_packs/` 拷文件部署，**整个 `.mcpack` 没法加密**，但因为 BDS 物理上由我们控制，攻击面只有运维内部，可接受。

**B. 用 `@minecraft/server-admin` 的 Variables**（推荐）：

`config/<addon_uuid>/variables.json`：

```json
{
  "platformBaseUrl": "https://platform.example.com",
  "serverToken": "abc123def456..."
}
```

代码：

```ts
import { variables } from "@minecraft/server-admin";

const BASE_URL = variables.get("platformBaseUrl") as string;
const TOKEN    = variables.get("serverToken")    as string;
```

好处：换 token 不用重打包，只改 BDS 侧 JSON 配置重启即可。

**关于 Secrets**：Secrets 是给 Header 用的（`new HttpHeader("Authorization", secretString)`），值不会被脚本读到明文，只在底层 HTTP 调用时 resolve。对我们没用，因为我们 token 走 query 不走 header；如果以后改 header 鉴权再考虑用 Secrets。

### 6.5 BDS 出站连接限制

- `server-net` 没有"白名单 URL"机制，能访问任何能解析+可达的地址。
- **可访问 localhost / 内网 IP**（计划书提到的 `-allow_ioopenwrite_sandbox_escape` 启动参数是给文件 IO 用的，HTTP 出站没这个限制）。但生产部署是 BDS 在家用宽带、core 在云上，**用计划书第 16 章定的"备用私有域名"指过去**，IP 变化由 DNS 解析吸收。
- HTTPS OK，但证书必须是受信 CA 颁发的，自签证书会失败（没接口跳过验证）。Let's Encrypt 已经够用。

---

## 7. 行为日志事件（高价值事件白名单）

计划书第 10.3 节列了白名单。逐个对应到 Script API 的事件源。

### 7.1 容器打开（`chest_open` / `barrel_open` / `shulker_open` / `dispenser_open`）

Bedrock 没有"打开容器"独立事件，**用 `playerInteractWithBlock` + 过滤 typeId**：

```ts
import { world } from "@minecraft/server";

const CONTAINER_TYPES = new Set([
  "minecraft:chest", "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:undyed_shulker_box", "minecraft:shulker_box",
  // 还有 16 种带颜色的 shulker box：minecraft:white_shulker_box 等
  "minecraft:dispenser", "minecraft:dropper",
  "minecraft:hopper",
  "minecraft:ender_chest",
]);

world.afterEvents.playerInteractWithBlock.subscribe((e) => {
  const blockId = e.block.typeId;
  if (!CONTAINER_TYPES.has(blockId)) return;
  bufferAuditLog({
    player: e.player.name,
    action: "container.open",
    target: blockId.replace("minecraft:", ""),
    pos: { x: e.block.x, y: e.block.y, z: e.block.z },
    ts:  Date.now(),
  });
});
```

**坑**：`playerInteractWithBlock` 触发条件是"玩家右键方块且产生交互"，对容器是 OK 的。但**潜行右键容器是放置方块不是打开**，事件会触发但 `e.isFirstEvent` 之类的字段值会变化，写代码时实测一下。

**另一个坑**：玩家击中容器/破坏容器也会触发其他事件，我们只关心"打开"——`playerInteractWithBlock` 对应右键，OK。

### 7.2 死亡

```ts
import { Player, world } from "@minecraft/server";

world.afterEvents.entityDie.subscribe((e) => {
  if (!(e.deadEntity instanceof Player)) return;  // 只关心玩家死亡
  const player = e.deadEntity;
  const cause  = e.damageSource.cause;            // EntityDamageCause 枚举
  const killer = e.damageSource.damagingEntity;   // Entity | undefined
  bufferAuditLog({
    player: player.name,
    action: "player.death",
    target: killer ? (killer instanceof Player ? `player:${killer.name}` : killer.typeId) : `cause:${cause}`,
    pos:    { x: player.location.x, y: player.location.y, z: player.location.z },
    detail: { cause, killer_type: killer?.typeId },
    ts:     Date.now(),
  });
});
```

`EntityDamageCause` 枚举常见值：`entityAttack`、`projectile`、`fall`、`fire`、`drowning`、`lava`、`anvil`、`suicide`、`void` 等。

### 7.3 PvP 击杀

PvP 击杀 = "玩家死亡 + damagingEntity 是另一个玩家"，已经包含在 §7.2 里。但 stats 累加里 `pvp_kills` 是给击杀者计数的，所以同一事件要双向处理：

```ts
world.afterEvents.entityDie.subscribe((e) => {
  if (!(e.deadEntity instanceof Player)) return;
  const victim = e.deadEntity;
  const killer = e.damageSource.damagingEntity;

  // 死者 stats
  incrStats(victim.name, "deaths", 1);

  // 击杀者 stats（如果是玩家）
  if (killer instanceof Player) {
    incrStats(killer.name, "pvp_kills", 1);
    // 高价值事件单独写一条 audit log
    bufferAuditLog({
      player: killer.name,
      action: "pvp.kill",
      target: victim.name,
      pos:    { x: victim.location.x, y: victim.location.y, z: victim.location.z },
      ts:     Date.now(),
    });
  } else if (killer) {
    // 被怪物杀
    incrStats(killer.typeId, "mob_kills_total", 1);  // 错的，应该是 victim 被怪杀 = victim 死，不要给怪计数
  }
});

// 怪物被玩家杀（不是 PvP 但是 stats 要计 mob_kills_total）
world.afterEvents.entityDie.subscribe((e) => {
  if (e.deadEntity instanceof Player) return;       // 处理非玩家死亡
  const killer = e.damageSource.damagingEntity;
  if (killer instanceof Player) {
    incrStats(killer.name, "mob_kills_total", 1);
  }
});
```

### 7.4 关键方块的破坏/放置

```ts
const VALUABLE_BREAK = new Set([
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:ancient_debris",
]);

const HIGH_VALUE_BLOCKS = new Set([
  ...VALUABLE_BREAK,
  "minecraft:beacon",
  "minecraft:end_portal_frame",
  "minecraft:respawn_anchor",
  // 领地核心块（后定）
]);

world.afterEvents.playerBreakBlock.subscribe((e) => {
  const beforeId = e.brokenBlockPermutation.type.id;
  // 注意：e.block.typeId 此时已经是 "minecraft:air"，要用 brokenBlockPermutation
  incrStats(e.player.name, "blocks_broken_total", 1);
  if (VALUABLE_BREAK.has(beforeId)) {
    incrStats(e.player.name, "valuable_broken", 1);
  }
  if (HIGH_VALUE_BLOCKS.has(beforeId)) {
    bufferAuditLog({
      player: e.player.name,
      action: "block.break",
      target: beforeId.replace("minecraft:", ""),
      pos:    { x: e.block.x, y: e.block.y, z: e.block.z },
      ts:     Date.now(),
    });
  }
});

world.afterEvents.playerPlaceBlock.subscribe((e) => {
  const blockId = e.block.typeId;
  incrStats(e.player.name, "blocks_placed_total", 1);
  if (HIGH_VALUE_BLOCKS.has(blockId)) {
    bufferAuditLog({
      player: e.player.name,
      action: "block.place",
      target: blockId.replace("minecraft:", ""),
      pos:    { x: e.block.x, y: e.block.y, z: e.block.z },
      ts:     Date.now(),
    });
  }
});
```

**核心坑**：`playerBreakBlock` after 事件触发时，`e.block` 的 `typeId` 已经是 `minecraft:air`。要拿原始方块 ID **必须用 `e.brokenBlockPermutation.type.id`**。`playerPlaceBlock` 反过来，`e.block.typeId` 就是新放下去的方块 ID。

### 7.5 行为日志缓冲与上报

计划书要求"本地内存维护 ~2 小时短期缓冲 + 高价值事件异步 POST"：

```ts
// 短期缓冲（环形或简单切片，2 小时按 100 条/小时算 ~200 条上限够了）
const BUFFER_MAX = 500;
const buffer: AuditLogEntry[] = [];

function bufferAuditLog(entry: AuditLogEntry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
}

// 异步批量上报（每 30 秒一次 OR 累积到 50 条触发）
system.runInterval(() => {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, Math.min(50, buffer.length));
  // 上报失败不重试，不放回 buffer（计划书 10.3 节"POST 失败不重试"）
  // 但缓冲本身仍在 buffer 里，管理员可查近 2 小时（这里 splice 已经从 buffer 拿走了——
  // 实际实现里应该用"未上报区"+"已上报但保留区"两个 slice，或者上报后回填到只读区。
  // 简单一点：保持 buffer 不动，记一个 "uploadedUpTo" 指针）
  postSrv("audit.log", { logs: batch }).catch(err => console.warn("audit.log post failed", err));
}, 30 * 20);
```

简化版（不区分"已上报区"）：

```ts
const buffer: AuditLogEntry[] = [];
const BUFFER_MAX = 500;
let uploadedUpTo = 0;  // buffer 中 <uploadedUpTo 的都已上报

function bufferAuditLog(entry: AuditLogEntry) {
  buffer.push(entry);
  // 超容量时丢老的，注意调整指针
  if (buffer.length > BUFFER_MAX) {
    const drop = buffer.length - BUFFER_MAX;
    buffer.splice(0, drop);
    uploadedUpTo = Math.max(0, uploadedUpTo - drop);
  }
}

system.runInterval(() => {
  if (uploadedUpTo >= buffer.length) return;
  const batch = buffer.slice(uploadedUpTo);
  if (batch.length === 0) return;
  const sentCount = batch.length;
  postSrv("audit.log", { logs: batch })
    .then(resp => {
      if (resp.status === 200) uploadedUpTo += sentCount;
      // 失败不动指针，下次重试
    })
    .catch(() => { /* 同上 */ });
}, 30 * 20);
```

---

## 8. stats 字段累加来源（与计划书第 10.3 schema 的对应）

| 字段 | 来源事件 | 备注 |
|---|---|---|
| `first_join_at` | `playerSpawn` initialSpawn 时如果 stats 不存在则写入 `Date.now()` | |
| `last_seen_at` | `playerSpawn` initialSpawn 和 `playerLeave` 时更新 | playerLeave 时间最准 |
| `play_time` | `system.runInterval` 每 60 秒给在线玩家 +60s | 单位秒 |
| `distance_walked` / `distance_sprinted` / `distance_flown` | **无原生事件**，需要每 N tick 比 `player.location` 和上一次的差 | 复杂，**MVP 可以先不上**或者只做 distance_total 合并字段 |
| `mob_kills_total` | `entityDie` 中 killer 是玩家、victim 不是玩家 | §7.3 |
| `pvp_kills` | `entityDie` 中 killer 和 victim 都是玩家 | §7.3 |
| `deaths` | `entityDie` 中 victim 是玩家 | §7.3 |
| `damage_dealt` / `damage_taken` | `entityHurt` after 事件 | `e.hurtEntity` 是受伤者，`e.damageSource.damagingEntity` 是攻击者，`e.damage` 是数值 |
| `blocks_broken_total` | `playerBreakBlock` after | §7.4 |
| `blocks_placed_total` | `playerPlaceBlock` after | §7.4 |
| `valuable_broken` | `playerBreakBlock` after + 方块 ID 在白名单 | §7.4 |
| `chests_opened` | `playerInteractWithBlock` after + 容器白名单 | §7.1 |
| `items_crafted_total` | `playerInteractWithBlock` 对工作台/熔炉/砂轮等 | Bedrock 无 `itemCraft` 事件，**只能近似**（玩家右键工作台计一次）。要精确得监听玩家背包变化（`playerInventoryItemChange`），成本高，**MVP 跳过**或粗略统计 |
| `enchants_applied` | 无直接事件，**MVP 跳过** | |

**结论**：上面有 ✓ 的字段是 MVP 写得出来的；移动/合成/附魔三类先放空。计划书第 10.3 节说"约 30-50 个聚合指标"，先把能拿到的 ~15 个做出来即可，schema 留扩展位（解析时不报错即可加字段）。

### 8.1 内存累加 + flush 的完整骨架

```ts
type Stats = {
  first_join_at?: number;
  last_seen_at?:  number;
  play_time?:     number;
  mob_kills_total?: number;
  pvp_kills?:     number;
  deaths?:        number;
  damage_dealt?:  number;
  damage_taken?:  number;
  blocks_broken_total?: number;
  blocks_placed_total?: number;
  valuable_broken?: number;
  chests_opened?:   number;
};

// 内存层：缓存玩家 stats，避免每次累加都解析 dynamic property
const cache = new Map<string, Stats>();        // gamename → stats
const dirty = new Set<string>();               // 哪些 gamename 自上次 flush 后改过

function load(name: string): Stats {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = world.getDynamicProperty(`stats:${name}`);
  const s: Stats = typeof raw === "string" ? JSON.parse(raw) : {};
  cache.set(name, s);
  return s;
}

function incrStats(name: string, field: keyof Stats, delta: number) {
  const s = load(name);
  s[field] = ((s[field] as number) ?? 0) + delta;
  dirty.add(name);
}

function flushOne(name: string) {
  const s = cache.get(name);
  if (!s) return;
  world.setDynamicProperty(`stats:${name}`, JSON.stringify(s));
  dirty.delete(name);
}

function flushAll() {
  for (const name of dirty) flushOne(name);
}

// 每 60 秒批量 flush
system.runInterval(() => flushAll(), 60 * 20);

// 玩家离开立即 flush 该玩家
world.afterEvents.playerLeave.subscribe(({ playerName }) => {
  const s = load(playerName);
  s.last_seen_at = Date.now();
  dirty.add(playerName);
  flushOne(playerName);
  cache.delete(playerName);  // 离线玩家不留内存
});

// 每秒给所有在线玩家累加 play_time
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    incrStats(p.name, "play_time", 1);
  }
}, 20);
```

### 8.2 老玩家清理（计划书要求每周一次）

```ts
function* cleanupOldStats() {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith("stats:")) continue;
    const raw = world.getDynamicProperty(key);
    if (typeof raw !== "string") continue;
    try {
      const s = JSON.parse(raw);
      if ((s.last_seen_at ?? 0) < cutoff) {
        world.setDynamicProperty(key, undefined);  // 删除
        cache.delete(key.slice(6));
      }
    } catch {
      world.setDynamicProperty(key, undefined);    // 坏数据也删
    }
    yield;
  }
}

// 每 7 天跑一次（用 currentTick 判断，重启后从 0 开始也无所谓）
const TICKS_PER_WEEK = 7 * 24 * 3600 * 20;
system.runInterval(() => system.runJob(cleanupOldStats()), TICKS_PER_WEEK);
```

---

## 9. 平台 → Addon 下行 command 派发

收到 `/api/srv/poll` 返回的事件后，按 `command` 字段路由：

```ts
async function dispatchEvent(event: { id: string; command: string; data: any }) {
  switch (event.command) {
    case "player.kick":
      handleKick(event.data);  // 计划书表里写"否（不需 reply）"
      break;
    case "player.notify":
      handleNotify(event.data);
      break;
    case "player.whitelist.add":
      // 计划书表里写"是 { added: bool }"
      const added = await handleWhitelistAdd(event.data);
      await replyEvent(event.id, true, { added });
      break;
    case "player.whitelist.remove":
      const removed = await handleWhitelistRemove(event.data);
      await replyEvent(event.id, true, { removed });
      break;
    case "player.stats.fetch":
      const stats = handleStatsFetch(event.data);  // 直接读 dynamic property
      await replyEvent(event.id, true, { stats });
      break;
    case "server.broadcast":
      world.sendMessage(event.data.message);
      break;
    default:
      console.warn("unknown command", event.command);
  }
}

async function replyEvent(id: string, ok: boolean, data?: any, code?: string) {
  await postSrv("../reply", { id, ok, data, error: ok ? undefined : { code } });
  // 实际路径是 /api/srv/reply?token=...，调一下 postSrv 重写
}
```

### 9.1 几个具体命令的实现

**`player.kick`**：

Bedrock Script API **不能直接 kick 玩家**。变通：用 `world.getDimension().runCommand("kick <name> <reason>")`，但 `runCommand` 是 v1 同步、v2 仍可用的 vanilla 命令通道。

```ts
function handleKick(data: { name: string; reason: string }) {
  const reason = (data.reason ?? "").replace(/"/g, "");
  world.getDimension("overworld").runCommand(`kick "${data.name}" ${reason}`);
}
```

**`player.whitelist.add` / `remove`**：

Bedrock 的白名单文件叫 `allowlist.json`，**Script API 没有读写它的 API**。变通同上，跑 vanilla 命令：

```ts
async function handleWhitelistAdd(data: { name: string }): Promise<boolean> {
  try {
    world.getDimension("overworld").runCommand(`allowlist add "${data.name}"`);
    return true;
  } catch {
    return false;
  }
}
```

**坑**：`runCommand` 实际是异步执行的（v2 移除了 `runCommandAsync` 因为它"没真的异步"），命令是否成功是从命令文本的输出里判断的，比较粗糙。MVP 阶段先认为"调了就算成功"，回 `{ added: true }`。

**`player.stats.fetch`**：

```ts
function handleStatsFetch(data: { name: string }) {
  const s = load(data.name);  // 复用 §8.1 的 load
  return s;
}
```

注意 reply 要快，3 秒内（core 那边超时 3s）。从 dynamic property 读一条 + JSON.parse 是亚毫秒级，没问题。

---

## 10. 完整调用链对照表

把计划书第 4.5 节的接口表，重新按"Addon 侧用什么 API 实现"梳理一遍：

### 10.1 下行 command（`/poll` 收到的）

| command | Addon 侧实现 | 需要 reply | 关键 API |
|---|---|---|---|
| `player.kick` | `dimension.runCommand("kick <name> <reason>")` | 否 | runCommand |
| `player.notify` | 找到 player → `player.sendMessage(msg)` | 否 | `world.getAllPlayers()` + `Player.sendMessage` |
| `player.whitelist.add` | `dimension.runCommand("allowlist add <name>")` | 是 | runCommand |
| `player.whitelist.remove` | `dimension.runCommand("allowlist remove <name>")` | 是 | runCommand |
| `player.stats.fetch` | `world.getDynamicProperty("stats:<name>")` → JSON.parse | 是 | Dynamic Property |
| `server.broadcast` | `world.sendMessage(msg)` | 否 | `World.sendMessage` |

### 10.2 上行 action（Addon 主动 POST 的）

| 路径 | Addon 触发点 | 数据源 |
|---|---|---|
| `POST /api/srv/heartbeat` | `system.runInterval` 每 30 秒 | `world.getAllPlayers()` |
| `POST /api/srv/player.joined` | `world.afterEvents.playerSpawn`（`initialSpawn === true`） | `event.player.name` |
| `POST /api/srv/player.left` | `world.afterEvents.playerLeave` | `event.playerName` |
| `POST /api/srv/binding.request` | 自定义命令 `/platform:bind <code>` 回调 | `origin.sourceEntity.name` + 参数 `code` |
| `POST /api/srv/leaderboard.update` | `system.runInterval` 每小时（用 `runJob` 切片） | 扫 dynamic property `stats:*` |
| `POST /api/srv/audit.log` | `system.runInterval` 每 30 秒 | 内存 buffer |
| `GET /api/srv/config` | `world.afterEvents.worldLoad` 启动时一次 | 无（拉数据） |

### 10.3 事件订阅总览

每个事件最多订阅一次，分发到下游 handler（参考计划书 15.3 节"observation/events.ts 单一订阅源"）：

```ts
import { Player, world, system } from "@minecraft/server";

// 玩家加入
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) {
    onJoin(player);    // → stats.first_join_at, last_seen_at; HTTP player.joined
  } else {
    onRespawn(player); // 计划书没要求
  }
});

// 玩家离开
world.afterEvents.playerLeave.subscribe(({ playerName }) => {
  onLeave(playerName); // → stats flush + last_seen_at; HTTP player.left
});

// 方块破坏
world.afterEvents.playerBreakBlock.subscribe((e) => {
  onBlockBreak(e);     // → stats.blocks_broken_total / valuable_broken; audit log
});

// 方块放置
world.afterEvents.playerPlaceBlock.subscribe((e) => {
  onBlockPlace(e);     // → stats.blocks_placed_total; audit log
});

// 容器交互
world.afterEvents.playerInteractWithBlock.subscribe((e) => {
  onInteract(e);       // → stats.chests_opened; audit log
});

// 实体死亡
world.afterEvents.entityDie.subscribe((e) => {
  onEntityDie(e);      // → stats.deaths / pvp_kills / mob_kills_total; audit log
});

// 实体受伤
world.afterEvents.entityHurt.subscribe((e) => {
  onEntityHurt(e);     // → stats.damage_dealt / damage_taken
});

// 每秒 tick
system.runInterval(() => {
  for (const p of world.getAllPlayers()) incrStats(p.name, "play_time", 1);
}, 20);

// 每 30 秒心跳
system.runInterval(() => sendHeartbeat(), 30 * 20);

// 每 60 秒 flush stats
system.runInterval(() => flushAll(), 60 * 20);

// 每 30 秒 flush audit
system.runInterval(() => flushAuditBuffer(), 30 * 20);

// 每小时排行
system.runInterval(() => system.runJob(rebuildLeaderboard()), 3600 * 20);

// 每周清理
system.runInterval(() => system.runJob(cleanupOldStats()), 7 * 24 * 3600 * 20);
```

---

## 11. TypeScript 项目结构

```
bedrock-addon/
├── manifest.json
├── package.json
├── tsconfig.json
└── scripts/
    ├── main.ts                  // entry，按 §10.3 顶层订阅
    ├── config.ts                // BASE_URL / TOKEN 从 variables 读
    ├── transport/
    │   ├── http.ts              // postSrv / replyEvent
    │   └── poll.ts              // pollLoop
    ├── commands/
    │   └── bind.ts              // /platform:bind 自定义命令注册 + 失败次数限流
    ├── observation/
    │   ├── events.ts            // 单一订阅源，分发
    │   ├── join_leave.ts
    │   ├── block.ts
    │   ├── death.ts
    │   ├── interact.ts
    │   └── hurt.ts
    ├── storage/
    │   ├── stats.ts             // load/incrStats/flushAll
    │   ├── audit.ts             // buffer + flush
    │   └── cleanup.ts           // 每周清理
    ├── handlers/                // 下行 command 处理
    │   ├── kick.ts
    │   ├── notify.ts
    │   ├── whitelist.ts
    │   ├── stats_fetch.ts
    │   └── broadcast.ts
    └── rank/
        └── leaderboard.ts       // 每小时全量重建
```

`package.json` 安装 `@minecraft/server` 等 npm 包做类型定义：

```bash
npm i -D @minecraft/server@2.0.0 @minecraft/server-net@1.0.0-beta @minecraft/server-admin@1.0.0-beta typescript
```

`tsconfig.json` target ES2020 即可，输出到 `dist/scripts/`，部署时把 `dist/scripts/` 拷到 behavior pack 的 `scripts/` 目录（路径要和 manifest 的 `entry` 对得上）。

---

## 12. 常见踩坑清单（写代码前最后看一眼）

1. **顶层不能访问 world state**——所有"用到玩家、方块、维度"的初始化挪进 `world.afterEvents.worldLoad`。
2. **`beforeEvents` 回调里不能写 state**——要写就 `system.run(() => ...)` 延后。
3. **`playerBreakBlock` after 事件里 `e.block.typeId` 是 air**——原方块用 `e.brokenBlockPermutation.type.id`。
4. **`playerSpawn` 死亡复活也会触发**——用 `initialSpawn` 过滤。
5. **`playerLeave` 没有 `player` 对象**——只有 `playerId` + `playerName`，离线玩家方法都调不了。
6. **Dynamic Property 不能直接存对象**——`JSON.stringify` 成 string，单值 < 32KB。
7. **`getDynamicPropertyIds()` 是同步全量返回**——大量数据扫描套 `system.runJob` 切片避免 watchdog。
8. **HTTP 请求不要在事件回调里 `await`**——发出去就走，结果用 `.then()` 异步处理。
9. **自定义命令必须在 `system.beforeEvents.startup` 注册**，且回调跑在 restricted 模式，副作用要 `system.run`。
10. **`/bind <code>` 实际玩家要输 `/platform:bind <code>`**——除非起一个不带 namespace 的别名（不行，namespace 强制）。在 `/docs` 里说清楚或者引导玩家用自动补全。
11. **`runCommandAsync` 在 v2 移除**——用同步 `runCommand`。
12. **Bedrock 颜色码只能用 `§` + 16 色 + Minecoin Gold（`§g`）**——没有 hex 颜色。
13. **`Player.id` 每次进服变**——用 `Player.name` 当身份键。
14. **整个 Addon 没法在 BDS 内监听端口/起 HTTP server**——通信只能 Addon 当 client 主动连出。

---

## 13. 未在 v1 范围内、但要早点想清楚的事

- **Bedrock 改名**：Xbox 用户可以改 gamertag。计划书第 9 章"改名 = 新身份"接受这个代价，但实际触发时 `playerSpawn` 不会告诉你"这其实是改名后的同一个 XUID"，旧 `stats:旧名` 数据会留在 dynamic property 直到 90 天清理。**不要在 v1 想办法迁移**，下一版再考虑（届时可以从 BDS 控制台日志抓 XUID 做双键索引）。
- **离线玩家 stats 写入**：当前设计是"在线玩家的累加事件 → flush 到 dynamic property"，离线玩家不能写。`player.notify` 给离线玩家发是直接丢弃。如果以后要"补送"通知，需要在 Addon 内做"离线消息队列" dynamic property，加入时 `playerSpawn` 取出来发。
- **领地**：v1 不做，但 audit log 字段 `target` 已经预留位置（破坏/放置带 pos），将来领地系统能复用同样的事件订阅源——只需要在 `block` handler 加一段"R 树查询 → 非领主则 cancel"逻辑。
