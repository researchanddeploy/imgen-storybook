/**
 * Standalone GraphQL server for local development.
 *
 *   npm run example:server            # uses FAL when FAL_KEY is set, otherwise the mock provider
 *   open http://localhost:4000/graphql
 *
 * Data lives in ./story-data. Images are served at /blobs/<key>.
 */
import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { createStoryGraphQLSchema } from "../src/graphql/index.js";
import {
    createFalBackgroundRemover,
    createFalImageProvider,
    createFileSystemStorage,
    createMockImageProvider,
    createStoryEngine,
} from "../src/index.js";

const port = Number(process.env.PORT ?? 4000);
const hasFal = Boolean(process.env.FAL_KEY ?? process.env.FALAI_API_KEY);

const engine = createStoryEngine({
    storage: createFileSystemStorage({
        rootDir: process.env.STORY_DATA_DIR ?? "./story-data",
        publicBaseUrl: `http://localhost:${port}/blobs`,
    }),
    provider: hasFal ? createFalImageProvider({ onLog: (m) => console.log(`[fal] ${m}`) }) : createMockImageProvider(),
    backgroundRemover: hasFal ? createFalBackgroundRemover() : undefined,
    defaults: { aspectRatio: "4:3", resolution: "1K" },
});

const yoga = createYoga({ schema: createStoryGraphQLSchema({ engine }) });

const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/blobs/")) {
        const key = decodeURIComponent(req.url.slice("/blobs/".length).split("?")[0] ?? "");
        try {
            const blob = await engine.getBlob(key);
            if (!blob) throw new Error("not found");
            res.writeHead(200, { "Content-Type": blob.contentType, "Cache-Control": "public, max-age=31536000, immutable" });
            res.end(blob.data);
        } catch {
            res.writeHead(404).end();
        }
        return;
    }
    return yoga(req, res);
});

server.listen(port, () => {
    console.log(`GraphQL: http://localhost:${port}/graphql (provider: ${engine.provider.name})`);
});
