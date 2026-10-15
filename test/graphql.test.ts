import { graphql } from "graphql";
import { describe, expect, it } from "vitest";
import { createStoryGraphQLSchema } from "../src/graphql/index.js";
import { png, setup } from "./helpers.js";

function client() {
    const { engine, provider } = setup();
    const schema = createStoryGraphQLSchema({ engine });
    const run = async (source: string, variableValues?: Record<string, unknown>) => {
        const res = await graphql({ schema, source, variableValues });
        return res as { data?: any; errors?: Array<{ message: string; extensions?: any }> };
    };
    return { run, engine, provider };
}

describe("GraphQL mutations", () => {
    it("drives the full story flow", async () => {
        const { run, provider } = client();

        const style = await run(`mutation { createStyle(input: { name: "Ink", medium: "ink and wash", generation: { aspectRatio: "3:4", outputFormat: WEBP } }) { id generation { aspectRatio outputFormat } } }`);
        expect(style.errors).toBeUndefined();
        expect(style.data.createStyle.generation).toEqual({ aspectRatio: "3:4", outputFormat: "WEBP" });
        const styleId = style.data.createStyle.id;

        const story = await run(`mutation($s: ID) { createStory(input: { name: "Rainy Day", styleId: $s, audience: "kids" }) { id } }`, { s: styleId });
        const storyId = story.data.createStory.id;

        const ch = await run(`mutation { createCharacter(input: { id: "ala", name: "Ala", appearance: { hair: "red braids" } }) { id appearance { hair distinguishingFeatures } } }`);
        expect(ch.data.createCharacter).toEqual({ id: "ala", appearance: { hair: "red braids", distinguishingFeatures: [] } });

        const ref = await run(
            `mutation($img: String!) { addReferenceImage(input: { kind: CHARACTER, entityId: "ala", image: { base64: $img }, view: "front" }) { id isPrimary image { mimeType url } } }`,
            { img: (await png()).toString("base64") },
        );
        expect(ref.errors).toBeUndefined();
        expect(ref.data.addReferenceImage).toMatchObject({ isPrimary: true, image: { mimeType: "image/png", url: null } });

        const scene = await run(
            `mutation($story: ID) { createScene(input: { name: "Pier", storyId: $story, description: "Ala on the pier", cast: [{ characterId: "ala", expression: "happy" }], camera: { shot: "wide" } }) { id cast { character { name } includeDefaultAccessories } effectiveStyle { name } } }`,
            { story: storyId },
        );
        expect(scene.errors).toBeUndefined();
        expect(scene.data.createScene.effectiveStyle.name).toBe("Ink");
        const sceneId = scene.data.createScene.id;

        const dry = await run(`query($id: ID!) { composeScenePrompt(sceneId: $id) { mode prompt references { index entityName view } generation { outputFormat aspectRatio } } }`, { id: sceneId });
        expect(dry.data.composeScenePrompt).toMatchObject({
            mode: "REFERENCE_TO_IMAGE",
            references: [{ index: 1, entityName: "Ala", view: "front" }],
            generation: { outputFormat: "WEBP", aspectRatio: "3:4" },
        });

        const render = await run(`mutation($id: ID!) { renderScene(sceneId: $id, options: { count: 1 }) { id status mode params { outputFormat } image { dataUri width } target { kind entity { name } } } }`, { id: sceneId });
        expect(render.errors).toBeUndefined();
        const r = render.data.renderScene[0];
        expect(r).toMatchObject({ status: "SUCCEEDED", mode: "REFERENCE_TO_IMAGE", params: { outputFormat: "WEBP" }, target: { kind: "SCENE", entity: { name: "Pier" } } });
        expect(r.image.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(provider.calls[0]?.outputFormat).toBe("webp");

        const book = await run(`query($id: ID!) { story(id: $id) { name sceneOrder scenes { name selectedRender { id } renders { id } } } }`, { id: storyId });
        expect(book.data.story.scenes[0]).toEqual({ name: "Pier", selectedRender: { id: r.id }, renders: [{ id: r.id }] });

        const upd = await run(`mutation { updateCharacter(id: "ala", input: { appearance: { eyes: "green", hair: null }, outfit: "raincoat" }) { appearance { hair eyes } outfit } }`);
        expect(upd.data.updateCharacter).toEqual({ appearance: { hair: null, eyes: "green" }, outfit: "raincoat" });

        const del = await run(`mutation { deleteCharacter(id: "ala") }`);
        expect(del.errors?.[0]?.extensions?.code).toBe("IN_USE");
        const forced = await run(`mutation { deleteCharacter(id: "ala", force: true) }`);
        expect(forced.data.deleteCharacter).toBe(true);
    });

    it("maps engine errors to GraphQL error codes", async () => {
        const { run } = client();
        const missing = await run(`mutation { updateStyle(id: "nope", input: { name: "x" }) { id } }`);
        expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
        const invalid = await run(`mutation { createScene(input: { name: "S", cast: [{ characterId: "ghost" }] }) { id } }`);
        expect(invalid.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
        const twoSources = await run(`mutation { addReferenceImage(input: { kind: STYLE, entityId: "x", image: { base64: "a", url: "b" } }) { id } }`);
        expect(twoSources.errors?.[0]?.message).toMatch(/exactly one/);
    });
});
