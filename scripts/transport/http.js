import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";
import { BASE_URL, TOKEN, POST_TIMEOUT_SEC } from "../config.js";

function buildUrl(action) {
  const sep = action.includes("?") ? "&" : "?";
  return `${BASE_URL}/api/srv/${action}${sep}token=${encodeURIComponent(TOKEN)}`;
}

export function postSrv(action, body) {
  const req = new HttpRequest(buildUrl(action));
  req.method  = HttpRequestMethod.Post;
  req.body    = JSON.stringify(body ?? {});
  req.headers = [new HttpHeader("Content-Type", "application/json")];
  req.timeout = POST_TIMEOUT_SEC;
  return http.request(req);
}

export function getSrv(action) {
  const req = new HttpRequest(buildUrl(action));
  req.method  = HttpRequestMethod.Get;
  req.timeout = POST_TIMEOUT_SEC;
  return http.request(req);
}

export function replyEvent(id, ok, data, errorCode) {
  const body = ok
    ? { id, ok: true, data: data ?? null }
    : { id, ok: false, error: { code: errorCode || "ERROR" } };
  return postSrv("reply", body);
}
