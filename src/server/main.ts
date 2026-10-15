import { createServer } from "node:http";
import { loadConfig } from "../config.js";
import { createStorybookServer } from "./app.js";

/**
 * Entry point of the container deployed to FAL Serverless (see pyproject.toml):
 * listens on 0.0.0.0:$PORT, which FAL exposes through `exposed_port`.
 */
async function main() {
    const config = loadConfig();
    let pricing;
    if (process.env.STORYBOOK_PRICING) pricing = JSON.parse(process.env.STORYBOOK_PRICING) as Record<string, number>;
    const app = createStorybookServer({ config, pricing });
    await app.init();
    const stopPolling = app.startPolling();

    const server = createServer((req, res) => void app.handler(req, res));
    server.listen(config.port, "0.0.0.0", () => {
        console.log(`imgen-storybook listening on :${config.port} (FAL key ${config.falKey ? "configured" : "MISSING — set FAL_KEY"})`);
    });

    const shutdown = () => {
        stopPolling();
        server.close(() => void app.close().finally(() => process.exit(0)));
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
