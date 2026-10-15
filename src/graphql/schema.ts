import { makeExecutableSchema } from "@graphql-tools/schema";
import DataLoader from "dataloader";
import { GraphQLError, type GraphQLSchema } from "graphql";
import type { Accessory, AnyEntity, CastMember, Character, EntityKind, EntityByKind, ReferenceImage, Render, Scene, Story } from "../domain/schemas.js";
import type { ImageSource, RenderOptions, StoryEngine } from "../engine.js";
import { StoryEngineError, type StoryErrorCode } from "../errors.js";
import { getStoryToolDefinitions, type ToolFormat } from "../llm/tools.js";
import type { ComposedPrompt } from "../prompt/composer.js";
import { toDataUri } from "../providers/http.js";
import { typeDefs } from "./typeDefs.js";

export interface StoryGraphQLOptions<TContext = unknown> {
    /** A single engine for every request... */
    engine?: StoryEngine;
    /** ...or one per request, e.g. scoped to a tenant's storage. */
    getEngine?: (context: TContext) => StoryEngine | Promise<StoryEngine>;
    /** Builds a public URL for a blob (e.g. served by the host server); default: storage's publicUrl. */
    blobUrl?: (key: string, context: TContext) => string | null | Promise<string | null>;
}

const TYPE_NAMES: Record<EntityKind, string> = {
    character: "Character",
    style: "Style",
    location: "Location",
    accessory: "Accessory",
    scene: "Scene",
    story: "Story",
};

const ERROR_CODES: Record<StoryErrorCode, string> = {
    NOT_FOUND: "NOT_FOUND",
    VALIDATION: "BAD_USER_INPUT",
    CONFLICT: "CONFLICT",
    IN_USE: "IN_USE",
    PROVIDER: "PROVIDER_ERROR",
    LIMIT: "RATE_LIMITED",
    CONFIG: "CONFIGURATION_ERROR",
};

function toGraphQLError(err: unknown): unknown {
    if (err instanceof StoryEngineError) {
        return new GraphQLError(err.message, {
            extensions: { code: ERROR_CODES[err.code], ...(err.details !== undefined ? { details: err.details } : {}) },
        });
    }
    return err;
}

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: unknown, info: unknown) => unknown;

function withErrors(map: Record<string, Resolver>): Record<string, Resolver> {
    return Object.fromEntries(
        Object.entries(map).map(([name, fn]) => [
            name,
            async (p: unknown, a: Record<string, unknown>, c: unknown, i: unknown) => {
                try {
                    return await fn(p, a, c, i);
                } catch (err) {
                    throw toGraphQLError(err);
                }
            },
        ]),
    );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively drops `null` (GraphQL "not provided") — used for create inputs and list items. */
function stripNulls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripNulls);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => [k, stripNulls(v)]),
    );
}

/** Keeps `null` at the top level and one level into nested objects (= "clear this field"). */
function cleanPatch(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
            if (isPlainObject(v)) {
                return [k, Object.fromEntries(Object.entries(v).map(([nk, nv]) => [nk, nv === null ? null : stripNulls(nv)]))];
            }
            return [k, v === null ? null : stripNulls(v)];
        }),
    );
}

const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));

function toImageSource(raw: Record<string, unknown>): ImageSource {
    const sources = (["base64", "dataUri", "url"] as const).filter((k) => typeof raw[k] === "string" && (raw[k] as string).length > 0);
    if (sources.length !== 1) {
        throw new GraphQLError("ImageInput requires exactly one of base64, dataUri, url", { extensions: { code: "BAD_USER_INPUT" } });
    }
    const key = sources[0]!;
    return { [key]: raw[key] } as ImageSource;
}

function mapComposed(c: ComposedPrompt) {
    return {
        prompt: c.prompt,
        mode: c.mode,
        generation: c.generation,
        references: c.references.map((r) => ({
            index: r.index,
            role: r.role,
            entityKind: r.entityKind,
            entityId: r.entityId,
            entityName: r.entityName,
            referenceId: r.reference?.id,
            renderId: r.renderId,
            label: r.reference?.label,
            view: r.reference?.view,
            description: r.description,
        })),
    };
}

interface StoredImageSource {
    key: string;
    mimeType: string;
    width?: number;
    height?: number;
}

type Loaders = { [K in EntityKind]: DataLoader<string, EntityByKind[K] | null> } & { render: DataLoader<string, Render | null> };

export function createStoryGraphQLSchema<TContext = unknown>(options: StoryGraphQLOptions<TContext>): GraphQLSchema {
    if (!options.engine && !options.getEngine) throw new Error("createStoryGraphQLSchema requires engine or getEngine");
    const eng = async (ctx: unknown): Promise<StoryEngine> => options.engine ?? options.getEngine!(ctx as TContext);

    // Per-request batching of id lookups (one getMany per kind instead of one get per field).
    const loaderCache = new WeakMap<object, Promise<Loaders>>();
    const buildLoaders = async (ctx: unknown): Promise<Loaders> => {
        const engine = await eng(ctx);
        const make = <K extends EntityKind | "render">(kind: K) =>
            new DataLoader<string, any>((ids) => engine.storage.records.getMany(kind, ids), { cache: true });
        return {
            character: make("character"),
            style: make("style"),
            location: make("location"),
            accessory: make("accessory"),
            scene: make("scene"),
            story: make("story"),
            render: make("render"),
        } as Loaders;
    };
    const loaders = (ctx: unknown): Promise<Loaders> => {
        if (typeof ctx !== "object" || ctx === null) return buildLoaders(ctx);
        let l = loaderCache.get(ctx);
        if (!l) {
            l = buildLoaders(ctx);
            loaderCache.set(ctx, l);
        }
        return l;
    };
    const lookup =
        <K extends EntityKind>(kind: K) =>
        async (id: string | undefined, ctx: unknown): Promise<EntityByKind[K] | null> =>
            id ? ((await (await loaders(ctx))[kind].load(id)) as EntityByKind[K] | null) : null;
    const lookupMany =
        <K extends EntityKind>(kind: K) =>
        async (ids: string[] | undefined, ctx: unknown): Promise<Array<EntityByKind[K]>> => {
            const items = await (await loaders(ctx))[kind].loadMany(ids ?? []);
            return items.filter((x): x is EntityByKind[K] => x !== null && !(x instanceof Error));
        };
    const lookupRender = async (id: string | undefined, ctx: unknown) => (id ? (await loaders(ctx)).render.load(id) : null);

    const page = (p: { items: unknown[]; nextCursor?: string }) => ({ items: p.items, nextCursor: p.nextCursor ?? null });
    const limit = (v: unknown, max = 200) => Math.max(1, Math.min(max, Number(v ?? 50)));

    const entityResolvers = {
        references: (e: AnyEntity) => e.references,
        renders: async (e: AnyEntity, a: Record<string, unknown>, ctx: unknown) =>
            page(await (await eng(ctx)).listRenders({ targetKind: e.kind, targetId: e.id, limit: limit(a.first, 100), cursor: opt(a.after) })),
    };

    const kinds: Array<[EntityKind, string, string]> = [
        ["character", "Character", "characters"],
        ["style", "Style", "styles"],
        ["location", "Location", "locations"],
        ["accessory", "Accessory", "accessories"],
        ["scene", "Scene", "scenes"],
        ["story", "Story", "stories"],
    ];

    const query: Record<string, Resolver> = {
        entity: async (_, a, ctx) => (await eng(ctx)).getEntity(a.kind as EntityKind, a.id as string),
        render: async (_, a, ctx) => {
            const engine = await eng(ctx);
            const r = await engine.getRender(a.id as string);
            return r && a.sync !== false ? engine.syncRender(r.id) : r;
        },
        renders: async (_, a, ctx) =>
            page(
                await (await eng(ctx)).listRenders({
                    targetKind: opt(a.targetKind),
                    targetId: opt(a.targetId),
                    status: opt(a.status),
                    limit: limit(a.first, 100),
                    cursor: opt(a.after),
                }),
            ),
        composeScenePrompt: async (_, a, ctx) => mapComposed(await (await eng(ctx)).composeScene(a.sceneId as string, stripNulls(a.options ?? {}) as RenderOptions)),
        composeEntityPreviewPrompt: async (_, a, ctx) =>
            mapComposed(await (await eng(ctx)).composeEntityPreview(a.kind as EntityKind, a.id as string, stripNulls(a.options ?? {}) as RenderOptions)),
        toolDefinitions: async (_, a) => JSON.stringify(getStoryToolDefinitions(String(a.format ?? "ANTHROPIC").toLowerCase() as ToolFormat)),
    };

    const mutation: Record<string, Resolver> = {
        addReferenceImage: async (_, a, ctx) => {
            const input = a.input as Record<string, unknown>;
            return (await eng(ctx)).addReference({
                kind: input.kind as EntityKind,
                entityId: input.entityId as string,
                image: toImageSource(input.image as Record<string, unknown>),
                label: opt(input.label),
                view: opt(input.view),
                notes: opt(input.notes),
                isPrimary: opt(input.isPrimary),
            });
        },
        updateReferenceImage: async (_, a, ctx) => {
            const { kind, entityId, referenceId, isPrimary, ...rest } = a.input as Record<string, unknown>;
            return (await eng(ctx)).updateReference(kind as EntityKind, entityId as string, referenceId as string, {
                ...(rest as { label?: string | null; view?: string | null; notes?: string | null }),
                ...(typeof isPrimary === "boolean" ? { isPrimary } : {}),
            });
        },
        removeReferenceImage: async (_, a, ctx) => (await eng(ctx)).removeReference(a.kind as EntityKind, a.entityId as string, a.referenceId as string),
        renderScene: async (_, a, ctx) => (await eng(ctx)).renderScene(a.sceneId as string, stripNulls(a.options ?? {}) as RenderOptions),
        renderEntityPreview: async (_, a, ctx) =>
            (await eng(ctx)).renderEntityPreview(a.kind as EntityKind, a.id as string, stripNulls(a.options ?? {}) as RenderOptions),
        refineRender: async (_, a, ctx) => (await eng(ctx)).refineRender(a.renderId as string, stripNulls(a.input) as never),
        upscaleRender: async (_, a, ctx) => (await eng(ctx)).upscaleRender(a.renderId as string, stripNulls(a.input ?? {}) as never),
        syncRender: async (_, a, ctx) => (await eng(ctx)).syncRender(a.id as string),
        syncPendingRenders: async (_, a, ctx) => (await eng(ctx)).syncPendingRenders({ limit: limit(a.limit, 200) }),
        cancelRender: async (_, a, ctx) => (await eng(ctx)).cancelRender(a.id as string),
        reviewRender: async (_, a, ctx) => (await eng(ctx)).reviewRender(a.id as string),
        selectSceneRender: async (_, a, ctx) => (await eng(ctx)).selectSceneRender(a.sceneId as string, (a.renderId ?? null) as string | null),
        deleteRender: async (_, a, ctx) => (await eng(ctx)).deleteRender(a.id as string),
        promoteRenderToReference: async (_, a, ctx) => {
            const { renderId, ...target } = stripNulls(a.input) as Record<string, unknown>;
            return (await eng(ctx)).promoteRenderToReference(renderId as string, target as never);
        },
    };

    for (const [kind, typeName, plural] of kinds) {
        query[kind] = async (_, a, ctx) => lookup(kind)(a.id as string, ctx);
        query[plural] = async (_, a, ctx) =>
            page(await (await eng(ctx)).entities(kind).list({ tag: opt(a.tag), storyId: opt(a.storyId), limit: limit(a.first), cursor: opt(a.after) }));
        mutation[`create${typeName}`] = async (_, a, ctx) => (await eng(ctx)).entities(kind).create(stripNulls(a.input) as never);
        mutation[`update${typeName}`] = async (_, a, ctx) =>
            (await eng(ctx))
                .entities(kind)
                .update(a.id as string, cleanPatch(a.input as Record<string, unknown>) as never, { expectedVersion: opt(a.expectedVersion) });
        mutation[`delete${typeName}`] = async (_, a, ctx) => (await eng(ctx)).entities(kind).delete(a.id as string, { force: a.force === true });
    }

    const blobUrl = async (key: string, ctx: unknown) =>
        options.blobUrl ? options.blobUrl(key, ctx as TContext) : (await eng(ctx)).blobPublicUrl(key);

    const resolvers = {
        EntityKind: { CHARACTER: "character", STYLE: "style", LOCATION: "location", ACCESSORY: "accessory", SCENE: "scene", STORY: "story" },
        RenderStatus: { QUEUED: "queued", RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed", CANCELED: "canceled" },
        RenderOperation: { GENERATE: "generate", REFINE: "refine", UPSCALE: "upscale" },
        RenderMode: { TEXT_TO_IMAGE: "text-to-image", REFERENCE_TO_IMAGE: "reference-to-image" },
        ReferenceRole: { ENTITY: "entity", CONTINUITY: "continuity", BASE: "base" },
        OutputFormat: { PNG: "png", JPEG: "jpeg", WEBP: "webp" },
        ResizeFit: { CONTAIN: "contain", COVER: "cover", FILL: "fill", INSIDE: "inside", OUTSIDE: "outside" },
        ResizeKernel: { NEAREST: "nearest", LANCZOS3: "lanczos3" },
        Entity: { __resolveType: (e: AnyEntity) => TYPE_NAMES[e.kind] },
        StoredImage: {
            url: (img: StoredImageSource, _: unknown, ctx: unknown) => blobUrl(img.key, ctx),
            dataUri: async (img: StoredImageSource, _: unknown, ctx: unknown) => {
                const blob = await (await eng(ctx)).getBlob(img.key);
                return blob ? toDataUri(blob.data, blob.contentType) : null;
            },
        },
        ReferenceImage: {
            image: (r: ReferenceImage): StoredImageSource => ({ key: r.blobKey, mimeType: r.mimeType, width: r.width, height: r.height }),
        },
        Character: {
            ...entityResolvers,
            appearance: (c: Character) => ({ ...c.appearance, distinguishingFeatures: c.appearance.distinguishingFeatures ?? [] }),
            defaultAccessories: (c: Character, _: unknown, ctx: unknown) => lookupMany("accessory")(c.defaultAccessoryIds, ctx),
        },
        Style: { ...entityResolvers },
        Location: { ...entityResolvers },
        Accessory: { ...entityResolvers, owner: (a: Accessory, _: unknown, ctx: unknown) => lookup("character")(a.ownerCharacterId, ctx) },
        CastMember: {
            character: (m: CastMember, _: unknown, ctx: unknown) => lookup("character")(m.characterId, ctx),
            accessoryIds: (m: CastMember) => m.accessoryIds ?? [],
            accessories: (m: CastMember, _: unknown, ctx: unknown) => lookupMany("accessory")(m.accessoryIds, ctx),
            includeDefaultAccessories: (m: CastMember) => m.includeDefaultAccessories !== false,
            referenceIds: (m: CastMember) => m.referenceIds ?? [],
        },
        Continuity: {
            fromPreviousScene: (c: Scene["continuity"]) => c.fromPreviousScene === true,
            sceneIds: (c: Scene["continuity"]) => c.sceneIds ?? [],
        },
        Scene: {
            ...entityResolvers,
            story: (s: Scene, _: unknown, ctx: unknown) => lookup("story")(s.storyId, ctx),
            effectiveStyle: async (s: Scene, _: unknown, ctx: unknown) => {
                if (s.styleId) return lookup("style")(s.styleId, ctx);
                const story = await lookup("story")(s.storyId, ctx);
                return lookup("style")(story?.styleId, ctx);
            },
            location: (s: Scene, _: unknown, ctx: unknown) => lookup("location")(s.locationId, ctx),
            accessories: (s: Scene, _: unknown, ctx: unknown) => lookupMany("accessory")(s.accessoryIds, ctx),
            selectedRender: (s: Scene, _: unknown, ctx: unknown) => lookupRender(s.selectedRenderId, ctx),
        },
        Story: {
            ...entityResolvers,
            style: (s: Story, _: unknown, ctx: unknown) => lookup("style")(s.styleId, ctx),
            scenes: async (s: Story, _: unknown, ctx: unknown) => (await eng(ctx)).listStoryScenes(s.id),
        },
        RenderTarget: {
            entity: (t: { kind: EntityKind; id: string }, _: unknown, ctx: unknown) => lookup(t.kind)(t.id, ctx),
        },
        Render: {
            target: (r: Render) => ({ kind: r.targetKind, id: r.targetId }),
            parent: (r: Render, _: unknown, ctx: unknown) => lookupRender(r.parentRenderId, ctx),
            image: (r: Render): StoredImageSource | null => (r.image ? { key: r.image.blobKey, ...r.image } : null),
        },
        Query: withErrors(query),
        Mutation: withErrors(mutation),
    };

    return makeExecutableSchema({ typeDefs, resolvers });
}
