import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
    ConflictError,
    InUseError,
    LimitExceededError,
    NotFoundError,
    ValidationError,
    VersionConflictError,
    type ImageReviewer,
} from "../src/index.js";
import { png, settle, setup } from "./helpers.js";

describe("entities", () => {
    it("creates, updates with merge/null semantics, versions and paginates", async () => {
        const { engine } = setup();
        const c = await engine.characters.create({ id: "ala", name: "Ala", tags: ["hero"], appearance: { hair: "red", eyes: "green" }, outfit: "coat" });
        expect(c).toMatchObject({ id: "ala", kind: "character", version: 1, description: "", references: [], defaultAccessoryIds: [] });

        const u = await engine.characters.update("ala", { appearance: { hair: "brown", eyes: null }, outfit: null });
        expect(u.appearance).toEqual({ hair: "brown" });
        expect(u.outfit).toBeUndefined();
        expect(u.version).toBe(2);

        await expect(engine.characters.update("ala", { name: "Stale" }, { expectedVersion: 1 })).rejects.toBeInstanceOf(VersionConflictError);
        expect((await engine.characters.update("ala", { name: "Fresh" }, { expectedVersion: 2 })).version).toBe(3);

        await expect(engine.characters.create({ id: "ala", name: "Again" })).rejects.toBeInstanceOf(ConflictError);
        for (const n of ["b", "c", "d"]) await engine.characters.create({ name: n, tags: ["hero"] });
        const page1 = await engine.characters.list({ tag: "hero", limit: 3 });
        expect(page1.items).toHaveLength(3);
        const page2 = await engine.characters.list({ tag: "hero", limit: 3, cursor: page1.nextCursor });
        expect(page2.items).toHaveLength(1);
    });

    it("rejects invalid input and dangling links", async () => {
        const { engine } = setup();
        await expect(engine.characters.create({ name: "" })).rejects.toBeInstanceOf(ValidationError);
        await expect(engine.characters.create({ name: "X", bogus: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
        await expect(engine.characters.create({ name: "X", version: 7 } as never)).rejects.toBeInstanceOf(ValidationError);
        await expect(engine.scenes.create({ name: "S", cast: [{ characterId: "nobody" }] })).rejects.toThrow(/character:nobody/);
        await expect(engine.characters.update("missing", { name: "Y" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("blocks deleting referenced entities unless forced, then detaches them", async () => {
        const { engine } = setup();
        const hat = await engine.accessories.create({ name: "Hat" });
        const c = await engine.characters.create({ name: "Bo", defaultAccessoryIds: [hat.id] });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id, accessoryIds: [hat.id] }], accessoryIds: [hat.id] });

        await expect(engine.accessories.delete(hat.id)).rejects.toBeInstanceOf(InUseError);
        expect(await engine.accessories.delete(hat.id, { force: true })).toBe(true);
        expect((await engine.characters.require(c.id)).defaultAccessoryIds).toEqual([]);
        const scene = await engine.scenes.require(s.id);
        expect(scene.accessoryIds).toEqual([]);
        expect(scene.cast[0]?.accessoryIds).toEqual([]);

        await engine.characters.delete(c.id, { force: true });
        expect((await engine.scenes.require(s.id)).cast).toEqual([]);
    });

    it("keeps story scene order in sync with scene membership", async () => {
        const { engine } = setup();
        const story = await engine.stories.create({ name: "Book" });
        const other = await engine.stories.create({ name: "Other" });
        const a = await engine.scenes.create({ name: "A", storyId: story.id });
        const b = await engine.scenes.create({ name: "B", storyId: story.id });
        expect((await engine.stories.require(story.id)).sceneOrder).toEqual([a.id, b.id]);

        await engine.stories.update(story.id, { sceneOrder: [b.id, a.id] });
        expect((await engine.listStoryScenes(story.id)).map((s) => s.name)).toEqual(["B", "A"]);
        await expect(engine.stories.update(other.id, { sceneOrder: [a.id] })).rejects.toBeInstanceOf(ValidationError);

        await engine.scenes.update(a.id, { storyId: other.id });
        expect((await engine.stories.require(story.id)).sceneOrder).toEqual([b.id]);
        expect((await engine.stories.require(other.id)).sceneOrder).toEqual([a.id]);
        await engine.scenes.delete(b.id);
        expect((await engine.stories.require(story.id)).sceneOrder).toEqual([]);
    });
});

describe("reference images", () => {
    it("downscales, manages the primary flag and cleans up", async () => {
        const { engine, storage } = setup({ maxReferenceDimension: 512 });
        const c = await engine.characters.create({ name: "Ala" });
        const big = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
        const r1 = await engine.addReference({ kind: "character", entityId: c.id, image: { data: big } });
        expect(r1).toMatchObject({ isPrimary: true, mimeType: "image/jpeg", width: 512, height: 256 });
        expect(r1.blobKey).toMatch(/^references\/character\/.+\.jpg$/);
        const stored = await storage.blobs.get(r1.blobKey);
        expect((await sharp(stored!.data).metadata()).width).toBe(512);

        const r2 = await engine.addReference({ kind: "character", entityId: c.id, image: { base64: (await png()).toString("base64") }, view: "side" });
        expect(r2.isPrimary).toBe(false);
        await engine.updateReference("character", c.id, r2.id, { isPrimary: true, label: "Ala side" });
        let refs = (await engine.characters.require(c.id)).references;
        expect(refs.find((r) => r.id === r1.id)?.isPrimary).toBe(false);
        expect(refs.find((r) => r.id === r2.id)).toMatchObject({ isPrimary: true, label: "Ala side" });

        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id, referenceIds: [r2.id] }] });
        await engine.removeReference("character", c.id, r2.id);
        refs = (await engine.characters.require(c.id)).references;
        expect(refs).toHaveLength(1);
        expect(refs[0]?.isPrimary).toBe(true);
        expect(await storage.blobs.get(r2.blobKey)).toBeNull();
        expect((await engine.scenes.require(s.id)).cast[0]?.referenceIds).toEqual([]);

        await engine.scenes.delete(s.id);
        await engine.characters.delete(c.id);
        expect(await storage.blobs.get(r1.blobKey)).toBeNull();
    });

    it("rejects non-images and URL sources unless allowed", async () => {
        const { engine } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        await expect(engine.addReference({ kind: "character", entityId: c.id, image: { data: Buffer.from("nope") } })).rejects.toBeInstanceOf(ValidationError);
        await expect(engine.addReference({ kind: "character", entityId: c.id, image: { url: "http://169.254.169.254/x.png" } })).rejects.toThrow(/disabled/);
    });

    it("uploads each reference to provider storage once and reuses the URL", async () => {
        const { engine, provider } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }] });
        await settle(engine, engine.renderScene(s.id));
        await settle(engine, engine.renderScene(s.id));
        expect(provider.uploads).toHaveLength(1);
        const job = provider.jobs[1]!.job;
        expect(job.type === "image" && job.references[0]?.url).toBe(provider.uploads[0]!.url);
        expect((await engine.characters.require(c.id)).references[0]?.providerUpload?.url).toBe(provider.uploads[0]!.url);
    });

    it("falls back to data URIs when uploads are disabled", async () => {
        const { engine, provider } = setup({ referenceTransport: "data-uri" });
        const c = await engine.characters.create({ name: "Ala" });
        await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }] });
        await engine.renderScene(s.id);
        const job = provider.jobs[0]!.job;
        expect(job.type === "image" && job.references[0]?.url).toMatch(/^data:image\/png;base64,/);
        expect(provider.uploads).toHaveLength(0);
    });
});

describe("async rendering", () => {
    it("queues, progresses and completes renders; auto-selects the first", async () => {
        const { engine, provider, storage } = setup({}, { checksUntilDone: 2 });
        const s = await engine.scenes.create({ name: "S" });
        const renders = await engine.renderScene(s.id, { count: 2 });
        expect(renders.map((r) => r.status)).toEqual(["queued", "queued"]);
        expect(renders[0]!.requestId).toBe(renders[1]!.requestId);
        expect(provider.jobs).toHaveLength(1);
        expect(provider.jobs[0]!.job).toMatchObject({ type: "image", numImages: 2, mode: "text-to-image" });

        expect((await engine.syncRender(renders[0]!.id)).status).toBe("queued");
        expect((await engine.syncRender(renders[0]!.id)).status).toBe("running");
        const done = await engine.syncRender(renders[0]!.id);
        expect(done).toMatchObject({ status: "succeeded", image: { mimeType: "image/png", width: 64, height: 48 } });
        const sibling = await engine.getRender(renders[1]!.id);
        expect(sibling?.status).toBe("succeeded");
        expect(await storage.blobs.get(done.image!.blobKey)).not.toBeNull();
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBe(renders[0]!.id);
        expect((await engine.listRenders({ targetKind: "scene", targetId: s.id })).items).toHaveLength(2);
    });

    it("records provider failures, submit errors and timeouts", async () => {
        const failing = setup({}, { failWith: "content policy" });
        const s1 = await failing.engine.scenes.create({ name: "S" });
        const [r1] = await settle(failing.engine, failing.engine.renderScene(s1.id));
        expect(r1).toMatchObject({ status: "failed", error: "content policy" });
        expect((await failing.engine.scenes.require(s1.id)).selectedRenderId).toBeUndefined();

        const broken = setup({}, { submitError: new Error("quota exceeded") });
        const s2 = await broken.engine.scenes.create({ name: "S" });
        const [r2] = await broken.engine.renderScene(s2.id);
        expect(r2).toMatchObject({ status: "failed", error: "quota exceeded" });

        const slow = setup({ renderTimeoutMs: 0 }, { checksUntilDone: 100 });
        const s3 = await slow.engine.scenes.create({ name: "S" });
        const [r3] = await slow.engine.renderScene(s3.id);
        await new Promise((r) => setTimeout(r, 5));
        expect(await slow.engine.syncRender(r3!.id)).toMatchObject({ status: "failed", error: /Timed out/ });
        expect(slow.provider.jobs[0]!.canceled).toBe(true);
    });

    it("cancels pending renders and syncs everything pending", async () => {
        const { engine, provider } = setup({}, { checksUntilDone: 1 });
        const s = await engine.scenes.create({ name: "S" });
        const [a] = await engine.renderScene(s.id);
        const [b] = await engine.renderScene(s.id);
        expect((await engine.cancelRender(a!.id)).status).toBe("canceled");
        expect(provider.jobs[0]!.canceled).toBe(true);
        await engine.syncPendingRenders();
        const result = await engine.syncPendingRenders();
        expect(result).toEqual({ checked: 1, completed: 1 });
        expect((await engine.getRender(b!.id))?.status).toBe("succeeded");
    });

    it("refines and upscales finished renders", async () => {
        const { engine, provider } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }], generation: { aspectRatio: "3:4" } });
        const [base] = await settle(engine, engine.renderScene(s.id));

        const [refined] = await settle(engine, engine.refineRender(base!.id, { instructions: "make Ala smile" }));
        expect(refined).toMatchObject({ status: "succeeded", operation: "refine", parentRenderId: base!.id, params: { aspectRatio: "3:4" } });
        expect(refined!.references.map((r) => [r.index, r.role])).toEqual([
            [1, "base"],
            [2, "entity"],
        ]);
        expect(refined!.prompt).toMatch(/^Edit Image 1 .*\nmake Ala smile/);
        expect(refined!.prompt).toContain("Ala [see Image 2]");
        const job = provider.jobs[1]!.job;
        expect(job.type === "image" && job.references).toHaveLength(2);

        const up = await engine.upscaleRender(base!.id, { scale: 2 });
        const upDone = await engine.waitForRender(up.id, { pollIntervalMs: 1 });
        expect(upDone).toMatchObject({ status: "succeeded", operation: "upscale", params: { scale: 2 }, image: { width: 128, height: 96 } });
        expect(provider.jobs[2]!.job.type).toBe("upscale");

        await expect(engine.refineRender(base!.id, { instructions: " " })).rejects.toBeInstanceOf(ValidationError);
    });

    it("validates webhook tokens", async () => {
        const urls: string[] = [];
        const { engine, provider } = setup({ webhookUrl: ({ renderId, token }) => (urls.push(token), `https://hooks.example/${renderId}?token=${token}`) });
        const s = await engine.scenes.create({ name: "S" });
        const [r] = await engine.renderScene(s.id);
        expect(provider.jobs[0]!.webhookUrl).toContain(r!.id);
        await expect(engine.handleProviderWebhook(r!.id, "forged")).rejects.toBeInstanceOf(NotFoundError);
        expect((await engine.handleProviderWebhook(r!.id, urls[0]!)).status).toBe("succeeded");
    });
});

describe("limits, pricing and review", () => {
    it("enforces concurrency, daily count and budget", async () => {
        const conc = setup({ limits: { maxConcurrentRenders: 2 } }, { checksUntilDone: 100 });
        const s = await conc.engine.scenes.create({ name: "S" });
        await conc.engine.renderScene(s.id, { count: 2 });
        await expect(conc.engine.renderScene(s.id)).rejects.toBeInstanceOf(LimitExceededError);

        const daily = setup({ limits: { maxRendersPerDay: 3 } });
        const d = await daily.engine.scenes.create({ name: "S" });
        await settle(daily.engine, daily.engine.renderScene(d.id, { count: 3 }));
        await expect(daily.engine.renderScene(d.id)).rejects.toThrow(/Daily render limit/);

        const budget = setup({ limits: { maxDailyCostUsd: 0.5 }, pricing: { "mock/generate": 0.2 } });
        const b = await budget.engine.scenes.create({ name: "S" });
        const [priced] = await budget.engine.renderScene(b.id, { count: 2 });
        expect(priced?.estimatedCostUsd).toBe(0.2);
        await expect(budget.engine.renderScene(b.id)).rejects.toThrow(/Daily budget/);
    });

    it("stores reviews and does not auto-select flagged images", async () => {
        const reviewer: ImageReviewer = {
            name: "test-reviewer",
            review: async () => ({ flagged: true, consistencyScore: 0.4, issues: ["extra character"] }),
        };
        const { engine } = setup({ reviewer });
        const s = await engine.scenes.create({ name: "S" });
        const [r] = await settle(engine, engine.renderScene(s.id));
        expect(r!.review).toEqual({ reviewer: "test-reviewer", flagged: true, consistencyScore: 0.4, issues: ["extra character"] });
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBeUndefined();
    });
});

describe("selection and promotion", () => {
    it("selects, promotes and deletes renders", async () => {
        const { engine } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }] });
        const renders = await settle(engine, engine.renderScene(s.id, { count: 2 }));
        await engine.selectSceneRender(s.id, renders[1]!.id);
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBe(renders[1]!.id);

        const [preview] = await settle(engine, engine.renderEntityPreview("character", c.id));
        await expect(engine.selectSceneRender(s.id, preview!.id)).rejects.toBeInstanceOf(ValidationError);
        const promoted = await engine.promoteRenderToReference(preview!.id, { kind: "character", entityId: c.id, view: "full body" });
        expect((await engine.characters.require(c.id)).references.map((r) => r.id)).toContain(promoted.id);

        await engine.deleteRender(renders[1]!.id);
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBeUndefined();
    });
});
