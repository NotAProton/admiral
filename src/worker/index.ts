import "dotenv/config";
import { AdmiralEngine } from "./engine.js";
import { startInternalApi } from "./internalApi.js";

const configPath = process.env.SCHEDULE_CONFIG_PATH ?? "config/schedule.json";
const tickIntervalMs = Number(process.env.ENGINE_TICK_MS ?? 5_000);
const internalPort = Number(process.env.INTERNAL_API_PORT ?? 8787);

const engine = new AdmiralEngine(configPath, tickIntervalMs);
await engine.start();

const app = await startInternalApi(engine, internalPort);

const shutdown = async (): Promise<void> => {
  await app.close().catch(() => undefined);
  await engine.stop().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

console.log(`Admiral worker started on internal API port ${internalPort}`);
