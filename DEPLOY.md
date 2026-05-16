# Bedrock Addon 部署笔记

实测环境：BDS 1.26.21.1 (Build ID 44900522, branch r/26_u2)，`itzg/minecraft-bedrock-server` 容器，`network_mode: host`。

## 文件落点

| 仓库 | 部署路径（相对 BDS 根） | 备注 |
|---|---|---|
| `manifest.json` | `development_behavior_packs/platform-bridge/manifest.json` | development 目录免打包 |
| `scripts/**` | `development_behavior_packs/platform-bridge/scripts/**` | 同上 |
| — | `worlds/<level>/world_behavior_packs.json` | 激活 pack（用 manifest header UUID） |
| `permissions.json`（仓库示例） | **不要放 `config/<addon_uuid>/`，放 `config/default/`** | 见坑 2 |
| `tools/enable_beta_apis.py` | 一次性运行 | 见坑 1 |

## 必须做的 4 件事（按顺序）

### 1. 启用 Beta APIs experiment

`@minecraft/server-net` 仍标记 beta，所有 BDS 版本都需要 world 级 experiment。BDS 没有 GUI 可以勾选，必须直接改 `level.dat` NBT。

```bash
# 必须先停容器，避免 BDS 写回覆盖
docker compose stop bedrock

# venv（不污染宿主机）
python3 -m venv .venv
.venv/bin/pip install nbtlib --index-url https://pypi.tuna.tsinghua.edu.cn/simple

# 打补丁（自动备份 .bak）
.venv/bin/python3 tools/enable_beta_apis.py "/srv/bedrock/worlds/Bedrock level/level.dat"
```

启动后日志应出现 `Experiment(s) active: gtst`。

### 2. 把模块加到 default permissions

itzg 镜像默认 `config/default/permissions.json` 列了 `server`/`server-ui`/`server-admin`/`server-editor`/`server-gametest`，**没有 `server-net`**。1.26.21.1 实测 `config/<addon_uuid>/permissions.json` 不生效，只能加到 default：

```json
{
  "allowed_modules": [
    "@minecraft/server-gametest",
    "@minecraft/server",
    "@minecraft/server-ui",
    "@minecraft/server-admin",
    "@minecraft/server-editor",
    "@minecraft/server-net"
  ]
}
```

错配症状：`requesting dependency on module [@minecraft/server-net] but it is not configured to use it`。

### 3. 配置直接写代码

`@minecraft/server-admin` 的 `variables.json` 在 1.26.21.1 上同样不被 per-pack 路径读取（`variables.get(key)` 返回 `undefined`）。直接把 token/URL 硬编码到 `scripts/config.js`：

```js
export const BASE_URL = "https://www.axogc.net";
export const TOKEN    = "<server token>";
```

仓库版留 `REPLACE_WITH_*` 占位，部署副本注入真值。`manifest.json` 的 `dependencies` **不要带** `@minecraft/server-admin`。

### 4. 开脚本日志

默认 `console.warn` 不出 stdout：

```properties
# server.properties
content-log-console-output-enabled=true
```

否则启动错误（脚本崩、依赖缺）全部静默。

## 已知运行时缺口

- **`world.beforeEvents.chatSend` 在 `@minecraft/server` 2.0 stable 中被移除**，`world.afterEvents.chatSend` 也无。1.26 stable 下聊天上行（`POST /api/srv/chat.message`）暂时跑不起来，仅下行 `chat.from_web`（`world.sendMessage`）可用。要恢复双向聊天需把 `@minecraft/server` 依赖切到 beta 版本，并把 chatSend 订阅的 guard 改回硬调用。
- 部署版加了 guard：缺事件就打 `WARN [platform] world.*.chatSend unavailable in this Bedrock build; skip chat mirror`，其余功能不受影响。

## 改名/版本升级注意

- BDS 升级（同 1.26.x 内）通常无需重做 experiment 与 permissions；**跨大版本（1.26 → 1.27）**先确认 stable API 是否有破坏性变更。
- 若 itzg 镜像下次启动重写了 `level.dat`，experiment 标记会丢，需要重跑 `enable_beta_apis.py`。

## 验证

启动 30s 后看脚本日志：
```
[Scripting] [platform] bridge online
[Scripting] [platform] heartbeat ok (online=0)
```

外部确认（用任意公网终端）：
```bash
curl -s "https://www.axogc.net/api/servers" | jq '.data.items[] | select(.type=="mc-be")'
# .status 应为 "online"
```

`status: online` 说明 addon → core 的心跳成功刷新了 Redis TTL，整条 HTTP 链路通。
