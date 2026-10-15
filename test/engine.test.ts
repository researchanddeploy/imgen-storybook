import { describe, expect, it } from "vitest";
import { ConflictError, InUseError, NotFoundError, ValidationError, createMockImageProvider } from "../src/index.js";
import { png, setup } from "./helpers.js";

describe("entities", () => {
    it("creates, updates with merge/null semantics and lists", async () => {
        const { engine } = setup();
        const c = await engine.characters.create({ id: "ala", name: "Ala", tags: ["hero"], appearance: { hair: "red", eyes: "green" }, outfit: "coat" });
        expect(c).toMatchObject({ id: "ala", kind: "character", description: "", references: [], defaultAccessoryIds: [] });

        const u = await engine.characters.update("ala", { appearance: { hair: "brown", eyes: null }, outfit: null });
        expect(u.appearance).toEqual({ hair: "brown" });
        expect(u.outfit).toBeUndefined();
        expect(u.updatedAt >= c.updatedAt).toBe(true);

        expect(await engine.characters.list({ tag: "hero" })).toHaveLength(1);
        expect(await engine.characters.list({ tag: "villain" })).toHaveLength(0);
        await expect(engine.characters.create({ id: "ala", name: "Again" })).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects invalid input and dangling links", async () => {
        const { engine } = setup();
        await expect(engine.characters.create({ name: "" })).rejects.toBeInstanceOf(ValidationError);
        await expect(engine.characters.create({ name: "X", bogus: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
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
    it("stores images, manages the primary flag and cleans up blobs", async () => {
        const { engine, storage } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        const r1 = await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const r2 = await engine.addReference({
            kind: "character",
            entityId: c.id,
            image: { base64: (await png({ r: 0, g: 255, b: 0 })).toString("base64") },
            view: "side",
        });
        expect(r1.isPrimary).toBe(true);
        expect(r2.isPrimary).toBe(false);
        expect(r1.blobKey).toMatch(/^references\/character\/.+\.png$/);

        await engine.updateReference("character", c.id, r2.id, { isPrimary: true, label: "Ala side" });
        let refs = (await engine.characters.require(c.id)).references;
        expect(refs.find((r) => r.id === r1.id)?.isPrimary).toBe(false);
        expect(refs.find((r) => r.id === r2.id)).toMatchObject({ isPrimary: true, label: "Ala side" });

        await engine.removeReference("character", c.id, r2.id);
        refs = (await engine.characters.require(c.id)).references;
        expect(refs).toHaveLength(1);
        expect(refs[0]?.isPrimary).toBe(true);
        expect(await storage.blobs.get(r2.blobKey)).toBeNull();

        await engine.characters.delete(c.id);
        expect(await storage.blobs.get(r1.blobKey)).toBeNull();
    });

    it("rejects non-images and URL sources unless allowed", async () => {
        const { engine } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        await expect(engine.addReference({ kind: "character", entityId: c.id, image: { data: Buffer.from("nope") } })).rejects.toBeInstanceOf(
            ValidationError,
        );
        await expect(engine.addReference({ kind: "character", entityId: c.id, image: { url: "http://169.254.169.254/x.png" } })).rejects.toThrow(
            /disabled/,
        );
    });
});

describe("rendering", () => {
    it("renders a scene with references, auto-selects and promotes renders", async () => {
        const { engine, provider, storage } = setup();
        const c = await engine.characters.create({ name: "Ala" });
        await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() } });
        const s = await engine.scenes.create({ name: "S", cast: [{ characterId: c.id }] });

        const renders = await engine.renderScene(s.id, { count: 2 });
        expect(renders).toHaveLength(2);
        expect(renders.every((r) => r.status === "succeeded")).toBe(true);
        expect(provider.calls[0]?.mode).toBe("reference-to-image");
        expect(provider.calls[0]?.references[0]?.url).toMatch(/^data:image\/png;base64,/);
        expect(provider.calls[0]?.numImages).toBe(2);
        expect(renders[0]?.image).toMatchObject({ mimeType: "image/png", width: 64, height: 48 });
        expect(await storage.blobs.get(renders[0]!.image!.blobKey)).not.toBeNull();

        expect((await engine.scenes.require(s.id)).selectedRenderId).toBe(renders[0]?.id);
        await engine.selectSceneRender(s.id, renders[1]!.id);
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBe(renders[1]?.id);

        const preview = await engine.renderEntityPreview("character", c.id);
        await expect(engine.selectSceneRender(s.id, preview[0]!.id)).rejects.toBeInstanceOf(ValidationError);
        const promoted = await engine.promoteRenderToReference(preview[0]!.id, { kind: "character", entityId: c.id, view: "full body" });
        expect((await engine.characters.require(c.id)).references.map((r) => r.id)).toContain(promoted.id);

        await engine.deleteRender(renders[1]!.id);
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBeUndefined();
        expect(await engine.listRenders({ targetKind: "scene", targetId: s.id })).toHaveLength(1);
    });

    it("records provider failures as failed renders", async () => {
        const { engine } = setup({ provider: createMockImageProvider({ failWith: "quota exceeded" }) });
        const s = await engine.scenes.create({ name: "S" });
        const [r] = await engine.renderScene(s.id);
        expect(r).toMatchObject({ status: "failed", error: "quota exceeded" });
        expect(r?.image).toBeUndefined();
        expect((await engine.scenes.require(s.id)).selectedRenderId).toBeUndefined();
    });

    it("applies post-processing", async () => {
        const { engine } = setup();
        const a = await engine.accessories.create({ name: "Key" });
        const [r] = await engine.renderEntityPreview("accessory", a.id, {
            generation: { aspectRatio: "1:1" },
            postProcess: { resize: { width: 16, height: 16 } },
        });
        expect(r?.image).toMatchObject({ width: 16, height: 16 });
    });
});
