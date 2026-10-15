import { describe, expect, it } from "vitest";
import { ConfigError, FAL_KEY_PLACEHOLDER, createFalImageProvider, isPlaceholder, loadConfig } from "../src/index.js";

describe("config", () => {
    it("treats placeholders as missing", () => {
        expect(isPlaceholder(FAL_KEY_PLACEHOLDER)).toBe(true);
        expect(isPlaceholder("__SET_YOUR_API_TOKEN__")).toBe(true);
        expect(isPlaceholder("")).toBe(true);
        expect(isPlaceholder("abc123:def456")).toBe(false);

        const cfg = loadConfig({ FAL_KEY: FAL_KEY_PLACEHOLDER, STORYBOOK_API_TOKEN: "__SET_YOUR_API_TOKEN__", PORT: "9000", STORYBOOK_MAX_RENDERS_PER_DAY: "50" });
        expect(cfg).toMatchObject({ falKey: undefined, apiToken: undefined, port: 9000, maxRendersPerDay: 50, dataDir: "/data/storybook", webhooksEnabled: false });
        expect(loadConfig({ FALAI_API_KEY: "k" }).falKey).toBe("k");
        expect(loadConfig({ STORYBOOK_WEBHOOKS: "1", STORYBOOK_PUBLIC_URL: "https://x.example/" })).toMatchObject({ webhooksEnabled: true, publicBaseUrl: "https://x.example" });
    });

    it("fails loudly when FAL is used without a real key", async () => {
        const saved = { FAL_KEY: process.env.FAL_KEY, FALAI_API_KEY: process.env.FALAI_API_KEY };
        process.env.FAL_KEY = FAL_KEY_PLACEHOLDER;
        delete process.env.FALAI_API_KEY;
        try {
            const provider = createFalImageProvider();
            await expect(provider.uploadImage!(Buffer.from([1]), "image/png")).rejects.toBeInstanceOf(ConfigError);
            await expect(provider.uploadImage!(Buffer.from([1]), "image/png")).rejects.toThrow(/fal secrets set FAL_KEY/);
        } finally {
            Object.assign(process.env, saved);
            if (saved.FAL_KEY === undefined) delete process.env.FAL_KEY;
            if (saved.FALAI_API_KEY === undefined) delete process.env.FALAI_API_KEY;
        }
    });
});
