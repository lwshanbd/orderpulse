import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SecretBox } from "./crypto.js";
import { OrderPulseDatabase } from "./database.js";
import { TeslaClient } from "./tesla.js";
import { TeslaTokenService } from "./token-service.js";

const config = loadConfig();
const database = new OrderPulseDatabase(config.databasePath, new SecretBox(config.tokenEncryptionKey));
const tesla = new TeslaClient(config);
const tokenService = new TeslaTokenService(database, tesla);
const app = createApp({ config, database, tesla, tokenService });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  try {
    await app.close();
    database.close();
    process.stdout.write(`OrderPulse stopped after ${signal}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`OrderPulse shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`OrderPulse listening on ${config.host}:${config.port}\n`);
} catch (error) {
  database.close();
  process.stderr.write(`OrderPulse failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
