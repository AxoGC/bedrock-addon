import { metricsPayload } from "../stats/axes.js";

// `metrics.list` (reply): plugin-defined axis metadata. core caches the
// response for ~1h; see PLAN §10.6.
export function handleMetricsList() {
  return { metrics: metricsPayload() };
}
