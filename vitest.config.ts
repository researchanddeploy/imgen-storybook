import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        // Process GraphQL libraries through Vite so it shares the test's copy of `graphql`.
        server: { deps: { inline: [/@graphql-tools/, /graphql-yoga/, /@envelop/, /@graphql-yoga/] } },
    },
});
