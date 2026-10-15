import sharp from "sharp";
import type { ZodType } from "zod";
import {
    ENTITY_SCHEMAS,
    type Accessory,
    type AnyEntity,
    type Character,
    type CreateInputByKind,
    type EntityByKind,
    type EntityKind,
    type GenerationSettings,
    type Location,
    type PatchInputByKind,
    type RecordByKind,
    type ReferenceImage,
    type Render,
    RenderSchema,
    type Scene,
    type Story,
    type Style,
} from "./domain/schemas.js";
import { ConflictError, InUseError, NotFoundError, ProviderError, ValidationError } from "./errors.js";
import { newId, nowIso } from "./ids.js";
import { postProcess, imageInfo, type PostProcessOptions } from "./postprocess/index.js";
import {
    accessoryIdsForCastMember,
    composeEntityPreviewPrompt,
    composeScenePrompt,
    type ComposedPrompt,
    type ReferenceBudget,
    type ResolvedGeneration,
    type SceneContext,
} from "./prompt/composer.js";
import { toDataUri } from "./providers/http.js";
import type { BackgroundRemover, ImageProvider, ProviderImageInput } from "./providers/types.js";
import { extFromMime, type StorageAdapter, type StoredBlob } from "./storage/types.js";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface StoryEngineOptions {
    storage: StorageAdapter;
    provider: ImageProvider;
    /** Needed only for `postProcess.removeBackground`. */
    backgroundRemover?: BackgroundRemover;
    /** Engine-level generation defaults (lowest priority). */
    defaults?: Partial<ResolvedGeneration>;
    referenceBudget?: Partial<ReferenceBudget>;
    /**
     * How reference images reach the provider: inline `data-uri` (default, always works)
     * or the blob store's `public-url` (smaller requests; the URL must be reachable by
     * the provider, so not localhost).
     */
    referenceTransport?: "data-uri" | "public-url";
    /** Max size of a single uploaded reference image. Default 15 MB. */
    maxReferenceBytes?: number;
    /**
     * Reference images given as URLs are fetched server-side. That is an SSRF vector,
     * so URL sources are rejected unless this hook approves the URL.
     */
    allowReferenceUrl?: (url: URL) => boolean | Promise<boolean>;
}

export type ImageSource =
    | { data: Uint8Array }
    | { base64: string }
    | { dataUri: string }
    | { url: string };

export interface AddReferenceInput {
    kind: EntityKind;
    entityId: string;
    image: ImageSource;
    label?: string;
    view?: string;
    notes?: string;
    /** Defaults to true for an entity's first reference. */
    isPrimary?: boolean;
}

export interface UpdateReferenceInput {
    label?: string | null;
    view?: string | null;
    notes?: string | null;
    isPrimary?: boolean;
}

export interface ComposeRequestOptions {
    /** Per-call generation overrides (highest priority). */
    generation?: GenerationSettings;
    extraInstructions?: string;
    referenceBudget?: Partial<ReferenceBudget>;
    /** Entity previews only: replaces the default framing sentence. */
    framing?: string;
}

export interface RenderOptions extends ComposeRequestOptions {
    /** Number of candidate images (1-4). Each becomes its own Render. */
    count?: number;
    postProcess?: PostProcessOptions;
    providerOptions?: Record<string, unknown>;
}

export interface DeleteOptions {
    /** Detach the entity from everything that references it instead of failing. */
    force?: boolean;
}

export interface ListFilter {
    tag?: string;
    /** Scenes only. */
    storyId?: string;
}

const DEFAULT_GENERATION: ResolvedGeneration = { aspectRatio: "4:3", resolution: "1K", outputFormat: "png" };
const DEFAULT_BUDGET: ReferenceBudget = { maxReferences: 10, maxPerEntity: 3 };
const ACCEPTED_FORMATS: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse<T>(schema: ZodType<T>, value: unknown, context: string): T {
    const r = schema.safeParse(value);
    if (!r.success) throw ValidationError.fromZod(context, r.error);
    return r.data;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `null` removes a field; plain objects are merged one level deep (where `null` removes
 * the nested field); arrays are replaced.
 */
function mergePatch<T extends object>(existing: T, patch: Record<string, unknown>): T {
    const out = { ...existing } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) {
            delete out[k];
        } else if (isPlainObject(v)) {
            const nested: Record<string, unknown> = isPlainObject(out[k]) ? { ...out[k] } : {};
            for (const [nk, nv] of Object.entries(v)) {
                if (nv === null) delete nested[nk];
                else if (nv !== undefined) nested[nk] = nv;
            }
            out[k] = nested;
        } else {
            out[k] = v;
        }
    }
    return out as T;
}

function dedupe<T>(items: T[]): T[] {
    return [...new Set(items)];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class StoryEngine {
    readonly storage: StorageAdapter;
    readonly provider: ImageProvider;
    private readonly options: StoryEngineOptions;
    private readonly defaults: ResolvedGeneration;
    private readonly budget: ReferenceBudget;

    readonly characters: EntityService<"character">;
    readonly styles: EntityService<"style">;
    readonly locations: EntityService<"location">;
    readonly accessories: EntityService<"accessory">;
    readonly scenes: EntityService<"scene">;
    readonly stories: EntityService<"story">;

    constructor(options: StoryEngineOptions) {
        this.options = options;
        this.storage = options.storage;
        this.provider = options.provider;
        this.defaults = { ...DEFAULT_GENERATION, ...options.defaults };
        this.budget = { ...DEFAULT_BUDGET, ...options.referenceBudget };
        this.characters = new EntityService(this, "character");
        this.styles = new EntityService(this, "style");
        this.locations = new EntityService(this, "location");
        this.accessories = new EntityService(this, "accessory");
        this.scenes = new EntityService(this, "scene");
        this.stories = new EntityService(this, "story");
    }

    entities<K extends EntityKind>(kind: K): EntityService<K> {
        const map = {
            character: this.characters,
            style: this.styles,
            location: this.locations,
            accessory: this.accessories,
            scene: this.scenes,
            story: this.stories,
        } as const;
        return map[kind] as unknown as EntityService<K>;
    }

    // -- generic record access ------------------------------------------------

    async getEntity<K extends EntityKind>(kind: K, id: string): Promise<EntityByKind[K] | null> {
        return this.storage.records.get(kind, id);
    }

    async requireEntity<K extends EntityKind>(kind: K, id: string): Promise<EntityByKind[K]> {
        const e = await this.getEntity(kind, id);
        if (!e) throw new NotFoundError(kind, id);
        return e;
    }

    /** @internal */
    async saveEntity<K extends EntityKind>(kind: K, entity: EntityByKind[K]): Promise<EntityByKind[K]> {
        const record = parse(ENTITY_SCHEMAS[kind].record as unknown as ZodType<EntityByKind[K]>, entity, kind);
        await this.putEntity(kind, record);
        return record;
    }

    /** @internal */
    async putEntity<K extends EntityKind>(kind: K, record: EntityByKind[K]): Promise<void> {
        await this.storage.records.put(kind, record as RecordByKind[K]);
    }

    // -- integrity ------------------------------------------------------------

    /** @internal Ensures every id the entity points to exists. */
    async assertLinks(entity: AnyEntity): Promise<void> {
        const checks: Array<[EntityKind, string | undefined]> = [];
        switch (entity.kind) {
            case "character":
                entity.defaultAccessoryIds.forEach((id) => checks.push(["accessory", id]));
                break;
            case "accessory":
                checks.push(["character", entity.ownerCharacterId]);
                break;
            case "scene":
                checks.push(["story", entity.storyId], ["style", entity.styleId], ["location", entity.locationId]);
                entity.cast.forEach((m) => {
                    checks.push(["character", m.characterId]);
                    m.accessoryIds?.forEach((id) => checks.push(["accessory", id]));
                });
                entity.accessoryIds.forEach((id) => checks.push(["accessory", id]));
                break;
            case "story":
                checks.push(["style", entity.styleId]);
                break;
            case "style":
            case "location":
                break;
        }
        const missing: string[] = [];
        for (const [kind, id] of checks) {
            if (id && !(await this.getEntity(kind, id))) missing.push(`${kind}:${id}`);
        }
        if (missing.length) {
            throw new ValidationError(`${entity.kind} "${entity.id}" references missing entities: ${dedupe(missing).join(", ")}`, { missing });
        }
        if (entity.kind === "story") {
            const scenes = await this.storage.records.list("scene");
            const own = new Set(scenes.filter((s) => s.storyId === entity.id).map((s) => s.id));
            const foreign = entity.sceneOrder.filter((id) => !own.has(id));
            if (foreign.length) {
                throw new ValidationError(`sceneOrder contains scenes that do not belong to story "${entity.id}": ${foreign.join(", ")}`);
            }
        }
    }

    /** Entities that reference the given one. */
    async findUsages(kind: EntityKind, id: string): Promise<Array<{ kind: EntityKind; id: string }>> {
        const out: Array<{ kind: EntityKind; id: string }> = [];
        const scenes = await this.storage.records.list("scene");
        switch (kind) {
            case "character": {
                scenes.filter((s) => s.cast.some((m) => m.characterId === id)).forEach((s) => out.push({ kind: "scene", id: s.id }));
                const accessories = await this.storage.records.list("accessory");
                accessories.filter((a) => a.ownerCharacterId === id).forEach((a) => out.push({ kind: "accessory", id: a.id }));
                break;
            }
            case "accessory": {
                const characters = await this.storage.records.list("character");
                characters.filter((c) => c.defaultAccessoryIds.includes(id)).forEach((c) => out.push({ kind: "character", id: c.id }));
                scenes
                    .filter((s) => s.accessoryIds.includes(id) || s.cast.some((m) => m.accessoryIds?.includes(id)))
                    .forEach((s) => out.push({ kind: "scene", id: s.id }));
                break;
            }
            case "style": {
                scenes.filter((s) => s.styleId === id).forEach((s) => out.push({ kind: "scene", id: s.id }));
                const stories = await this.storage.records.list("story");
                stories.filter((s) => s.styleId === id).forEach((s) => out.push({ kind: "story", id: s.id }));
                break;
            }
            case "location":
                scenes.filter((s) => s.locationId === id).forEach((s) => out.push({ kind: "scene", id: s.id }));
                break;
            case "story":
                scenes.filter((s) => s.storyId === id).forEach((s) => out.push({ kind: "scene", id: s.id }));
                break;
            case "scene":
                break;
        }
        return out;
    }

    /** @internal Removes every pointer to the entity from its dependents. */
    async detach(kind: EntityKind, id: string): Promise<void> {
        for (const usage of await this.findUsages(kind, id)) {
            const dep = await this.requireEntity(usage.kind, usage.id);
            const d = dep as AnyEntity & Record<string, unknown>;
            switch (kind) {
                case "character":
                    if (dep.kind === "scene") dep.cast = dep.cast.filter((m) => m.characterId !== id);
                    if (dep.kind === "accessory") delete d.ownerCharacterId;
                    break;
                case "accessory":
                    if (dep.kind === "character") dep.defaultAccessoryIds = dep.defaultAccessoryIds.filter((a) => a !== id);
                    if (dep.kind === "scene") {
                        dep.accessoryIds = dep.accessoryIds.filter((a) => a !== id);
                        dep.cast = dep.cast.map((m) => (m.accessoryIds ? { ...m, accessoryIds: m.accessoryIds.filter((a) => a !== id) } : m));
                    }
                    break;
                case "style":
                    delete d.styleId;
                    break;
                case "location":
                    delete d.locationId;
                    break;
                case "story":
                    delete d.storyId;
                    break;
                case "scene":
                    break;
            }
            dep.updatedAt = nowIso();
            await this.saveEntity(dep.kind, dep);
        }
    }

    // -- stories & scenes -----------------------------------------------------

    /** Scenes of a story in display order (`sceneOrder` first, then by creation time). */
    async listStoryScenes(storyId: string): Promise<Scene[]> {
        const story = await this.requireEntity("story", storyId);
        const scenes = (await this.storage.records.list("scene")).filter((s) => s.storyId === storyId);
        const rank = new Map(story.sceneOrder.map((id, i) => [id, i]));
        return scenes.sort((a, b) => {
            const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            return ra !== rb ? ra - rb : a.createdAt.localeCompare(b.createdAt);
        });
    }

    /** @internal Keeps `story.sceneOrder` in sync when a scene joins or leaves a story. */
    async syncSceneMembership(sceneId: string, fromStoryId: string | undefined, toStoryId: string | undefined): Promise<void> {
        if (fromStoryId === toStoryId) return;
        if (fromStoryId) {
            const from = await this.getEntity("story", fromStoryId);
            if (from) {
                from.sceneOrder = from.sceneOrder.filter((id) => id !== sceneId);
                from.updatedAt = nowIso();
                await this.saveEntity("story", from);
            }
        }
        if (toStoryId) {
            const to = await this.requireEntity("story", toStoryId);
            if (!to.sceneOrder.includes(sceneId)) {
                to.sceneOrder = [...to.sceneOrder, sceneId];
                to.updatedAt = nowIso();
                await this.saveEntity("story", to);
            }
        }
    }

    // -- reference images -----------------------------------------------------

    private async readImageSource(source: ImageSource): Promise<Buffer> {
        if ("data" in source) return Buffer.from(source.data);
        if ("base64" in source) return Buffer.from(source.base64, "base64");
        if ("dataUri" in source) {
            const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(source.dataUri);
            if (!m) throw new ValidationError("dataUri is not a valid data: URI");
            return m[1] ? Buffer.from(m[2] ?? "", "base64") : Buffer.from(decodeURIComponent(m[2] ?? ""));
        }
        let url: URL;
        try {
            url = new URL(source.url);
        } catch {
            throw new ValidationError(`Invalid image URL: ${source.url}`);
        }
        if (!this.options.allowReferenceUrl || !(await this.options.allowReferenceUrl(url))) {
            throw new ValidationError("Reference images from URLs are disabled (configure allowReferenceUrl)");
        }
        const res = await fetch(url);
        if (!res.ok) throw new ValidationError(`Failed to fetch reference image (${res.status}): ${url.href}`);
        return Buffer.from(await res.arrayBuffer());
    }

    private async decodeImage(data: Buffer): Promise<{ data: Buffer; mimeType: string }> {
        const max = this.options.maxReferenceBytes ?? 15 * 1024 * 1024;
        if (data.length === 0) throw new ValidationError("Reference image is empty");
        if (data.length > max) throw new ValidationError(`Reference image exceeds ${max} bytes`);
        let format: string | undefined;
        try {
            format = (await sharp(data).metadata()).format;
        } catch {
            throw new ValidationError("Reference image could not be decoded");
        }
        const mimeType = format ? ACCEPTED_FORMATS[format] : undefined;
        if (!mimeType) throw new ValidationError(`Unsupported reference image format: ${format ?? "unknown"} (use png, jpeg or webp)`);
        return { data, mimeType };
    }

    async addReference(input: AddReferenceInput): Promise<ReferenceImage> {
        const entity = await this.requireEntity(input.kind, input.entityId);
        const { data, mimeType } = await this.decodeImage(await this.readImageSource(input.image));
        const id = newId("reference");
        const blobKey = `references/${entity.kind}/${entity.id}/${id}.${extFromMime(mimeType)}`;
        const isPrimary = input.isPrimary ?? entity.references.length === 0;

        const ref: ReferenceImage = {
            id,
            blobKey,
            mimeType,
            isPrimary,
            createdAt: nowIso(),
            ...(input.label ? { label: input.label } : {}),
            ...(input.view ? { view: input.view } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
        };
        const references = isPrimary ? entity.references.map((r) => ({ ...r, isPrimary: false })) : entity.references;
        entity.references = [...references, ref];
        entity.updatedAt = nowIso();

        await this.storage.blobs.put(blobKey, data, mimeType);
        try {
            await this.saveEntity(entity.kind, entity);
        } catch (err) {
            await this.storage.blobs.delete(blobKey);
            throw err;
        }
        return ref;
    }

    async updateReference(kind: EntityKind, entityId: string, referenceId: string, patch: UpdateReferenceInput): Promise<ReferenceImage> {
        const entity = await this.requireEntity(kind, entityId);
        const existing = entity.references.find((r) => r.id === referenceId);
        if (!existing) throw new NotFoundError("reference", referenceId);
        const { isPrimary, ...rest } = patch;
        const updated = mergePatch(existing, rest);
        if (isPrimary !== undefined) updated.isPrimary = isPrimary;
        entity.references = entity.references.map((r) =>
            r.id === referenceId ? updated : isPrimary ? { ...r, isPrimary: false } : r,
        );
        entity.updatedAt = nowIso();
        await this.saveEntity(entity.kind, entity);
        return updated;
    }

    async removeReference(kind: EntityKind, entityId: string, referenceId: string): Promise<boolean> {
        const entity = await this.requireEntity(kind, entityId);
        const ref = entity.references.find((r) => r.id === referenceId);
        if (!ref) return false;
        let remaining = entity.references.filter((r) => r.id !== referenceId);
        if (ref.isPrimary && remaining.length > 0 && !remaining.some((r) => r.isPrimary)) {
            remaining = remaining.map((r, i) => (i === 0 ? { ...r, isPrimary: true } : r));
        }
        entity.references = remaining;
        entity.updatedAt = nowIso();
        await this.saveEntity(entity.kind, entity);
        await this.storage.blobs.delete(ref.blobKey);
        return true;
    }

    async getBlob(key: string): Promise<StoredBlob | null> {
        return this.storage.blobs.get(key);
    }

    async blobPublicUrl(key: string): Promise<string | null> {
        return (await this.storage.blobs.publicUrl?.(key)) ?? null;
    }

    // -- prompt composition ---------------------------------------------------

    private composeOptions(opts: ComposeRequestOptions) {
        return {
            budget: { ...this.budget, ...opts.referenceBudget },
            defaults: this.defaults,
            overrides: opts.generation,
            extraInstructions: opts.extraInstructions,
        };
    }

    async loadSceneContext(scene: Scene): Promise<SceneContext> {
        const story = scene.storyId ? ((await this.getEntity("story", scene.storyId)) ?? undefined) : undefined;
        const styleId = scene.styleId ?? story?.styleId;
        const style = styleId ? ((await this.getEntity("style", styleId)) ?? undefined) : undefined;
        const location = scene.locationId ? ((await this.getEntity("location", scene.locationId)) ?? undefined) : undefined;

        const characters = new Map<string, Character>();
        for (const m of scene.cast) {
            const c = await this.getEntity("character", m.characterId);
            if (c) characters.set(c.id, c);
        }
        const accessoryIds = dedupe([
            ...scene.cast.flatMap((m) => accessoryIdsForCastMember(m, characters.get(m.characterId))),
            ...scene.accessoryIds,
        ]);
        const accessories = new Map<string, Accessory>();
        for (const id of accessoryIds) {
            const a = await this.getEntity("accessory", id);
            if (a) accessories.set(a.id, a);
        }
        return { scene, story, style, location, characters, accessories };
    }

    /** Dry run: the exact prompt and reference list a render of this scene would use. */
    async composeScene(sceneId: string, opts: ComposeRequestOptions = {}): Promise<ComposedPrompt> {
        const scene = await this.requireEntity("scene", sceneId);
        return composeScenePrompt(await this.loadSceneContext(scene), this.composeOptions(opts));
    }

    /** Dry run for an entity preview (character design, object, location, style sample, story cover). */
    async composeEntityPreview(kind: EntityKind, id: string, opts: ComposeRequestOptions & { styleId?: string } = {}): Promise<ComposedPrompt> {
        if (kind === "scene") throw new ValidationError("Use composeScene/renderScene for scenes");
        const entity = await this.requireEntity(kind, id);

        const styleId = opts.styleId ?? (entity.kind === "story" ? entity.styleId : undefined);
        const style: Style | undefined = styleId ? await this.requireEntity("style", styleId) : undefined;

        let accessories: Accessory[] = [];
        let characters: Character[] = [];
        if (entity.kind === "character") {
            accessories = (await Promise.all(entity.defaultAccessoryIds.map((a) => this.getEntity("accessory", a)))).filter(
                (a): a is Accessory => a !== null,
            );
        }
        if (entity.kind === "story") {
            const castIds = dedupe((await this.listStoryScenes(entity.id)).flatMap((s) => s.cast.map((m) => m.characterId)));
            characters = (await Promise.all(castIds.map((c) => this.getEntity("character", c)))).filter((c): c is Character => c !== null);
        }

        return composeEntityPreviewPrompt(
            { entity, style, accessories, characters },
            { ...this.composeOptions(opts), framing: opts.framing },
        );
    }

    // -- rendering ------------------------------------------------------------

    /**
     * Renders a scene illustration. Returns one Render per candidate; failures are
     * recorded as renders with `status: "failed"` instead of throwing. If the scene has
     * no selected illustration yet, the first successful render becomes selected.
     */
    async renderScene(sceneId: string, opts: RenderOptions = {}): Promise<Render[]> {
        const composed = await this.composeScene(sceneId, opts);
        const renders = await this.executeRender({ kind: "scene", id: sceneId }, composed, opts);
        const first = renders.find((r) => r.status === "succeeded");
        if (first) {
            const scene = await this.requireEntity("scene", sceneId);
            if (!scene.selectedRenderId) {
                scene.selectedRenderId = first.id;
                scene.updatedAt = nowIso();
                await this.saveEntity("scene", scene);
            }
        }
        return renders;
    }

    /** Renders a stand-alone image of an entity (e.g. a character design to later promote to a reference). */
    async renderEntityPreview(kind: EntityKind, id: string, opts: RenderOptions & { styleId?: string } = {}): Promise<Render[]> {
        const composed = await this.composeEntityPreview(kind, id, opts);
        return this.executeRender({ kind, id }, composed, opts);
    }

    private async providerInputs(composed: ComposedPrompt): Promise<ProviderImageInput[]> {
        return Promise.all(
            composed.references.map(async ({ reference }) => {
                if (this.options.referenceTransport === "public-url") {
                    const url = await this.blobPublicUrl(reference.blobKey);
                    if (url) return { url, mimeType: reference.mimeType };
                }
                const blob = await this.storage.blobs.get(reference.blobKey);
                if (!blob) throw new ProviderError(`Reference image blob missing: ${reference.blobKey}`);
                return { url: toDataUri(blob.data, blob.contentType), mimeType: blob.contentType };
            }),
        );
    }

    private async executeRender(target: { kind: EntityKind; id: string }, composed: ComposedPrompt, opts: RenderOptions): Promise<Render[]> {
        const count = opts.count ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 4) throw new ValidationError("count must be an integer between 1 and 4");
        const g = composed.generation;

        const base = (status: Render["status"], extra: Partial<Render>): Render => {
            const ts = nowIso();
            return {
                id: newId("render"),
                kind: "render",
                createdAt: ts,
                updatedAt: ts,
                target,
                status,
                mode: composed.mode,
                prompt: composed.prompt,
                references: composed.references.map((r) => ({
                    index: r.index,
                    entityKind: r.entityKind,
                    entityId: r.entityId,
                    referenceId: r.reference.id,
                    ...(r.reference.label ? { label: r.reference.label } : {}),
                })),
                provider: this.provider.name,
                endpoint: (composed.mode === "reference-to-image" ? g.editEndpoint : g.endpoint) ?? "(provider default)",
                params: { aspectRatio: g.aspectRatio, resolution: g.resolution, outputFormat: g.outputFormat },
                ...extra,
            };
        };
        const save = async (r: Render) => {
            const record = parse(RenderSchema, r, "render");
            await this.storage.records.put("render", record);
            return record;
        };

        let result;
        try {
            result = await this.provider.generate({
                prompt: composed.prompt,
                mode: composed.mode,
                references: await this.providerInputs(composed),
                aspectRatio: g.aspectRatio,
                resolution: g.resolution,
                outputFormat: g.outputFormat,
                numImages: count,
                endpoint: g.endpoint,
                editEndpoint: g.editEndpoint,
                providerOptions: opts.providerOptions,
            });
        } catch (err) {
            return [await save(base("failed", { error: (err as Error).message }))];
        }

        const renders: Render[] = [];
        for (const raw of result.images.slice(0, count)) {
            try {
                const image = await postProcess(raw, opts.postProcess, this.options.backgroundRemover);
                const render = base("succeeded", { endpoint: result.endpoint });
                const blobKey = `renders/${render.id}.${extFromMime(image.mimeType)}`;
                await this.storage.blobs.put(blobKey, image.data, image.mimeType);
                render.image = { blobKey, mimeType: image.mimeType, ...(await imageInfo(image.data)) };
                if (raw.sourceUrl) render.sourceUrl = raw.sourceUrl;
                renders.push(await save(render));
            } catch (err) {
                renders.push(await save(base("failed", { endpoint: result.endpoint, error: (err as Error).message })));
            }
        }
        return renders;
    }

    // -- renders --------------------------------------------------------------

    async getRender(id: string): Promise<Render | null> {
        return this.storage.records.get("render", id);
    }

    /** Renders, newest first, optionally limited to one target entity. */
    async listRenders(filter: { targetKind?: EntityKind; targetId?: string } = {}): Promise<Render[]> {
        const all = await this.storage.records.list("render");
        return all
            .filter((r) => (!filter.targetKind || r.target.kind === filter.targetKind) && (!filter.targetId || r.target.id === filter.targetId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async deleteRender(id: string): Promise<boolean> {
        const render = await this.getRender(id);
        if (!render) return false;
        if (render.target.kind === "scene") {
            const scene = await this.getEntity("scene", render.target.id);
            if (scene?.selectedRenderId === id) {
                delete scene.selectedRenderId;
                scene.updatedAt = nowIso();
                await this.saveEntity("scene", scene);
            }
        }
        await this.storage.records.delete("render", id);
        if (render.image) await this.storage.blobs.delete(render.image.blobKey);
        return true;
    }

    /** Chooses which render illustrates the scene (`null` clears the choice). */
    async selectSceneRender(sceneId: string, renderId: string | null): Promise<Scene> {
        const scene = await this.requireEntity("scene", sceneId);
        if (renderId === null) {
            delete scene.selectedRenderId;
        } else {
            const render = await this.getRender(renderId);
            if (!render) throw new NotFoundError("render", renderId);
            if (render.target.kind !== "scene" || render.target.id !== sceneId) {
                throw new ValidationError(`render "${renderId}" does not belong to scene "${sceneId}"`);
            }
            if (render.status !== "succeeded") throw new ValidationError(`render "${renderId}" has no image`);
            scene.selectedRenderId = renderId;
        }
        scene.updatedAt = nowIso();
        return this.saveEntity("scene", scene);
    }

    /** Copies a render's image into an entity's reference images (e.g. an approved character design). */
    async promoteRenderToReference(
        renderId: string,
        target: Omit<AddReferenceInput, "image">,
    ): Promise<ReferenceImage> {
        const render = await this.getRender(renderId);
        if (!render) throw new NotFoundError("render", renderId);
        if (!render.image) throw new ValidationError(`render "${renderId}" has no image`);
        const blob = await this.storage.blobs.get(render.image.blobKey);
        if (!blob) throw new NotFoundError("render image", render.image.blobKey);
        return this.addReference({ ...target, image: { data: blob.data } });
    }
}

// ---------------------------------------------------------------------------
// Per-kind CRUD
// ---------------------------------------------------------------------------

export class EntityService<K extends EntityKind> {
    constructor(
        private readonly engine: StoryEngine,
        readonly kind: K,
    ) {}

    private get schemas() {
        return ENTITY_SCHEMAS[this.kind];
    }

    async create(input: CreateInputByKind[K]): Promise<EntityByKind[K]> {
        const data = parse(this.schemas.create as unknown as ZodType<Record<string, unknown>>, input, `${this.kind} input`);
        const id = typeof data.id === "string" ? data.id : newId(this.kind);
        if (await this.engine.getEntity(this.kind, id)) throw new ConflictError(`${this.kind} "${id}" already exists`);

        const ts = nowIso();
        const candidate = { ...data, id, kind: this.kind, createdAt: ts, updatedAt: ts, references: [] };
        const record = parse(this.schemas.record as unknown as ZodType<EntityByKind[K]>, candidate, this.kind);
        await this.engine.assertLinks(record);
        await this.engine.putEntity(this.kind, record);

        if (record.kind === "scene") await this.engine.syncSceneMembership(record.id, undefined, record.storyId);
        return record;
    }

    async get(id: string): Promise<EntityByKind[K] | null> {
        return this.engine.getEntity(this.kind, id);
    }

    async require(id: string): Promise<EntityByKind[K]> {
        return this.engine.requireEntity(this.kind, id);
    }

    async list(filter: ListFilter = {}): Promise<Array<EntityByKind[K]>> {
        const all = await this.engine.storage.records.list(this.kind);
        return all
            .filter((e) => !filter.tag || e.tags.includes(filter.tag))
            .filter((e) => !filter.storyId || (e.kind === "scene" && e.storyId === filter.storyId))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async update(id: string, patch: PatchInputByKind[K]): Promise<EntityByKind[K]> {
        const existing = await this.require(id);
        const data = parse(this.schemas.patch as unknown as ZodType<Record<string, unknown>>, patch, `${this.kind} patch`);
        const merged = mergePatch(existing, data);
        merged.updatedAt = nowIso();
        const record = parse(this.schemas.record as unknown as ZodType<EntityByKind[K]>, merged, this.kind);
        await this.engine.assertLinks(record);
        await this.engine.putEntity(this.kind, record);

        if (existing.kind === "scene" && record.kind === "scene") {
            await this.engine.syncSceneMembership(id, existing.storyId, record.storyId);
        }
        return record;
    }

    /** Deletes the entity, its reference images and its renders. */
    async delete(id: string, options: DeleteOptions = {}): Promise<boolean> {
        const existing = await this.get(id);
        if (!existing) return false;

        const usages = await this.engine.findUsages(this.kind, id);
        if (usages.length && !options.force) throw new InUseError(this.kind, id, usages);
        if (usages.length) await this.engine.detach(this.kind, id);
        if (existing.kind === "scene") await this.engine.syncSceneMembership(id, existing.storyId, undefined);

        for (const render of await this.engine.listRenders({ targetKind: this.kind, targetId: id })) {
            await this.engine.deleteRender(render.id);
        }
        await this.engine.storage.records.delete(this.kind, id);
        for (const ref of existing.references) await this.engine.storage.blobs.delete(ref.blobKey);
        return true;
    }
}

export function createStoryEngine(options: StoryEngineOptions): StoryEngine {
    return new StoryEngine(options);
}

export type { Accessory, Character, Location, Scene, Story, Style };
