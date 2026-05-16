import { system } from "@minecraft/server";
import { http, HttpRequest, HttpRequestMethod } from "@minecraft/server-net";
import { BASE_URL, TOKEN, POLL_TIMEOUT_SEC } from "../config.js";

let running = false;
let dispatchFn = null;

function sleep(ticks) {
  return new Promise(r => system.runTimeout(() => r(), ticks));
}

async function pollOnce() {
  const req = new HttpRequest(`${BASE_URL}/api/srv/poll?token=${encodeURIComponent(TOKEN)}`);
  req.method  = HttpRequestMethod.Get;
  req.timeout = POLL_TIMEOUT_SEC;
  return http.request(req);
}

async function loop() {
  while (running) {
    try {
      const resp = await pollOnce();
      if (resp.status === 204) continue;
      if (resp.status === 200) {
        let event = null;
        try { event = JSON.parse(resp.body); } catch (e) {
          console.warn("[poll] bad json", e);
          await sleep(20);
          continue;
        }
        if (event && dispatchFn) {
          Promise.resolve()
            .then(() => dispatchFn(event))
            .catch(err => console.warn("[poll] dispatch error", err));
        }
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        console.warn("[poll] token rejected, stopping");
        running = false;
        break;
      }
      await sleep(20);
    } catch (err) {
      console.warn("[poll] error", err);
      await sleep(60);
    }
  }
}

export function startPoll(dispatcher) {
  if (running) return;
  running = true;
  dispatchFn = dispatcher;
  loop();
}

export function stopPoll() {
  running = false;
}
