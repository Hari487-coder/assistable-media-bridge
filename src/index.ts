import { loadConfig } from "./config";
import { runWakerCycle, startWaker } from "./core/waker";
import { buildApp } from "./http/app";

const config = loadConfig();
const { app, wireDeps } = buildApp(config);

app.listen(config.port, () => {
  console.log(`media-mcp listening on :${config.port} (mock=${config.mock})`);
});

const intervalMs = Number(process.env.WAKER_INTERVAL_MS ?? 25_000);
startWaker(
  (t) => runWakerCycle(wireDeps.wakerDepsFor(t), t),
  () => wireDeps.tenants.list(),
  intervalMs
);
setInterval(() => wireDeps.processed.prune(7 * 24 * 60 * 60 * 1000), 60 * 60 * 1000).unref();
