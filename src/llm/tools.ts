import { z } from "zod";
import { ENTITY_KINDS, ENTITY_SCHEMAS, GenerationSettingsSchema, IdSchema, type EntityKind, type Render } from "../domain/schemas.js";
import type { StoryEngine } from "../engine.js";
import { StoryEngineError, ValidationError } from "../errors.js";

/**
 * Tool definitions that let an LLM agent build and illustrate stories through the engine.
 * Input schemas are generated from the same zod schemas the engine validates with, so
 * the agent sees exactly the accepted shape.
 */

interface ToolSpec {
    description: string;
    input: z.ZodType;
    run: (engine: StoryEngine, input: any) => Promise<unknown>;
}

const kindEnum = z.enum(ENTITY_KINDS);
const KIND_LABEL: Record<EntityKind, string> = {
    character: "character (hero, side character, creature)",
    style: "art style (medium, palette, line work, mood, generation defaults)",
    location: "location (setting, key features, default time of day/weather)",
    accessory: "accessory / prop (object a character carries or that appears in scenes)",
    scene: "scene (one illustrated page: cast, location, action, camera)",
    story: "story (title, synopsis, audience, default style, scene order)",
};

/** Renders without internal fields; images are referenced, not inlined. */
function publicRender(r: Render) {
    const { webhookToken: _secret, postProcess: _pp, ...rest } = r;
    return rest;
}

const renderOptions = z
    .object({
        count: z.number().int().min(1).max(4).optional().describe("Number of candidate images (1-4)"),
        extraInstructions: z.string().max(2000).optional().describe("Free text appended to the prompt"),
        generation: GenerationSettingsSchema.optional(),
    })
    .strict();

function entityTools(): Record<string, ToolSpec> {
    const tools: Record<string, ToolSpec> = {};
    for (const kind of ENTITY_KINDS) {
        const { create, patch } = ENTITY_SCHEMAS[kind];
        tools[`create_${kind}`] = {
            description: `Create a ${KIND_LABEL[kind]}. Returns the stored record including its id and version.`,
            input: create as unknown as z.ZodType,
            run: (engine, input) => engine.entities(kind).create(input),
        };
        tools[`update_${kind}`] = {
            description: `Update a ${kind}. Omitted fields stay unchanged, null clears a field, nested objects are merged, lists are replaced. Pass expectedVersion to avoid overwriting someone else's changes.`,
            input: z.object({ id: IdSchema, patch: patch as unknown as z.ZodType, expectedVersion: z.number().int().positive().optional() }).strict(),
            run: (engine, input) => engine.entities(kind).update(input.id, input.patch, { expectedVersion: input.expectedVersion }),
        };
        tools[`delete_${kind}`] = {
            description: `Delete a ${kind} with its reference images and renders. Fails if other entities use it unless force=true (which detaches it).`,
            input: z.object({ id: IdSchema, force: z.boolean().optional() }).strict(),
            run: (engine, input) => engine.entities(kind).delete(input.id, { force: input.force }),
        };
    }
    return tools;
}

export const STORY_TOOLS: Record<string, ToolSpec> = {
    list_entities: {
        description: "List entities of one kind (oldest first, paginated). Use to discover ids before referencing them.",
        input: z
            .object({
                kind: kindEnum,
                tag: z.string().optional(),
                storyId: IdSchema.optional().describe("Scenes only"),
                limit: z.number().int().min(1).max(100).optional(),
                cursor: z.string().optional(),
            })
            .strict(),
        run: (engine, i) => engine.entities(i.kind as EntityKind).list({ tag: i.tag, storyId: i.storyId, limit: i.limit ?? 50, cursor: i.cursor }),
    },
    get_entity: {
        description: "Get one entity by kind and id.",
        input: z.object({ kind: kindEnum, id: IdSchema }).strict(),
        run: (engine, i) => engine.requireEntity(i.kind as EntityKind, i.id),
    },
    ...entityTools(),
    compose_scene_prompt: {
        description: "Dry run: show the exact prompt and reference images a scene render would use. Free.",
        input: z.object({ sceneId: IdSchema }).strict(),
        run: async (engine, i) => {
            const c = await engine.composeScene(i.sceneId);
            return { prompt: c.prompt, mode: c.mode, generation: c.generation, references: c.references.map(({ reference: _r, ...rest }) => rest) };
        },
    },
    render_scene: {
        description: "Queue illustration(s) of a scene. Returns renders in status queued; poll get_render until succeeded or failed. Costs money.",
        input: z.object({ sceneId: IdSchema }).extend(renderOptions.shape).strict(),
        run: async (engine, { sceneId, ...opts }) => (await engine.renderScene(sceneId, opts)).map(publicRender),
    },
    render_entity_preview: {
        description: "Queue a stand-alone image of an entity: character design, object, location shot, style sample or story cover. Costs money.",
        input: z.object({ kind: kindEnum, id: IdSchema, styleId: IdSchema.optional() }).extend(renderOptions.shape).strict(),
        run: async (engine, { kind, id, ...opts }) => (await engine.renderEntityPreview(kind, id, opts)).map(publicRender),
    },
    refine_render: {
        description: "Edit a finished render: apply only the described change and keep everything else. Costs money.",
        input: z
            .object({
                renderId: IdSchema,
                instructions: z.string().min(1).max(2000),
                count: z.number().int().min(1).max(4).optional(),
            })
            .strict(),
        run: async (engine, i) => (await engine.refineRender(i.renderId, { instructions: i.instructions, count: i.count })).map(publicRender),
    },
    get_render: {
        description: "Get a render's current status (refreshes pending renders from the provider).",
        input: z.object({ renderId: IdSchema }).strict(),
        run: async (engine, i) => publicRender(await engine.syncRender(i.renderId)),
    },
    select_scene_render: {
        description: "Choose which finished render illustrates the scene (renderId null clears the choice).",
        input: z.object({ sceneId: IdSchema, renderId: IdSchema.nullable() }).strict(),
        run: (engine, i) => engine.selectSceneRender(i.sceneId, i.renderId),
    },
};

export type ToolFormat = "anthropic" | "openai";

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return rest;
}

/** Tool definitions in Anthropic (`input_schema`) or OpenAI (`function.parameters`) format. */
export function getStoryToolDefinitions(format: ToolFormat = "anthropic", only?: string[]) {
    return Object.entries(STORY_TOOLS)
        .filter(([name]) => !only || only.includes(name))
        .map(([name, spec]) =>
            format === "anthropic"
                ? { name, description: spec.description, input_schema: jsonSchema(spec.input) }
                : { type: "function" as const, function: { name, description: spec.description, parameters: jsonSchema(spec.input) } },
        );
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Validates and runs a tool call; never throws (errors are returned for the model to read). */
export async function executeStoryTool(engine: StoryEngine, name: string, input: unknown): Promise<ToolResult> {
    const spec = STORY_TOOLS[name];
    if (!spec) return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` } };
    const parsed = spec.input.safeParse(input ?? {});
    if (!parsed.success) {
        const e = ValidationError.fromZod(`${name} input`, parsed.error);
        return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    try {
        return { ok: true, result: await spec.run(engine, parsed.data) };
    } catch (err) {
        if (err instanceof StoryEngineError) return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
        return { ok: false, error: { code: "INTERNAL", message: (err as Error).message } };
    }
}
