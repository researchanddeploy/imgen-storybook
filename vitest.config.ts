import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        // Process @graphql-tools through Vite so it shares the test's copy of `graphql`.
        server: { deps: { inline: [/@graphql-tools/] } },
    },
});
