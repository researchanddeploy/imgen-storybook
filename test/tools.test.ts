import { describe, expect, it } from "vitest";
import { executeStoryTool, getStoryToolDefinitions } from "../src/index.js";
import { setup } from "./helpers.js";

describe("LLM tools", () => {
    it("generates JSON-schema tool definitions in both formats", () => {
        const anthropic = getStoryToolDefinitions("anthropic");
        const create = anthropic.find((t) => "name" in t && t.name === "create_scene") as { input_schema: any };
        expect(create.input_schema.type).toBe("object");
        expect(create.input_schema.required).toEqual(["name"]);
        expect(create.input_schema.properties.cast.type).toBe("array");
        expect(JSON.stringify(anthropic)).not.toContain("$schema");

        const openai = getStoryToolDefinitions("openai", ["render_scene"]);
        expect(openai).toHaveLength(1);
        expect(openai[0]).toMatchObject({ type: "function", function: { name: "render_scene" } });
    });

    it("executes calls and returns errors instead of throwing", async () => {
        const { engine } = setup();
        const created = await executeStoryTool(engine, "create_character", { name: "Ala", appearance: { hair: "red" } });
        expect(created).toMatchObject({ ok: true, result: { name: "Ala", version: 1 } });
        const id = (created as any).result.id;

        const updated = await executeStoryTool(engine, "update_character", { id, patch: { outfit: "coat" }, expectedVersion: 1 });
        expect(updated).toMatchObject({ ok: true, result: { outfit: "coat", version: 2 } });

        const scene = await executeStoryTool(engine, "create_scene", { name: "S", cast: [{ characterId: id }] });
        const rendered = await executeStoryTool(engine, "render_scene", { sceneId: (scene as any).result.id });
        expect(rendered).toMatchObject({ ok: true, result: [{ status: "queued" }] });
        expect(JSON.stringify(rendered)).not.toContain("webhookToken");

        expect(await executeStoryTool(engine, "create_character", { name: "" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
        expect(await executeStoryTool(engine, "get_entity", { kind: "character", id: "missing" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
        expect(await executeStoryTool(engine, "nope", {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    });
});
