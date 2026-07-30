import { loadConfig } from "./config";
import { runWakerCycle, startWaker } from "./core/waker";
import { buildApp } from "./http/app";

const config = loadConfig();
const { app, wireDeps } = buildApp(config);

app.listen(config.port, () => {
  console.log(`media-mcp listening on :${config.port} (mock=${config.mock})`);
});

startWaker(
  (t) => runWakerCycle(wireDeps.wakerDepsFor(t), t),
  () => wireDeps.tenants.list(),
  config.wakerIntervalMs,
  { concurrency: config.wakerConcurrency }
);
setInterval(() => wireDeps.processed.prune(7 * 24 * 60 * 60 * 1000), 60 * 60 * 1000).unref();
