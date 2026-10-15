import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, createMockImageProvider, loadConfig, type StorageAdapter } from "../src/index.js";
import { createStorybookServer } from "../src/server/app.js";
import { png } from "./helpers.js";

let server: Server;
let base: string;
const storages = new Map<string, StorageAdapter>();
const provider = createMockImageProvider();

beforeAll(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = loadConfig({ STORYBOOK_API_TOKEN: "s3cret", STORYBOOK_PUBLIC_URL: base, STORYBOOK_WEBHOOKS: "1", STORYBOOK_POLL_INTERVAL_MS: "0" });
    const app = createStorybookServer({
        config,
        provider,
        storageFor: (tenant) => {
            if (!storages.has(tenant)) storages.set(tenant, createMemoryStorage());
            return storages.get(tenant)!;
        },
    });
    await app.init();
    server.on("request", (req, res) => void app.handler(req, res));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function gql(query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = { "x-storybook-token": "s3cret" }) {
    const res = await fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query, variables }) });
    return { status: res.status, body: (await res.json()) as any };
}

describe("HTTP server", () => {
    it("reports health without auth", async () => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, provider: "mock" });
    });

    it("requires the API token for GraphQL", async () => {
        expect((await gql(`{ stories { items { id } } }`, {}, {})).status).toBe(401);
        expect((await gql(`{ stories { items { id } } }`, {}, { "x-storybook-token": "wrong" })).status).toBe(401);
        expect((await gql(`{ stories { items { id } } }`)).status).toBe(200);
    });

    it("isolates tenants", async () => {
        await gql(`mutation { createStory(input: { id: "book", name: "A" }) { id } }`, {}, { "x-storybook-token": "s3cret", "x-storybook-tenant": "alice" });
        const bob = await gql(`{ story(id: "book") { id } }`, {}, { "x-storybook-token": "s3cret", "x-storybook-tenant": "bob" });
        expect(bob.body.data.story).toBeNull();
        expect((await gql(`{ stories { items { id } } }`, {}, { "x-storybook-token": "s3cret", "x-storybook-tenant": "../x" })).status).toBe(400);
    });

    it("serves signed image links and accepts authenticated webhooks", async () => {
        await gql(`mutation { createCharacter(input: { id: "ala", name: "Ala" }) { id } }`);
        const ref = await gql(`mutation($i: String!) { addReferenceImage(input: { kind: CHARACTER, entityId: "ala", image: { base64: $i } }) { image { url } } }`, {
            i: (await png()).toString("base64"),
        });
        const url: string = ref.body.data.addReferenceImage.image.url;
        expect(url).toMatch(/\/blobs\/default\/references\/character\/ala\/.+\.png\?exp=\d+&sig=/);
        const img = await fetch(url);
        expect(img.status).toBe(200);
        expect(img.headers.get("content-type")).toBe("image/png");
        expect((await fetch(url.replace(/sig=.+$/, "sig=forged"))).status).toBe(403);

        await gql(`mutation { createScene(input: { id: "s1", name: "S", cast: [{ characterId: "ala" }] }) { id } }`);
        const queued = await gql(`mutation { renderScene(sceneId: "s1") { id status } }`);
        const renderId = queued.body.data.renderScene[0].id;
        const hookUrl = provider.jobs.at(-1)!.webhookUrl!;
        expect(hookUrl).toContain(`/webhooks/fal/default/${renderId}?token=`);

        expect((await fetch(hookUrl.replace(/token=.+$/, "token=forged"), { method: "POST", body: "{}" })).status).toBe(404);
        const hook = await fetch(hookUrl, { method: "POST", body: JSON.stringify({ status: "OK" }) });
        expect(await hook.json()).toEqual({ ok: true, status: "succeeded" });
    });
});
