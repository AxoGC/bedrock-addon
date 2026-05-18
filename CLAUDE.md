# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Bedrock Dedicated Server (BDS) behavior pack written in plain ES modules — **no build step, no TypeScript, no npm install for runtime**. The repo is literally the deployable artifact. Files under `scripts/` are loaded directly by BDS's QuickJS engine. `manifest.json` and `permissions.json` configure the addon. `tools/enable_beta_apis.py` is a one-shot deploy helper.

The addon's job is to bridge BDS ⇄ the platform `core` service (Go backend at `/root/core`, separate repo) over HTTPS, since BDS can only act as an HTTP **client**. All upstream/downstream traffic flows through `/api/srv/*` on core.

## Common commands

There is no compile/test toolchain here. The only commands are deployment-side, all documented in `DEPLOY.md`:

```bash
# One-time per BDS world: enable the Beta APIs experiment (required for server-net).
# Stop BDS first — it will overwrite level.dat on shutdown otherwise.
python3 -m venv .venv
.venv/bin/pip install nbtlib --index-url https://pypi.tuna.tsinghua.edu.cn/simple
.venv/bin/python3 tools/enable_beta_apis.py "/path/to/worlds/<level>/level.dat"

# Deploy: copy manifest.json + scripts/ into the BDS behavior pack dir, then restart BDS.
# (See DEPLOY.md "文件落点" table for exact target paths under the itzg image.)
```

To iterate on a script change: replace the file in `development_behavior_packs/platform-bridge/scripts/...` and restart BDS. There is no hot-reload.

To verify the bridge is up after restart, watch the BDS log for these lines (requires `content-log-console-output-enabled=true` in `server.properties`):

```
[Scripting] [platform] bridge online
[Scripting] [platform] heartbeat ok (online=0)
```

## Architecture

### Module layout and data flow

`scripts/main.js` is the entry point and the only place where wiring happens. Subdirectories are single-responsibility:

- **`transport/`** — HTTP I/O. `http.js` builds `postSrv(action, body)` and `replyEvent(id, ok, data)` against `${BASE_URL}/api/srv/<action>?token=<TOKEN>`. `poll.js` runs the long-poll loop that drives the downstream command channel.
- **`observation/events.js`** — the **single subscription point** for all `world.afterEvents.*`. It fans out to `storage/stats.js` (in-memory accumulators) and `chat/chat.js`, and emits upstream events like `player.joined` / `player.left` via `postSrv`. Do not subscribe to the same vanilla event in two places.
- **`storage/`** — `stats.js` holds the cache/dirty-set + Dynamic Property persistence; `cleanup.js` is the weekly sweep of stale `stats:*` keys. Stats are stored as JSON strings on **world-scope** Dynamic Property under key `stats:<playerName>` so offline players are still scannable for leaderboards.
- **`commands/bind.js`** — registers the `/axo:bind <code>` custom command. Must register in `system.beforeEvents.startup`; the callback runs in restricted mode so all side effects defer to `system.run`. Failure lockout (3 fails → 10 min) is in-memory only.
- **`rank/leaderboard.js`** — hourly full-scan rebuilds using `system.runJob` (generator) to avoid the watchdog.
- **`handlers/`** — downstream command handlers, one file per `command` value. `dispatch.js` is the switch: commands that need a reply (`player.whitelist.add/remove`, `player.stats.fetch`) call `replyEvent(id, ok, data)`; fire-and-forget commands (`player.notify`, `server.broadcast`, `player.kick`, `chat.from_web`) don't. **Adding a new downstream command means: add a handler file, then a case in `dispatch.js`.**
- **`chat/chat.js`** — upstream `chat.message` filter (drops slash commands, deduplicates `chat.from_web` loopback within a 5s window).
- **`config.js`** — runtime constants. **`BASE_URL` and `TOKEN` are hardcoded here**, not loaded via `@minecraft/server-admin`'s `variables.json` (that path was unreliable in BDS 1.26.21.1 — see `DEPLOY.md` §3). The repo keeps `REPLACE_WITH_*` placeholders; the deployed copy gets real values injected. `manifest.json` therefore **does not depend on `@minecraft/server-admin`** even though `permissions.json` still allows it.

### Execution-model rules (load-bearing — get these wrong and BDS rejects the script)

`BEDROCK.md` is the canonical reference; the highlights you cannot violate:

1. **Top-level code is in "early execution" mode** — must not touch world state. `main.js` only does early-execution-safe work at file scope: `registerBindCommand()` (which itself subscribes to `system.beforeEvents.startup`) and `registerEventSubscriptions()` (which only subscribes, doesn't read state). Everything that touches `world.getAllPlayers()`, dynamic properties, or starts intervals lives inside `world.afterEvents.worldLoad.subscribe(...)`.
2. **`beforeEvents` callbacks (incl. custom command callbacks) run in restricted mode** — wrap any state mutation in `system.run(() => ...)`. See `commands/bind.js` for the pattern.
3. **`playerBreakBlock.after`: `e.block.typeId` is already `minecraft:air`** — use `e.brokenBlockPermutation.type.id` for the original block (see `observation/events.js`).
4. **`playerLeave` has no `Player` object** — only `playerId` + `playerName`. Flush stats synchronously inside that handler before the cache eviction.
5. **No `await` in event callbacks** for HTTP — fire `.then()/.catch()` and return. The BDS script watchdog kills the world at 10s/tick.
6. **Long-running scans** (`getDynamicPropertyIds()` over hundreds of keys) must be generators driven by `system.runJob` — see `rank/leaderboard.js` and `storage/cleanup.js`.

### Long-poll contract with core

`transport/poll.js` holds an HTTP GET on `/api/srv/poll` with `req.timeout = POLL_TIMEOUT_SEC` (default **35s**). The core side holds the BLPop for `PLATFORM_POLL_TIMEOUT` (currently 20s on the server) and returns 204 when no event arrives. The client timeout **must stay comfortably larger than** the server hold window; otherwise BDS's HTTP client throws `InternalHttpRequestError 0x80004005` every cycle. If you see that error flooding, the root cause is almost always this margin shrinking (BDS internal cap near 30s, or a reverse proxy with a shorter idle timeout). Fix it server-side, not by suppressing the log.

Status codes the poll loop expects from core:
- `204` → no event, immediately re-poll
- `200` → JSON event `{ id, command, data }`, dispatch and re-poll (do not await dispatch)
- `401/403` → token rejected, stop the loop

### Permissions / BDS host config (not in this repo, but easy to break)

- `@minecraft/server-net` must appear in **`config/default/permissions.json`** on the BDS host. Per-addon `config/<addon_uuid>/permissions.json` was empirically ignored on BDS 1.26.21.1.
- The Beta APIs experiment must be enabled on the world (the `tools/enable_beta_apis.py` script does this by patching `level.dat`).
- Without `content-log-console-output-enabled=true` in `server.properties`, all `console.warn` output is silent and addon errors disappear.

## Known runtime gap

`@minecraft/server` 2.0 stable removed `world.beforeEvents.chatSend` and there is no `afterEvents.chatSend` either. Upstream `chat.message` is currently dead on 1.26 stable; only the downstream `chat.from_web` path (which calls `world.sendMessage`) works. Restoring two-way chat requires switching `@minecraft/server` to a beta version in `manifest.json` and re-enabling the chatSend subscribe path. See `DEPLOY.md` "已知运行时缺口".

## Reference docs

- `BEDROCK.md` — exhaustive Script API research (event sources, stats field provenance, gotchas, full call-graph against the platform API). Read this when adding events or commands.
- `DEPLOY.md` — deploy mechanics, file paths under the itzg image, permissions, the `level.dat` patch, and the chat-API gap.
