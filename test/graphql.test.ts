import { graphql } from "graphql";
import { describe, expect, it } from "vitest";
import { createStoryGraphQLSchema } from "../src/graphql/index.js";
import { png, setup } from "./helpers.js";

function client() {
    const { engine, provider } = setup();
    const schema = createStoryGraphQLSchema({ engine });
    const run = async (source: string, variableValues?: Record<string, unknown>) =>
        (await graphql({ schema, source, variableValues, contextValue: {} })) as { data?: any; errors?: Array<{ message: string; extensions?: any }> };
    return { run, engine, provider };
}

describe("GraphQL", () => {
    it("drives the full story flow", async () => {
        const { run, provider } = client();

        const style = await run(`mutation { createStyle(input: { name: "Ink", medium: "ink and wash", generation: { aspectRatio: "3:4", outputFormat: WEBP } }) { id version generation { aspectRatio outputFormat } } }`);
        expect(style.errors).toBeUndefined();
        expect(style.data.createStyle).toMatchObject({ version: 1, generation: { aspectRatio: "3:4", outputFormat: "WEBP" } });
        const styleId = style.data.createStyle.id;

        const story = await run(`mutation($s: ID) { createStory(input: { name: "Rainy Day", styleId: $s, audience: "kids" }) { id } }`, { s: styleId });
        const storyId = story.data.createStory.id;

        await run(`mutation { createCharacter(input: { id: "ala", name: "Ala", appearance: { hair: "red braids" } }) { id } }`);
        const ref = await run(
            `mutation($img: String!) { addReferenceImage(input: { kind: CHARACTER, entityId: "ala", image: { base64: $img }, view: "front" }) { id isPrimary width image { mimeType url } } }`,
            { img: (await png()).toString("base64") },
        );
        expect(ref.errors).toBeUndefined();
        expect(ref.data.addReferenceImage).toMatchObject({ isPrimary: true, width: 8, image: { mimeType: "image/png", url: null } });
        const refId = ref.data.addReferenceImage.id;

        const scene = await run(
            `mutation($story: ID, $ref: ID!) { createScene(input: { name: "Pier", storyId: $story, description: "Ala on the pier", cast: [{ characterId: "ala", expression: "happy", referenceIds: [$ref] }], continuity: { fromPreviousScene: true } }) { id cast { character { name } referenceIds includeDefaultAccessories } continuity { fromPreviousScene sceneIds } effectiveStyle { name } } }`,
            { story: storyId, ref: refId },
        );
        expect(scene.errors).toBeUndefined();
        expect(scene.data.createScene).toMatchObject({
            cast: [{ character: { name: "Ala" }, referenceIds: [refId], includeDefaultAccessories: true }],
            continuity: { fromPreviousScene: true, sceneIds: [] },
            effectiveStyle: { name: "Ink" },
        });
        const sceneId = scene.data.createScene.id;

        const dry = await run(`query($id: ID!) { composeScenePrompt(sceneId: $id) { mode references { index role entityName view } generation { outputFormat aspectRatio } } }`, { id: sceneId });
        expect(dry.data.composeScenePrompt).toMatchObject({
            mode: "REFERENCE_TO_IMAGE",
            references: [{ index: 1, role: "ENTITY", entityName: "Ala", view: "front" }],
            generation: { outputFormat: "WEBP", aspectRatio: "3:4" },
        });

        const queued = await run(`mutation($id: ID!) { renderScene(sceneId: $id, options: { count: 1 }) { id status operation target { kind entity { name } } } }`, { id: sceneId });
        expect(queued.errors).toBeUndefined();
        const r = queued.data.renderScene[0];
        expect(r).toMatchObject({ status: "QUEUED", operation: "GENERATE", target: { kind: "SCENE", entity: { name: "Pier" } } });
        const job = provider.jobs[0]!.job;
        expect(job.type === "image" && job.outputFormat).toBe("webp");

        const fetched = await run(`query($id: ID!) { render(id: $id) { status params { outputFormat } image { dataUri width } } }`, { id: r.id });
        expect(fetched.data.render).toMatchObject({ status: "SUCCEEDED", params: { outputFormat: "WEBP" } });
        expect(fetched.data.render.image.dataUri).toMatch(/^data:image\/png;base64,/);

        const refined = await run(`mutation($id: ID!) { refineRender(renderId: $id, input: { instructions: "add a red kite" }) { id operation parent { id } references { index role } } }`, { id: r.id });
        expect(refined.errors).toBeUndefined();
        expect(refined.data.refineRender[0]).toMatchObject({ operation: "REFINE", parent: { id: r.id }, references: [{ index: 1, role: "BASE" }, { index: 2, role: "ENTITY" }] });

        const book = await run(`query($id: ID!) { story(id: $id) { sceneOrder scenes { name selectedRender { id } renders(first: 1) { items { id } nextCursor } } } }`, { id: storyId });
        expect(book.data.story.scenes[0].selectedRender).toEqual({ id: r.id });
        expect(book.data.story.scenes[0].renders.items).toHaveLength(1);
        expect(book.data.story.scenes[0].renders.nextCursor).not.toBeNull();

        const upd = await run(`mutation { updateCharacter(id: "ala", input: { appearance: { eyes: "green", hair: null }, outfit: "raincoat" }) { version appearance { hair eyes } outfit } }`);
        expect(upd.data.updateCharacter).toMatchObject({ appearance: { hair: null, eyes: "green" }, outfit: "raincoat" });
        const stale = await run(`mutation { updateCharacter(id: "ala", input: { outfit: "x" }, expectedVersion: 1) { id } }`);
        expect(stale.errors?.[0]?.extensions?.code).toBe("CONFLICT");

        const list = await run(`{ characters(first: 1) { items { id } nextCursor } }`);
        expect(list.data.characters).toEqual({ items: [{ id: "ala" }], nextCursor: null });

        expect((await run(`mutation { deleteCharacter(id: "ala") }`)).errors?.[0]?.extensions?.code).toBe("IN_USE");
        expect((await run(`mutation { deleteCharacter(id: "ala", force: true) }`)).data.deleteCharacter).toBe(true);
    });

    it("exposes tool definitions and maps errors", async () => {
        const { run } = client();
        const tools = await run(`{ toolDefinitions(format: OPENAI) }`);
        const defs = JSON.parse(tools.data.toolDefinitions);
        expect(defs.find((d: any) => d.function.name === "create_character").function.parameters.properties.name).toBeDefined();

        expect((await run(`mutation { updateStyle(id: "nope", input: { name: "x" }) { id } }`)).errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
        expect((await run(`mutation { createScene(input: { name: "S", cast: [{ characterId: "ghost" }] }) { id } }`)).errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
        const twoSources = await run(`mutation { addReferenceImage(input: { kind: STYLE, entityId: "x", image: { base64: "a", url: "b" } }) { id } }`);
        expect(twoSources.errors?.[0]?.message).toMatch(/exactly one/);
    });
});
