import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

try {
  await app.listen({
    port: config.apiPort,
    host: "0.0.0.0"
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
