/**
 * Local development server — the same HTTP app that runs on FAL Serverless.
 *
 *   npm run dev                       # FAL when FAL_KEY is set (not the placeholder), otherwise mock images
 *   curl localhost:8080/health
 *   POST http://localhost:8080/graphql  (header x-storybook-token if STORYBOOK_API_TOKEN is set)
 *
 * Data lives in ./story-data (override with STORYBOOK_DATA_DIR).
 */
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { createMockImageProvider } from "../src/providers/mock.js";
import { createStorybookServer } from "../src/server/app.js";

const config = loadConfig({
    STORYBOOK_DATA_DIR: "./story-data",
    STORYBOOK_PUBLIC_URL: `http://localhost:${process.env.PORT ?? 8080}`,
    ...process.env,
});
const app = createStorybookServer({
    config,
    ...(config.falKey ? {} : { provider: createMockImageProvider({ checksUntilDone: 2 }) }),
});

await app.init();
app.startPolling();
createServer((req, res) => void app.handler(req, res)).listen(config.port, () => {
    console.log(`http://localhost:${config.port}/graphql  (images: ${config.falKey ? "FAL" : "mock — set FAL_KEY for real generation"})`);
});
