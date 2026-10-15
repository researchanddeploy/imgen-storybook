import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileSystemStorage, createMockImageProvider, createStoryEngine } from "../src/index.js";
import { png } from "./helpers.js";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "imgen-fs-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("filesystem storage", () => {
    it("persists entities, references and renders across engine instances", async () => {
        const storage = createFileSystemStorage({ rootDir: dir, publicBaseUrl: "https://cdn.example.com/story/" });
        const engine = createStoryEngine({ storage, provider: createMockImageProvider() });
        const c = await engine.characters.create({ name: "Ala" });
        const ref = await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }] });
        await engine.renderScene(s.id);

        const again = createStoryEngine({ storage: createFileSystemStorage({ rootDir: dir }), provider: createMockImageProvider() });
        expect((await again.characters.require(c.id)).references[0]?.id).toBe(ref.id);
        expect((await again.getBlob(ref.blobKey))?.contentType).toBe("image/png");
        expect(await again.listRenders()).toHaveLength(1);
        expect(await engine.blobPublicUrl(ref.blobKey)).toBe(`https://cdn.example.com/story/${ref.blobKey}`);
    });

    it("sends public URLs to the provider only when referenceTransport is public-url", async () => {
        const storage = createFileSystemStorage({ rootDir: dir, publicBaseUrl: "https://cdn.example.com" });
        const provider = createMockImageProvider();
        const engine = createStoryEngine({ storage, provider, referenceTransport: "public-url" });
        const c = await engine.characters.create({ name: "Ala" });
        const ref = await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }] });
        await engine.renderScene(s.id);
        expect(provider.calls[0]?.references[0]?.url).toBe(`https://cdn.example.com/${ref.blobKey}`);

        const inline = createStoryEngine({ storage, provider: createMockImageProvider() });
        await inline.renderScene(s.id);
        expect((inline.provider as typeof provider).calls[0]?.references[0]?.url).toMatch(/^data:image\/png;base64,/);
    });

    it("refuses unsafe keys and ids", async () => {
        const storage = createFileSystemStorage({ rootDir: dir });
        await expect(storage.blobs.put("../escape.png", Buffer.from("x"), "image/png")).rejects.toThrow(/Unsafe/);
        await expect(storage.blobs.get("/etc/passwd")).rejects.toThrow(/Unsafe/);
        expect(await storage.records.get("character", "../x")).toBeNull();
        await expect(storage.records.put("character", { id: "../x" } as never)).rejects.toThrow();
    });
});
