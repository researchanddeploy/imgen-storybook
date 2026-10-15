import { z } from "zod";

/**
 * Domain model for illustrated stories.
 *
 * Every user-defined thing (character, style, location, accessory, scene, story)
 * is an "entity". Entities carry user-provided reference images, which are the
 * single source of visual consistency across illustrations. A "render" is the
 * record of one generated image.
 *
 * For each kind there are three schemas:
 *  - `XxxCreateSchema` — input for creating (only `name` required),
 *  - `XxxPatchSchema`  — input for updating (every field optional, `null` clears it),
 *  - `XxxSchema`       — the stored record (defaults applied).
 */

export const ENTITY_KINDS = ["character", "style", "location", "accessory", "scene", "story"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type RecordKind = EntityKind | "render";

export const IdSchema = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "id must be 1-64 chars of [A-Za-z0-9_-]");

const text = (max = 4000) => z.string().trim().max(max);
const shortText = () => text(500);
const textList = (maxItems = 50) => z.array(z.string().trim().min(1).max(500)).max(maxItems);
const idList = (maxItems = 50) => z.array(IdSchema).max(maxItems);
const tags = z.array(z.string().trim().min(1).max(64)).max(30);

export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Generation defaults that can be set on a style, story or scene (later wins). */
export const GenerationSettingsSchema = z
    .object({
        /** FAL endpoint for text-to-image (no references). */
        endpoint: z.string().trim().min(1).max(200),
        /** FAL endpoint for image-conditioned generation (with references). */
        editEndpoint: z.string().trim().min(1).max(200),
        aspectRatio: z.string().trim().regex(/^(auto|\d{1,2}:\d{1,2})$/, "aspectRatio must look like 4:3 or auto"),
        resolution: z.string().trim().min(1).max(10),
        outputFormat: z.enum(OUTPUT_FORMATS),
    })
    .partial();
export type GenerationSettings = z.output<typeof GenerationSettingsSchema>;

export const ReferenceImageSchema = z.object({
    id: IdSchema,
    blobKey: z.string().min(1),
    mimeType: z.string().min(1),
    /** Free-form label shown to the model, e.g. "Ala, front view". */
    label: shortText().optional(),
    /** What the image shows: "front", "side", "back", "full body", "face", "detail", "style sample"... */
    view: text(100).optional(),
    notes: text(1000).optional(),
    /** Primary references are always sent first and survive reference-budget trimming. */
    isPrimary: z.boolean(),
    createdAt: z.string(),
});
export type ReferenceImage = z.output<typeof ReferenceImageSchema>;

// ---------------------------------------------------------------------------
// Field shapes (no defaults; shared by create/patch/record schemas)
// ---------------------------------------------------------------------------

const baseFields = {
    name: z.string().trim().min(1).max(200),
    description: text(),
    tags,
    /** Extra text appended verbatim whenever this entity is described in a prompt. */
    promptHint: text(2000),
};

export const AppearanceSchema = z
    .object({
        species: shortText(),
        age: shortText(),
        gender: shortText(),
        bodyType: shortText(),
        height: shortText(),
        skin: shortText(),
        hair: shortText(),
        eyes: shortText(),
        face: shortText(),
        distinguishingFeatures: textList(20),
    })
    .partial();

const characterFields = {
    ...baseFields,
    appearance: AppearanceSchema,
    /** Default outfit; a scene can override it per cast member. */
    outfit: text(1000),
    personality: text(1000),
    /** Accessories this character carries in every scene unless the scene opts out. */
    defaultAccessoryIds: idList(),
};

const styleFields = {
    ...baseFields,
    /** e.g. "soft watercolor children's book illustration". */
    medium: text(1000),
    palette: textList(30),
    lineWork: shortText(),
    shading: shortText(),
    lighting: shortText(),
    texture: shortText(),
    mood: shortText(),
    /** Things to avoid, e.g. "photorealism", "harsh shadows". */
    negative: textList(),
    /** By default prompts forbid any text/lettering in the image. */
    allowText: z.boolean(),
    generation: GenerationSettingsSchema,
};

const locationFields = {
    ...baseFields,
    setting: text(1000),
    era: shortText(),
    defaultTimeOfDay: shortText(),
    defaultWeather: shortText(),
    keyFeatures: textList(),
    palette: textList(30),
};

const accessoryFields = {
    ...baseFields,
    /** "prop", "clothing", "vehicle", "creature", "magic item"... */
    category: text(100),
    material: shortText(),
    colors: textList(20),
    size: shortText(),
    ownerCharacterId: IdSchema,
};

export const CastMemberSchema = z.object({
    characterId: IdSchema,
    action: text(1000).optional(),
    expression: shortText().optional(),
    pose: shortText().optional(),
    /** e.g. "left foreground", "center", "background right". */
    position: shortText().optional(),
    /** Overrides the character's default outfit for this scene. */
    outfit: text(1000).optional(),
    /** Accessories held/worn in this scene (in addition to defaults). */
    accessoryIds: idList().optional(),
    /** Set to false to drop the character's default accessories in this scene. */
    includeDefaultAccessories: z.boolean().optional(),
});
export type CastMember = z.output<typeof CastMemberSchema>;

export const CameraSchema = z
    .object({
        /** "wide", "medium", "close-up", "extreme close-up"... */
        shot: shortText(),
        /** "eye level", "low angle", "bird's-eye"... */
        angle: shortText(),
        lens: shortText(),
        composition: text(1000),
    })
    .partial();

const sceneFields = {
    ...baseFields,
    storyId: IdSchema,
    styleId: IdSchema,
    locationId: IdSchema,
    cast: z.array(CastMemberSchema).max(12),
    /** Scene-level props not tied to a character. */
    accessoryIds: idList(),
    camera: CameraSchema,
    timeOfDay: shortText(),
    weather: shortText(),
    lighting: shortText(),
    mood: shortText(),
    /** Story text for this page. Stored for the app, not used in prompts. */
    narrative: text(20000),
    negative: textList(),
    generation: GenerationSettingsSchema,
};

const storyFields = {
    ...baseFields,
    synopsis: text(20000),
    /** e.g. "children 4-7". Mentioned in prompts as a tone hint. */
    audience: shortText(),
    styleId: IdSchema,
    /** Display order of the story's scenes (scenes join a story via `scene.storyId`). */
    sceneOrder: idList(1000),
    generation: GenerationSettingsSchema,
};

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

function createSchema<S extends z.ZodRawShape & { name: z.ZodString }>(shape: S) {
    return z
        .object(shape)
        .partial()
        .extend({ name: shape.name, id: IdSchema.optional() })
        .strict();
}

type Nullable<T> = { [K in keyof T]?: T[K] | null };

/** Nested objects accept `null` per field too, so a patch can clear e.g. `appearance.hair`. */
function nullableFields(obj: z.ZodObject<z.ZodRawShape>): z.ZodTypeAny {
    const entries = Object.entries(obj.shape).map(([k, v]) => [k, (v as z.ZodTypeAny).nullable()]);
    return z.object(Object.fromEntries(entries)).strict();
}

function patchSchema<S extends z.ZodRawShape>(shape: S) {
    const entries = Object.entries(shape).map(([k, v]) => {
        const field = v instanceof z.ZodObject ? nullableFields(v) : (v as z.ZodTypeAny);
        return [k, field.nullable().optional()];
    });
    return z.object(Object.fromEntries(entries)).strict() as unknown as z.ZodType<Nullable<z.output<z.ZodObject<S>>>>;
}

export const CharacterCreateSchema = createSchema(characterFields);
export const CharacterPatchSchema = patchSchema(characterFields);
export const StyleCreateSchema = createSchema(styleFields);
export const StylePatchSchema = patchSchema(styleFields);
export const LocationCreateSchema = createSchema(locationFields);
export const LocationPatchSchema = patchSchema(locationFields);
export const AccessoryCreateSchema = createSchema(accessoryFields);
export const AccessoryPatchSchema = patchSchema(accessoryFields);
export const SceneCreateSchema = createSchema(sceneFields);
export const ScenePatchSchema = patchSchema(sceneFields);
export const StoryCreateSchema = createSchema(storyFields);
export const StoryPatchSchema = patchSchema(storyFields);

export type CharacterCreate = z.input<typeof CharacterCreateSchema>;
export type StyleCreate = z.input<typeof StyleCreateSchema>;
export type LocationCreate = z.input<typeof LocationCreateSchema>;
export type AccessoryCreate = z.input<typeof AccessoryCreateSchema>;
export type SceneCreate = z.input<typeof SceneCreateSchema>;
export type StoryCreate = z.input<typeof StoryCreateSchema>;

export type CharacterPatch = z.input<typeof CharacterPatchSchema>;
export type StylePatch = z.input<typeof StylePatchSchema>;
export type LocationPatch = z.input<typeof LocationPatchSchema>;
export type AccessoryPatch = z.input<typeof AccessoryPatchSchema>;
export type ScenePatch = z.input<typeof ScenePatchSchema>;
export type StoryPatch = z.input<typeof StoryPatchSchema>;

// ---------------------------------------------------------------------------
// Stored record schemas
// ---------------------------------------------------------------------------

const recordBase = {
    id: IdSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
};

const entityDefaults = {
    description: text().default(""),
    tags: tags.default([]),
    references: z.array(ReferenceImageSchema).max(50).default([]),
};

export const CharacterSchema = z.object({
    ...recordBase,
    ...z.object(characterFields).partial().shape,
    ...entityDefaults,
    kind: z.literal("character"),
    name: characterFields.name,
    appearance: AppearanceSchema.default({}),
    defaultAccessoryIds: idList().default([]),
});

export const StyleSchema = z.object({
    ...recordBase,
    ...z.object(styleFields).partial().shape,
    ...entityDefaults,
    kind: z.literal("style"),
    name: styleFields.name,
    palette: textList(30).default([]),
    negative: textList().default([]),
    allowText: z.boolean().default(false),
    generation: GenerationSettingsSchema.default({}),
});

export const LocationSchema = z.object({
    ...recordBase,
    ...z.object(locationFields).partial().shape,
    ...entityDefaults,
    kind: z.literal("location"),
    name: locationFields.name,
    keyFeatures: textList().default([]),
    palette: textList(30).default([]),
});

export const AccessorySchema = z.object({
    ...recordBase,
    ...z.object(accessoryFields).partial().shape,
    ...entityDefaults,
    kind: z.literal("accessory"),
    name: accessoryFields.name,
    colors: textList(20).default([]),
});

export const SceneSchema = z.object({
    ...recordBase,
    ...z.object(sceneFields).partial().shape,
    ...entityDefaults,
    kind: z.literal("scene"),
    name: sceneFields.name,
    cast: z.array(CastMemberSchema).max(12).default([]),
    accessoryIds: idList().default([]),
    camera: CameraSchema.default({}),
    negative: textList().default([]),
    generation: GenerationSettingsSchema.default({}),
    /** The render chosen as this scene's illustration. */
    selectedRenderId: IdSchema.optional(),
});

export const StorySchema = z.object({
    ...recordBase,
    ...z.object(storyFields).partial().shape,
    ...entityDefaults,
    kind: z.literal("story"),
    name: storyFields.name,
    sceneOrder: idList(1000).default([]),
    generation: GenerationSettingsSchema.default({}),
});

export type Character = z.output<typeof CharacterSchema>;
export type Style = z.output<typeof StyleSchema>;
export type Location = z.output<typeof LocationSchema>;
export type Accessory = z.output<typeof AccessorySchema>;
export type Scene = z.output<typeof SceneSchema>;
export type Story = z.output<typeof StorySchema>;

export const RenderReferenceSchema = z.object({
    /** 1-based position in the image list sent to the model ("Image 1", "Image 2"...). */
    index: z.number().int().positive(),
    entityKind: z.enum(ENTITY_KINDS),
    entityId: IdSchema,
    referenceId: IdSchema,
    label: z.string().optional(),
});
export type RenderReference = z.output<typeof RenderReferenceSchema>;

export const RenderSchema = z.object({
    ...recordBase,
    kind: z.literal("render"),
    target: z.object({ kind: z.enum(ENTITY_KINDS), id: IdSchema }),
    status: z.enum(["succeeded", "failed"]),
    mode: z.enum(["text-to-image", "reference-to-image"]),
    prompt: z.string(),
    references: z.array(RenderReferenceSchema),
    provider: z.string(),
    endpoint: z.string(),
    params: z.object({
        aspectRatio: z.string(),
        resolution: z.string(),
        outputFormat: z.enum(OUTPUT_FORMATS),
    }),
    image: z
        .object({
            blobKey: z.string(),
            mimeType: z.string(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
        })
        .optional(),
    /** Provider-hosted URL of the raw output (temporary on most providers). */
    sourceUrl: z.string().optional(),
    error: z.string().optional(),
});
export type Render = z.output<typeof RenderSchema>;

export interface EntityByKind {
    character: Character;
    style: Style;
    location: Location;
    accessory: Accessory;
    scene: Scene;
    story: Story;
}
export interface RecordByKind extends EntityByKind {
    render: Render;
}
export type AnyEntity = EntityByKind[EntityKind];
export type AnyRecord = RecordByKind[RecordKind];

export interface CreateInputByKind {
    character: CharacterCreate;
    style: StyleCreate;
    location: LocationCreate;
    accessory: AccessoryCreate;
    scene: SceneCreate;
    story: StoryCreate;
}
export interface PatchInputByKind {
    character: CharacterPatch;
    style: StylePatch;
    location: LocationPatch;
    accessory: AccessoryPatch;
    scene: ScenePatch;
    story: StoryPatch;
}

export const ENTITY_SCHEMAS = {
    character: { create: CharacterCreateSchema, patch: CharacterPatchSchema, record: CharacterSchema },
    style: { create: StyleCreateSchema, patch: StylePatchSchema, record: StyleSchema },
    location: { create: LocationCreateSchema, patch: LocationPatchSchema, record: LocationSchema },
    accessory: { create: AccessoryCreateSchema, patch: AccessoryPatchSchema, record: AccessorySchema },
    scene: { create: SceneCreateSchema, patch: ScenePatchSchema, record: SceneSchema },
    story: { create: StoryCreateSchema, patch: StoryPatchSchema, record: StorySchema },
} as const;

export function isEntityKind(value: unknown): value is EntityKind {
    return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}
