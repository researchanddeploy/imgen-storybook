import { describe, expect, it } from "vitest";
import { planReferences, type AnyEntity, type ReferenceImage } from "../src/index.js";
import { png, settle, setup } from "./helpers.js";

function ref(id: string, isPrimary = false): ReferenceImage {
    return { id, blobKey: `k/${id}.png`, mimeType: "image/png", isPrimary, createdAt: "2026-01-01T00:00:00.000Z" };
}

function entity(id: string, refs: ReferenceImage[]): AnyEntity {
    return { id, kind: "character", version: 1, name: id, description: "", tags: [], references: refs, appearance: {}, defaultAccessoryIds: [], createdAt: "", updatedAt: "" };
}

describe("planReferences", () => {
    it("gives every entity its primary image before anyone gets a second one", () => {
        const a = entity("a", [ref("a1"), ref("a2", true), ref("a3")]);
        const b = entity("b", [ref("b1", true), ref("b2")]);
        const c = entity("c", [ref("c1", true)]);
        const plan = planReferences([a, b, c], { maxReferences: 4, maxPerEntity: 3 });
        expect(plan.map((p) => p.reference?.id)).toEqual(["a2", "a1", "b1", "c1"]);
        expect(plan.map((p) => p.index)).toEqual([1, 2, 3, 4]);
    });

    it("honours explicit selections, the per-entity cap and an index offset", () => {
        const a = entity("a", [ref("a1", true), ref("a2"), ref("a3")]);
        const plan = planReferences([a, a], { maxReferences: 10, maxPerEntity: 2 }, new Map([["character:a", ["a3", "a1"]]]), 1);
        expect(plan.map((p) => [p.index, p.reference?.id])).toEqual([
            [2, "a3"],
            [3, "a1"],
        ]);
    });
});

describe("composeScene", () => {
    it("builds a prompt with legend, cast, props, setting and constraints", async () => {
        const { engine } = setup();
        const style = await engine.styles.create({ name: "Watercolor", medium: "soft watercolor", negative: ["photorealism"], generation: { aspectRatio: "3:4" } });
        const umbrella = await engine.accessories.create({ name: "Red umbrella", colors: ["red"] });
        const kite = await engine.accessories.create({ name: "Kite" });
        const ala = await engine.characters.create({
            name: "Ala",
            appearance: { age: "7", hair: "two red braids" },
            outfit: "yellow raincoat",
            defaultAccessoryIds: [umbrella.id],
        });
        const harbor = await engine.locations.create({ name: "Harbor", keyFeatures: ["lighthouse"], defaultTimeOfDay: "dusk" });
        const story = await engine.stories.create({ name: "Rainy Day", audience: "children 4-7", styleId: style.id });
        const scene = await engine.scenes.create({
            name: "Meeting the gull",
            description: "Ala meets a talking seagull on the pier",
            storyId: story.id,
            locationId: harbor.id,
            cast: [{ characterId: ala.id, expression: "surprised", position: "left foreground" }],
            accessoryIds: [umbrella.id, kite.id],
            negative: ["crowds"],
            generation: { resolution: "2K" },
        });
        await engine.addReference({ kind: "character", entityId: ala.id, image: { data: await png() }, view: "front" });

        const composed = await engine.composeScene(scene.id);
        expect(composed.mode).toBe("reference-to-image");
        expect(composed.references).toHaveLength(1);
        expect(composed.prompt).toContain('Image 1: character "Ala" (front)');
        expect(composed.prompt).toContain("Ala [see Image 1]");
        expect(composed.prompt).toContain("hair: two red braids");
        expect(composed.prompt).toContain("Carries / wears: Red umbrella");
        expect(composed.prompt).toContain("PROPS IN THE SCENE:\n- Kite");
        expect(composed.prompt).not.toMatch(/PROPS IN THE SCENE:[^]*Red umbrella/);
        expect(composed.prompt).toContain("Time of day: dusk");
        expect(composed.prompt).toContain("Avoid: photorealism, crowds.");
        expect(composed.prompt).toContain("No text, letters");
        expect(composed.prompt).toContain("Intended audience: children 4-7");
        expect(composed.generation).toMatchObject({ aspectRatio: "3:4", resolution: "2K", outputFormat: "png" });
        expect((await engine.composeScene(scene.id, { generation: { aspectRatio: "16:9" } })).generation.aspectRatio).toBe("16:9");
    });

    it("uses per-scene reference choices", async () => {
        const { engine } = setup();
        const c = await engine.characters.create({ name: "Bo" });
        const summer = await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png() }, view: "summer" });
        const winter = await engine.addReference({ kind: "character", entityId: c.id, image: { data: await png({ r: 0, g: 0, b: 255 }) }, view: "winter" });
        const s = await engine.scenes.create({ name: "Snow", cast: [{ characterId: c.id, referenceIds: [winter.id] }] });
        const composed = await engine.composeScene(s.id);
        expect(composed.references.map((r) => r.reference?.id)).toEqual([winter.id]);
        expect(summer.isPrimary).toBe(true);

        await expect(engine.scenes.update(s.id, { cast: [{ characterId: c.id, referenceIds: ["ref_missing"] }] })).rejects.toThrow(/no reference images ref_missing/);
    });

    it("attaches the previous page as a continuity anchor", async () => {
        const { engine } = setup();
        const story = await engine.stories.create({ name: "Book" });
        const p1 = await engine.scenes.create({ name: "Page 1", storyId: story.id });
        const p2 = await engine.scenes.create({ name: "Page 2", storyId: story.id, continuity: { fromPreviousScene: true } });

        expect((await engine.composeScene(p2.id)).references).toHaveLength(0); // page 1 has no illustration yet
        const [r1] = await settle(engine, engine.renderScene(p1.id));
        const composed = await engine.composeScene(p2.id);
        expect(composed.references).toMatchObject([{ index: 1, role: "continuity", renderId: r1!.id }]);
        expect(composed.prompt).toContain('Image 1: page "Page 1" (continuity anchor)');
        expect(composed.prompt).toContain("compose this scene fresh");
    });

    it("drops default accessories when the cast member opts out", async () => {
        const { engine } = setup();
        const hat = await engine.accessories.create({ name: "Wizard hat" });
        const c = await engine.characters.create({ name: "Bo", defaultAccessoryIds: [hat.id] });
        const s = await engine.scenes.create({ name: "Bath", cast: [{ characterId: c.id, includeDefaultAccessories: false }] });
        const composed = await engine.composeScene(s.id);
        expect(composed.mode).toBe("text-to-image");
        expect(composed.prompt).not.toContain("Wizard hat");
    });
});
