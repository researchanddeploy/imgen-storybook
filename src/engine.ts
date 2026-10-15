import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ZodType } from "zod";
import {
    ENTITY_SCHEMAS,
    PENDING_RENDER_STATUSES,
    RenderSchema,
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
    type RenderOperation,
    type RenderReview,
    type Scene,
    type Story,
    type Style,
} from "./domain/schemas.js";
import { ConflictError, InUseError, LimitExceededError, NotFoundError, ValidationError, VersionConflictError } from "./errors.js";
import { newId, nowIso } from "./ids.js";
import { normalizeReferenceImage } from "./images.js";
import { imageInfo, postProcess, type PostProcessOptions } from "./postprocess/index.js";
import {
    accessoryIdsForCastMember,
    composeEntityPreviewPrompt,
    composeRefinementPrompt,
    composeScenePrompt,
    type ComposedPrompt,
    type ContinuityAnchor,
    type PlannedReference,
    type ReferenceBudget,
    type ResolvedGeneration,
    type SceneContext,
} from "./prompt/composer.js";
import { materializeOutput, mimeForFormat, toDataUri } from "./providers/http.js";
import type { BackgroundRemover, ImageProvider, ImageReviewer, JobState, ProviderImageInput, ProviderJob } from "./providers/types.js";
import { isTransientError } from "./retry.js";
import { extFromMime, type Page, type StorageAdapter, type StoredBlob } from "./storage/types.js";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface RenderLimits {
    /** Images submitted in the last 24 h (failed ones excluded). */
    maxRendersPerDay?: number;
    /** Images queued or running at the same time. */
    maxConcurrentRenders?: number;
    /** Estimated spend in the last 24 h (needs `pricing`). */
    maxDailyCostUsd?: number;
}

/** USD per output image, by endpoint (exact id) — or a function for custom rules. */
export type Pricing = Record<string, number> | ((endpoint: string, job: ProviderJob) => number | undefined);

export type ReferenceTransport = "auto" | "provider-upload" | "data-uri" | "public-url";

export interface StoryEngineOptions {
    storage: StorageAdapter;
    provider: ImageProvider;
    /** Needed only for `postProcess.removeBackground`. */
    backgroundRemover?: BackgroundRemover;
    /** Automated QA (moderation + consistency) run on every finished render. */
    reviewer?: ImageReviewer;
    /** Engine-level generation defaults (lowest priority). */
    defaults?: Partial<ResolvedGeneration>;
    referenceBudget?: Partial<ReferenceBudget>;
    /**
     * How images reach the provider:
     * - `auto` (default): upload to provider storage when supported (cached per reference), else data URI,
     * - `provider-upload`: always upload (fails if unsupported),
     * - `data-uri`: inline in the request,
     * - `public-url`: the blob store's public URL (must be reachable by the provider).
     */
    referenceTransport?: ReferenceTransport;
    /** Max size of an uploaded reference image before processing. Default 15 MB. */
    maxReferenceBytes?: number;
    /** References are downscaled to this longest side when stored. Default 1536. */
    maxReferenceDimension?: number;
    /**
     * Reference images given as URLs are fetched server-side. That is an SSRF vector,
     * so URL sources are rejected unless this hook approves the URL.
     */
    allowReferenceUrl?: (url: URL) => boolean | Promise<boolean>;
    /** Builds the completion webhook URL for a submission; omit to rely on polling. */
    webhookUrl?: (args: { renderId: string; token: string }) => string | undefined;
    limits?: RenderLimits;
    pricing?: Pricing;
    /** Pending renders older than this are canceled and marked failed. Default 15 min. */
    renderTimeoutMs?: number;
}

export type ImageSource = { data: Uint8Array } | { base64: string } | { dataUri: string } | { url: string };

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
    /** Entity previews only: style to render in. */
    styleId?: string;
}

export interface SubmitOptions {
    postProcess?: PostProcessOptions;
    providerOptions?: Record<string, unknown>;
}

export interface RenderOptions extends ComposeRequestOptions, SubmitOptions {
    /** Number of candidate images (1-4). Each becomes its own Render. */
    count?: number;
}

export interface RefineOptions extends SubmitOptions {
    /** What to change, e.g. "make Ala smile and remove the second gull". */
    instructions: string;
    count?: number;
    generation?: GenerationSettings;
    referenceBudget?: Partial<ReferenceBudget>;
}

export interface UpscaleOptions extends SubmitOptions {
    /** Default 2. */
    scale?: number;
    endpoint?: string;
}

export interface UpdateOptions {
    /** Optimistic locking: fail with CONFLICT unless the stored version matches. */
    expectedVersion?: number;
}

export interface DeleteOptions {
    /** Detach the entity from everything that references it instead of failing. */
    force?: boolean;
}

export interface ListOptions {
    tag?: string;
    /** Scenes only. */
    storyId?: string;
    limit?: number;
    cursor?: string;
}

export interface RenderListOptions {
    targetKind?: EntityKind;
    targetId?: string;
    status?: Render["status"];
    limit?: number;
    cursor?: string;
}

const DEFAULT_GENERATION: ResolvedGeneration = { aspectRatio: "4:3", resolution: "1K", outputFormat: "png" };
const DEFAULT_BUDGET: ReferenceBudget = { maxReferences: 10, maxPerEntity: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** A render created but never handed to the provider (crash mid-submit) is abandoned after this. */
const SUBMIT_GRACE_MS = 2 * 60 * 1000;
/** Re-upload a cached provider copy when it expires within this window. */
const UPLOAD_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

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

const dedupe = <T>(items: T[]): T[] => [...new Set(items)];

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Derived fields stored on scenes so usages can be found with indexed queries. */
function withSceneIndexes(scene: Record<string, unknown>): Record<string, unknown> {
    const cast = (scene.cast as Scene["cast"] | undefined) ?? [];
    return {
        ...scene,
        castCharacterIds: dedupe(cast.map((m) => m.characterId)),
        usedAccessoryIds: dedupe([...((scene.accessoryIds as string[] | undefined) ?? []), ...cast.flatMap((m) => m.accessoryIds ?? [])]),
    };
}

async function allPages<T>(fetch: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
        const page = await fetch(cursor);
        out.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return out;
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

    /** @internal Validates and writes with a version check (`expectedVersion` = version being replaced, 0 = new). */
    async writeEntity<K extends EntityKind>(kind: K, entity: EntityByKind[K], expectedVersion: number): Promise<EntityByKind[K]> {
        const candidate = kind === "scene" ? withSceneIndexes(entity as unknown as Record<string, unknown>) : entity;
        const record = parse(ENTITY_SCHEMAS[kind].record as unknown as ZodType<EntityByKind[K]>, { ...candidate, version: expectedVersion + 1 }, kind);
        await this.storage.records.put(kind, record as RecordByKind[K], { expectedVersion });
        return record;
    }

    /**
     * @internal Read-modify-write with optimistic locking, retried on concurrent updates.
     * `fn` mutates the record in place; returning `false` skips the write.
     */
    async mutateEntity<K extends EntityKind>(kind: K, id: string, fn: (e: EntityByKind[K]) => void | boolean | Promise<void | boolean>): Promise<EntityByKind[K]> {
        for (let attempt = 0; ; attempt++) {
            const current = await this.requireEntity(kind, id);
            if ((await fn(current)) === false) return current;
            current.updatedAt = nowIso();
            try {
                return await this.writeEntity(kind, current, current.version);
            } catch (err) {
                if (!(err instanceof VersionConflictError) || attempt >= 4) throw err;
            }
        }
    }

    private async mutateRender(id: string, fn: (r: Render) => void | boolean): Promise<Render> {
        for (let attempt = 0; ; attempt++) {
            const current = await this.getRender(id);
            if (!current) throw new NotFoundError("render", id);
            if (fn(current) === false) return current;
            current.updatedAt = nowIso();
            const expected = current.version;
            const record = parse(RenderSchema, { ...current, version: expected + 1 }, "render");
            try {
                await this.storage.records.put("render", record, { expectedVersion: expected });
                return record;
            } catch (err) {
                if (!(err instanceof VersionConflictError) || attempt >= 4) throw err;
            }
        }
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
                entity.continuity.sceneIds?.forEach((id) => checks.push(["scene", id]));
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

        if (entity.kind === "scene") {
            const selections = [
                ...entity.referenceSelections,
                ...entity.cast.filter((m) => m.referenceIds?.length).map((m) => ({ entityKind: "character" as const, entityId: m.characterId, referenceIds: m.referenceIds! })),
            ];
            for (const sel of selections) {
                const target = await this.getEntity(sel.entityKind, sel.entityId);
                if (!target) throw new ValidationError(`referenceSelections: ${sel.entityKind}:${sel.entityId} does not exist`);
                const known = new Set(target.references.map((r) => r.id));
                const unknown = sel.referenceIds.filter((r) => !known.has(r));
                if (unknown.length) throw new ValidationError(`${sel.entityKind} "${sel.entityId}" has no reference images ${unknown.join(", ")}`);
            }
            if (entity.continuity.sceneIds?.includes(entity.id)) throw new ValidationError("A scene cannot be its own continuity anchor");
        }
        if (entity.kind === "story") {
            const own = new Set((await this.storyScenesUnordered(entity.id)).map((s) => s.id));
            const foreign = entity.sceneOrder.filter((id) => !own.has(id));
            if (foreign.length) throw new ValidationError(`sceneOrder contains scenes that do not belong to story "${entity.id}": ${foreign.join(", ")}`);
        }
    }

    private async queryAll<K extends EntityKind>(kind: K, query: Parameters<StorageAdapter["records"]["query"]>[1]): Promise<Array<EntityByKind[K]>> {
        return allPages((cursor) => this.storage.records.query(kind, { ...query, cursor }) as Promise<Page<EntityByKind[K]>>);
    }

    /** Entities that reference the given one. */
    async findUsages(kind: EntityKind, id: string): Promise<Array<{ kind: EntityKind; id: string }>> {
        const refs = (k: EntityKind, items: Array<{ id: string }>) => items.map((i) => ({ kind: k, id: i.id }));
        switch (kind) {
            case "character":
                return [
                    ...refs("scene", await this.queryAll("scene", { contains: { castCharacterIds: id } })),
                    ...refs("accessory", await this.queryAll("accessory", { where: { ownerCharacterId: id } })),
                ];
            case "accessory":
                return [
                    ...refs("character", await this.queryAll("character", { contains: { defaultAccessoryIds: id } })),
                    ...refs("scene", await this.queryAll("scene", { contains: { usedAccessoryIds: id } })),
                ];
            case "style":
                return [
                    ...refs("scene", await this.queryAll("scene", { where: { styleId: id } })),
                    ...refs("story", await this.queryAll("story", { where: { styleId: id } })),
                ];
            case "location":
                return refs("scene", await this.queryAll("scene", { where: { locationId: id } }));
            case "story":
                return refs("scene", await this.queryAll("scene", { where: { storyId: id } }));
            case "scene":
                return [];
        }
    }

    /** @internal Removes every pointer to the entity from its dependents. */
    async detach(kind: EntityKind, id: string): Promise<void> {
        for (const usage of await this.findUsages(kind, id)) {
            await this.mutateEntity(usage.kind, usage.id, (dep) => {
                const d = dep as AnyEntity & Record<string, unknown>;
                switch (kind) {
                    case "character":
                        if (dep.kind === "scene") {
                            dep.cast = dep.cast.filter((m) => m.characterId !== id);
                            dep.referenceSelections = dep.referenceSelections.filter((s) => !(s.entityKind === "character" && s.entityId === id));
                        }
                        if (dep.kind === "accessory") delete d.ownerCharacterId;
                        break;
                    case "accessory":
                        if (dep.kind === "character") dep.defaultAccessoryIds = dep.defaultAccessoryIds.filter((a) => a !== id);
                        if (dep.kind === "scene") {
                            dep.accessoryIds = dep.accessoryIds.filter((a) => a !== id);
                            dep.cast = dep.cast.map((m) => (m.accessoryIds ? { ...m, accessoryIds: m.accessoryIds.filter((a) => a !== id) } : m));
                            dep.referenceSelections = dep.referenceSelections.filter((s) => !(s.entityKind === "accessory" && s.entityId === id));
                        }
                        break;
                    case "style":
                        delete d.styleId;
                        break;
                    case "location":
                        delete d.locationId;
                        if (dep.kind === "scene") dep.referenceSelections = dep.referenceSelections.filter((s) => s.entityKind !== "location" || s.entityId !== id);
                        break;
                    case "story":
                        delete d.storyId;
                        break;
                    case "scene":
                        break;
                }
            });
        }
    }

    // -- stories & scenes -----------------------------------------------------

    private async storyScenesUnordered(storyId: string): Promise<Scene[]> {
        return this.queryAll("scene", { where: { storyId } });
    }

    /** Scenes of a story in display order (`sceneOrder` first, then by creation time). */
    async listStoryScenes(storyId: string): Promise<Scene[]> {
        const story = await this.requireEntity("story", storyId);
        const rank = new Map(story.sceneOrder.map((id, i) => [id, i]));
        return (await this.storyScenesUnordered(storyId)).sort((a, b) => {
            const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            return ra !== rb ? ra - rb : a.createdAt.localeCompare(b.createdAt);
        });
    }

    /** @internal Keeps `story.sceneOrder` in sync when a scene joins or leaves a story. */
    async syncSceneMembership(sceneId: string, fromStoryId: string | undefined, toStoryId: string | undefined): Promise<void> {
        if (fromStoryId === toStoryId) return;
        if (fromStoryId && (await this.getEntity("story", fromStoryId))) {
            await this.mutateEntity("story", fromStoryId, (s) => {
                if (!s.sceneOrder.includes(sceneId)) return false;
                s.sceneOrder = s.sceneOrder.filter((id) => id !== sceneId);
            });
        }
        if (toStoryId) {
            await this.mutateEntity("story", toStoryId, (s) => {
                if (s.sceneOrder.includes(sceneId)) return false;
                s.sceneOrder = [...s.sceneOrder, sceneId];
            });
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
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new ValidationError(`Failed to fetch reference image (${res.status}): ${url.href}`);
        return Buffer.from(await res.arrayBuffer());
    }

    async addReference(input: AddReferenceInput): Promise<ReferenceImage> {
        await this.requireEntity(input.kind, input.entityId);
        const image = await normalizeReferenceImage(await this.readImageSource(input.image), {
            maxBytes: this.options.maxReferenceBytes,
            maxDimension: this.options.maxReferenceDimension,
        });
        const id = newId("reference");
        const blobKey = `references/${input.kind}/${input.entityId}/${id}.${extFromMime(image.mimeType)}`;
        await this.storage.blobs.put(blobKey, image.data, image.mimeType);

        let ref: ReferenceImage | undefined;
        try {
            await this.mutateEntity(input.kind, input.entityId, (entity) => {
                const isPrimary = input.isPrimary ?? entity.references.length === 0;
                ref = {
                    id,
                    blobKey,
                    mimeType: image.mimeType,
                    width: image.width,
                    height: image.height,
                    isPrimary,
                    createdAt: nowIso(),
                    ...(input.label ? { label: input.label } : {}),
                    ...(input.view ? { view: input.view } : {}),
                    ...(input.notes ? { notes: input.notes } : {}),
                };
                const others = isPrimary ? entity.references.map((r) => ({ ...r, isPrimary: false })) : entity.references;
                entity.references = [...others, ref];
            });
        } catch (err) {
            await this.storage.blobs.delete(blobKey);
            throw err;
        }
        return ref!;
    }

    async updateReference(kind: EntityKind, entityId: string, referenceId: string, patch: UpdateReferenceInput): Promise<ReferenceImage> {
        let updated: ReferenceImage | undefined;
        await this.mutateEntity(kind, entityId, (entity) => {
            const existing = entity.references.find((r) => r.id === referenceId);
            if (!existing) throw new NotFoundError("reference", referenceId);
            const { isPrimary, ...rest } = patch;
            updated = mergePatch(existing, rest);
            if (isPrimary !== undefined) updated.isPrimary = isPrimary;
            entity.references = entity.references.map((r) => (r.id === referenceId ? updated! : isPrimary ? { ...r, isPrimary: false } : r));
        });
        return updated!;
    }

    async removeReference(kind: EntityKind, entityId: string, referenceId: string): Promise<boolean> {
        let removed: ReferenceImage | undefined;
        await this.mutateEntity(kind, entityId, (entity) => {
            removed = entity.references.find((r) => r.id === referenceId);
            if (!removed) return false;
            let remaining = entity.references.filter((r) => r.id !== referenceId);
            if (removed.isPrimary && remaining.length > 0 && !remaining.some((r) => r.isPrimary)) {
                remaining = remaining.map((r, i) => (i === 0 ? { ...r, isPrimary: true } : r));
            }
            entity.references = remaining;
        });
        if (!removed) return false;
        await this.storage.blobs.delete(removed.blobKey);
        // Scenes that explicitly chose this image fall back to the default choice.
        const scenes = await this.queryAll("scene", {});
        for (const s of scenes) {
            const usesIt =
                s.referenceSelections.some((sel) => sel.referenceIds.includes(referenceId)) || s.cast.some((m) => m.referenceIds?.includes(referenceId));
            if (!usesIt) continue;
            await this.mutateEntity("scene", s.id, (scene) => {
                scene.referenceSelections = scene.referenceSelections
                    .map((sel) => ({ ...sel, referenceIds: sel.referenceIds.filter((r) => r !== referenceId) }))
                    .filter((sel) => sel.referenceIds.length > 0);
                scene.cast = scene.cast.map((m) => (m.referenceIds ? { ...m, referenceIds: m.referenceIds.filter((r) => r !== referenceId) } : m));
            });
        }
        return true;
    }

    async getBlob(key: string): Promise<StoredBlob | null> {
        return this.storage.blobs.get(key);
    }

    async blobPublicUrl(key: string): Promise<string | null> {
        return (await this.storage.blobs.publicUrl?.(key)) ?? null;
    }

    // -- delivering images to the provider ------------------------------------

    private get transport(): ReferenceTransport {
        return this.options.referenceTransport ?? "auto";
    }

    private canUpload(): boolean {
        return this.transport !== "data-uri" && this.transport !== "public-url" && typeof this.provider.uploadImage === "function";
    }

    /** Turns a stored blob into something the provider can fetch. */
    private async blobToProviderInput(blobKey: string, mimeType: string): Promise<ProviderImageInput & { uploaded?: { url: string; expiresAt?: string } }> {
        if (this.transport === "public-url") {
            const url = await this.blobPublicUrl(blobKey);
            if (url) return { url, mimeType };
        }
        const blob = await this.storage.blobs.get(blobKey);
        if (!blob) throw new NotFoundError("blob", blobKey);
        if (this.canUpload()) {
            const uploaded = await this.provider.uploadImage!(blob.data, blob.contentType);
            return { url: uploaded.url, mimeType: blob.contentType, uploaded };
        }
        if (this.transport === "provider-upload") throw new ValidationError(`Provider "${this.provider.name}" does not support uploads`);
        return { url: toDataUri(blob.data, blob.contentType), mimeType: blob.contentType };
    }

    /** Reference images are uploaded once and the provider URL is cached on the reference. */
    private async referenceToProviderInput(planned: PlannedReference): Promise<ProviderImageInput> {
        const ref = planned.reference!;
        const cached = ref.providerUpload;
        if (
            this.canUpload() &&
            cached?.provider === this.provider.name &&
            (!cached.expiresAt || Date.parse(cached.expiresAt) - Date.now() > UPLOAD_EXPIRY_MARGIN_MS)
        ) {
            return { url: cached.url, mimeType: ref.mimeType };
        }
        const input = await this.blobToProviderInput(ref.blobKey, ref.mimeType);
        if (input.uploaded && planned.entityKind && planned.entityId) {
            const providerUpload = { provider: this.provider.name, url: input.uploaded.url, uploadedAt: nowIso(), ...(input.uploaded.expiresAt ? { expiresAt: input.uploaded.expiresAt } : {}) };
            await this.mutateEntity(planned.entityKind, planned.entityId, (e) => {
                const target = e.references.find((r) => r.id === ref.id);
                if (!target) return false;
                target.providerUpload = providerUpload;
            }).catch(() => undefined); // caching is best effort
        }
        return { url: input.url, mimeType: input.mimeType };
    }

    private async providerInputs(references: PlannedReference[]): Promise<ProviderImageInput[]> {
        return Promise.all(
            references.map(async (r) => {
                if (r.role === "entity" && r.reference) return this.referenceToProviderInput(r);
                const { url, mimeType } = await this.blobToProviderInput(r.blobKey, r.mimeType);
                return { url, mimeType };
            }),
        );
    }

    // -- prompt composition ---------------------------------------------------

    private composeOptions(opts: ComposeRequestOptions & { indexOffset?: number }) {
        const budget = { ...this.budget, ...opts.referenceBudget };
        return {
            budget: { ...budget, maxReferences: budget.maxReferences - (opts.indexOffset ?? 0) },
            defaults: this.defaults,
            overrides: opts.generation,
            extraInstructions: opts.extraInstructions,
            indexOffset: opts.indexOffset,
        };
    }

    private async selectedImageRender(sceneId: string): Promise<ContinuityAnchor | undefined> {
        const scene = await this.getEntity("scene", sceneId);
        if (!scene?.selectedRenderId) return undefined;
        const render = await this.getRender(scene.selectedRenderId);
        if (!render?.image || render.status !== "succeeded") return undefined;
        return { scene, render: render as ContinuityAnchor["render"] };
    }

    async loadSceneContext(scene: Scene): Promise<SceneContext> {
        const story = scene.storyId ? ((await this.getEntity("story", scene.storyId)) ?? undefined) : undefined;
        const styleId = scene.styleId ?? story?.styleId;
        const style = styleId ? ((await this.getEntity("style", styleId)) ?? undefined) : undefined;
        const location = scene.locationId ? ((await this.getEntity("location", scene.locationId)) ?? undefined) : undefined;

        const characterList = await this.storage.records.getMany("character", dedupe(scene.cast.map((m) => m.characterId)));
        const characters = new Map(characterList.filter((c): c is Character => c !== null).map((c) => [c.id, c]));
        const accessoryIds = dedupe([...scene.cast.flatMap((m) => accessoryIdsForCastMember(m, characters.get(m.characterId))), ...scene.accessoryIds]);
        const accessoryList = await this.storage.records.getMany("accessory", accessoryIds);
        const accessories = new Map(accessoryList.filter((a): a is Accessory => a !== null).map((a) => [a.id, a]));

        const continuityIds: string[] = [];
        if (scene.continuity.fromPreviousScene && scene.storyId) {
            const ordered = await this.listStoryScenes(scene.storyId);
            const prev = ordered[ordered.findIndex((s) => s.id === scene.id) - 1];
            if (prev) continuityIds.push(prev.id);
        }
        continuityIds.push(...(scene.continuity.sceneIds ?? []));
        const continuity = (await Promise.all(dedupe(continuityIds).map((id) => this.selectedImageRender(id)))).filter(
            (c): c is ContinuityAnchor => c !== undefined,
        );

        return { scene, story, style, location, characters, accessories, continuity };
    }

    /** Dry run: the exact prompt and reference list a render of this scene would use. */
    async composeScene(sceneId: string, opts: ComposeRequestOptions & { indexOffset?: number } = {}): Promise<ComposedPrompt> {
        const scene = await this.requireEntity("scene", sceneId);
        return composeScenePrompt(await this.loadSceneContext(scene), this.composeOptions(opts));
    }

    /** Dry run for an entity preview (character design, object, location, style sample, story cover). */
    async composeEntityPreview(kind: EntityKind, id: string, opts: ComposeRequestOptions & { indexOffset?: number } = {}): Promise<ComposedPrompt> {
        if (kind === "scene") throw new ValidationError("Use composeScene/renderScene for scenes");
        const entity = await this.requireEntity(kind, id);

        const styleId = opts.styleId ?? (entity.kind === "story" ? entity.styleId : undefined);
        const style: Style | undefined = styleId ? await this.requireEntity("style", styleId) : undefined;

        let accessories: Accessory[] = [];
        let characters: Character[] = [];
        if (entity.kind === "character") {
            accessories = (await this.storage.records.getMany("accessory", entity.defaultAccessoryIds)).filter((a): a is Accessory => a !== null);
        }
        if (entity.kind === "story") {
            const castIds = dedupe((await this.listStoryScenes(entity.id)).flatMap((s) => s.cast.map((m) => m.characterId)));
            characters = (await this.storage.records.getMany("character", castIds)).filter((c): c is Character => c !== null);
        }

        return composeEntityPreviewPrompt({ entity, style, accessories, characters }, { ...this.composeOptions(opts), framing: opts.framing });
    }

    // -- limits ---------------------------------------------------------------

    private estimateCost(endpoint: string, job: ProviderJob): number | undefined {
        const p = this.options.pricing;
        if (!p) return undefined;
        return typeof p === "function" ? p(endpoint, job) : p[endpoint];
    }

    private async assertWithinLimits(images: number, costPerImage: number | undefined): Promise<void> {
        const limits = this.options.limits;
        if (!limits) return;
        const since = new Date(Date.now() - DAY_MS).toISOString();
        const records = this.storage.records;
        if (limits.maxConcurrentRenders !== undefined) {
            const pending = await records.count("render", { in: { status: [...PENDING_RENDER_STATUSES] } });
            if (pending + images > limits.maxConcurrentRenders) {
                throw new LimitExceededError(`Too many renders in progress (${pending}, limit ${limits.maxConcurrentRenders})`, { pending });
            }
        }
        if (limits.maxRendersPerDay !== undefined) {
            const today = await records.count("render", { createdSince: since, in: { status: ["queued", "running", "succeeded"] } });
            if (today + images > limits.maxRendersPerDay) {
                throw new LimitExceededError(`Daily render limit reached (${today}/${limits.maxRendersPerDay})`, { today });
            }
        }
        if (limits.maxDailyCostUsd !== undefined) {
            const recent = await allPages((cursor) => records.query("render", { createdSince: since, cursor, limit: 500 }));
            const spent = recent.filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
            const next = (costPerImage ?? 0) * images;
            if (spent + next > limits.maxDailyCostUsd) {
                throw new LimitExceededError(`Daily budget reached ($${spent.toFixed(2)} of $${limits.maxDailyCostUsd})`, { spent });
            }
        }
    }

    // -- rendering ------------------------------------------------------------

    /**
     * Queues a scene illustration and returns immediately with renders in status
     * `queued`. Completion arrives via webhook or `syncRender`/`syncPendingRenders`.
     * The first successful render becomes the scene's selected one if none is selected.
     */
    async renderScene(sceneId: string, opts: RenderOptions = {}): Promise<Render[]> {
        const composed = await this.composeScene(sceneId, opts);
        return this.submit({ target: { kind: "scene", id: sceneId }, operation: "generate", composed, count: opts.count ?? 1, opts });
    }

    /** Queues a stand-alone image of an entity (e.g. a character design to promote to a reference). */
    async renderEntityPreview(kind: EntityKind, id: string, opts: RenderOptions = {}): Promise<Render[]> {
        const composed = await this.composeEntityPreview(kind, id, opts);
        return this.submit({ target: { kind, id }, operation: "generate", composed, count: opts.count ?? 1, opts });
    }

    /** Edits an existing render according to instructions, keeping everything else. */
    async refineRender(renderId: string, opts: RefineOptions): Promise<Render[]> {
        const parent = await this.requireFinishedRender(renderId);
        if (!opts.instructions?.trim()) throw new ValidationError("instructions are required");
        const generation: GenerationSettings = {
            aspectRatio: parent.params.aspectRatio,
            resolution: parent.params.resolution,
            outputFormat: parent.params.outputFormat,
            ...opts.generation,
        };
        const inner =
            parent.targetKind === "scene"
                ? await this.composeScene(parent.targetId, { generation, referenceBudget: opts.referenceBudget, indexOffset: 1 })
                : await this.composeEntityPreview(parent.targetKind, parent.targetId, { generation, referenceBudget: opts.referenceBudget, indexOffset: 1 });
        const composed = composeRefinementPrompt({ blobKey: parent.image.blobKey, mimeType: parent.image.mimeType, renderId: parent.id }, inner, opts.instructions);
        return this.submit({
            target: { kind: parent.targetKind, id: parent.targetId },
            operation: "refine",
            parentRenderId: parent.id,
            composed,
            count: opts.count ?? 1,
            opts,
        });
    }

    /** Enlarges a finished render (e.g. for print). */
    async upscaleRender(renderId: string, opts: UpscaleOptions = {}): Promise<Render> {
        const parent = await this.requireFinishedRender(renderId);
        const scale = opts.scale ?? 2;
        if (!(scale > 1 && scale <= 8)) throw new ValidationError("scale must be between 1 and 8");
        const composed: ComposedPrompt = {
            prompt: `Upscale x${scale}`,
            mode: "reference-to-image",
            references: [{ index: 1, role: "base", blobKey: parent.image.blobKey, mimeType: parent.image.mimeType, renderId: parent.id }],
            generation: { ...parent.params, endpoint: opts.endpoint },
        };
        const [render] = await this.submit({
            target: { kind: parent.targetKind, id: parent.targetId },
            operation: "upscale",
            parentRenderId: parent.id,
            composed,
            count: 1,
            opts,
            scale,
        });
        return render!;
    }

    private async requireFinishedRender(id: string): Promise<Render & { image: NonNullable<Render["image"]> }> {
        const render = await this.getRender(id);
        if (!render) throw new NotFoundError("render", id);
        if (render.status !== "succeeded" || !render.image) throw new ValidationError(`render "${id}" has no finished image`);
        return render as Render & { image: NonNullable<Render["image"]> };
    }

    private async submit(args: {
        target: { kind: EntityKind; id: string };
        operation: RenderOperation;
        composed: ComposedPrompt;
        count: number;
        opts: SubmitOptions;
        parentRenderId?: string;
        scale?: number;
    }): Promise<Render[]> {
        const { composed, count, opts } = args;
        if (!Number.isInteger(count) || count < 1 || count > 4) throw new ValidationError("count must be an integer between 1 and 4");
        const g = composed.generation;

        const references = await this.providerInputs(composed.references);
        const job: ProviderJob =
            args.operation === "upscale"
                ? { type: "upscale", image: references[0]!, scale: args.scale ?? 2, endpoint: g.endpoint, providerOptions: opts.providerOptions }
                : {
                      type: "image",
                      prompt: composed.prompt,
                      mode: composed.mode,
                      references,
                      aspectRatio: g.aspectRatio,
                      resolution: g.resolution,
                      outputFormat: g.outputFormat,
                      numImages: count,
                      endpoint: g.endpoint,
                      editEndpoint: g.editEndpoint,
                      providerOptions: opts.providerOptions,
                  };
        const endpoint = this.provider.resolveEndpoint(job);
        const costPerImage = this.estimateCost(endpoint, job);
        await this.assertWithinLimits(count, costPerImage);

        // Records first, so a crash between submit and save never leaves an untracked paid job.
        const token = randomBytes(24).toString("base64url");
        const ts = nowIso();
        const renders = Array.from({ length: count }, (_, i): Render =>
            parse(
                RenderSchema,
                {
                    id: newId("render"),
                    kind: "render",
                    version: 1,
                    createdAt: ts,
                    updatedAt: ts,
                    targetKind: args.target.kind,
                    targetId: args.target.id,
                    operation: args.operation,
                    ...(args.parentRenderId ? { parentRenderId: args.parentRenderId } : {}),
                    status: "queued",
                    mode: composed.mode,
                    prompt: composed.prompt,
                    references: composed.references.map((r) => ({
                        index: r.index,
                        role: r.role,
                        ...(r.entityKind ? { entityKind: r.entityKind, entityId: r.entityId } : {}),
                        ...(r.reference ? { referenceId: r.reference.id } : {}),
                        ...(r.renderId ? { renderId: r.renderId } : {}),
                        ...(r.reference?.label ? { label: r.reference.label } : {}),
                    })),
                    provider: this.provider.name,
                    endpoint,
                    params: {
                        aspectRatio: g.aspectRatio,
                        resolution: g.resolution,
                        outputFormat: g.outputFormat,
                        ...(args.scale ? { scale: args.scale } : {}),
                    },
                    outputIndex: i,
                    webhookToken: token,
                    ...(opts.postProcess ? { postProcess: opts.postProcess } : {}),
                    ...(costPerImage !== undefined ? { estimatedCostUsd: costPerImage } : {}),
                },
                "render",
            ),
        );
        for (const r of renders) await this.storage.records.put("render", r, { expectedVersion: 0 });

        const webhookUrl = this.options.webhookUrl?.({ renderId: renders[0]!.id, token });
        let submitted: { requestId: string } | undefined;
        let error: string | undefined;
        try {
            submitted = await this.provider.submit(job, webhookUrl ? { webhookUrl } : {});
        } catch (err) {
            error = (err as Error).message;
        }
        const out: Render[] = [];
        for (const r of renders) {
            out.push(
                await this.mutateRender(r.id, (x) => {
                    if (submitted) {
                        x.requestId = submitted.requestId;
                        x.submittedAt = nowIso();
                    } else {
                        x.status = "failed";
                        x.error = error;
                        x.completedAt = nowIso();
                    }
                }),
            );
        }
        return out;
    }

    // -- completion -----------------------------------------------------------

    private async siblings(render: Render): Promise<Render[]> {
        if (!render.requestId) return [render];
        const group = await allPages((cursor) => this.storage.records.query("render", { where: { requestId: render.requestId! }, cursor }));
        return group.sort((a, b) => a.outputIndex - b.outputIndex);
    }

    private async finishAll(renders: Render[], patch: Partial<Render>): Promise<void> {
        for (const r of renders) {
            await this.mutateRender(r.id, (x) => {
                if (!PENDING_RENDER_STATUSES.includes(x.status)) return false;
                Object.assign(x, patch, { completedAt: nowIso() });
            });
        }
    }

    /**
     * Brings a pending render up to date with the provider. Safe to call repeatedly and
     * from several processes; finished renders are returned unchanged.
     */
    async syncRender(renderId: string): Promise<Render> {
        const render = await this.getRender(renderId);
        if (!render) throw new NotFoundError("render", renderId);
        if (!PENDING_RENDER_STATUSES.includes(render.status)) return render;
        const age = Date.now() - Date.parse(render.createdAt);
        const group = await this.siblings(render);

        if (!render.requestId) {
            if (age > SUBMIT_GRACE_MS) await this.finishAll(group, { status: "failed", error: "Submission to the provider did not complete" });
            return (await this.getRender(renderId))!;
        }
        if (age > (this.options.renderTimeoutMs ?? 15 * 60 * 1000)) {
            await this.provider.cancel?.(render.endpoint, render.requestId).catch(() => undefined);
            await this.finishAll(group, { status: "failed", error: "Timed out waiting for the provider" });
            return (await this.getRender(renderId))!;
        }

        let state: JobState;
        try {
            state = await this.provider.check(render.endpoint, render.requestId);
        } catch (err) {
            if (isTransientError(err)) return render; // try again on the next sync
            await this.finishAll(group, { status: "failed", error: (err as Error).message });
            return (await this.getRender(renderId))!;
        }

        if (state.state === "queued" || state.state === "running") {
            const status: Render["status"] = state.state;
            for (const r of group) await this.mutateRender(r.id, (x) => (x.status === status || !PENDING_RENDER_STATUSES.includes(x.status) ? false : void (x.status = status)));
        } else if (state.state === "failed") {
            await this.finishAll(group, { status: "failed", error: state.error });
        } else if (state.state === "completed") {
            const outputs = state.outputs;
            for (const r of group) await this.finalize(r, outputs[r.outputIndex]);
        }
        return (await this.getRender(renderId))!;
    }

    private async finalize(render: Render, output: Parameters<typeof materializeOutput>[0] | undefined): Promise<void> {
        const fresh = await this.getRender(render.id);
        if (!fresh || !PENDING_RENDER_STATUSES.includes(fresh.status)) return;
        if (!output) {
            await this.finishAll([fresh], { status: "failed", error: "Provider returned fewer images than requested" });
            return;
        }
        let image;
        try {
            const raw = await materializeOutput(output, mimeForFormat(fresh.params.outputFormat));
            image = await postProcess(raw, fresh.postProcess as PostProcessOptions | undefined, this.options.backgroundRemover);
        } catch (err) {
            if (isTransientError(err)) return; // retried on the next sync
            await this.finishAll([fresh], { status: "failed", error: (err as Error).message });
            return;
        }
        const blobKey = `renders/${fresh.id}.${extFromMime(image.mimeType)}`;
        await this.storage.blobs.put(blobKey, image.data, image.mimeType);
        const info = await imageInfo(image.data);
        const review = await this.runReview(fresh, blobKey, image.mimeType, image.sourceUrl);

        const done = await this.mutateRender(fresh.id, (x) => {
            if (!PENDING_RENDER_STATUSES.includes(x.status)) return false;
            x.status = "succeeded";
            x.image = { blobKey, mimeType: image.mimeType, ...info };
            if (image.sourceUrl) x.sourceUrl = image.sourceUrl;
            if (review) x.review = review;
            x.completedAt = nowIso();
        });

        if (done.status === "succeeded" && done.targetKind === "scene" && !done.review?.flagged) {
            const scene = await this.getEntity("scene", done.targetId);
            if (scene && !scene.selectedRenderId) {
                await this.mutateEntity("scene", scene.id, (s) => (s.selectedRenderId ? false : void (s.selectedRenderId = done.id)));
            }
        }
    }

    private async runReview(render: Render, blobKey: string, mimeType: string, sourceUrl?: string): Promise<RenderReview | undefined> {
        const reviewer = this.options.reviewer;
        if (!reviewer) return undefined;
        try {
            const image = sourceUrl ? { url: sourceUrl, mimeType } : await this.blobToProviderInput(blobKey, mimeType);
            let audience: string | undefined;
            if (render.targetKind === "scene") {
                const scene = await this.getEntity("scene", render.targetId);
                audience = scene?.storyId ? (await this.getEntity("story", scene.storyId))?.audience : undefined;
            } else if (render.targetKind === "story") {
                audience = (await this.getEntity("story", render.targetId))?.audience;
            }
            const result = await reviewer.review({ image: { url: image.url, mimeType }, prompt: render.prompt, references: [], audience });
            return { reviewer: reviewer.name, ...result };
        } catch (err) {
            return { reviewer: reviewer.name, flagged: false, issues: [], error: (err as Error).message };
        }
    }

    /** Syncs every pending render (oldest first). Call from a timer or a scheduled job. */
    async syncPendingRenders(options: { limit?: number } = {}): Promise<{ checked: number; completed: number }> {
        const page = await this.storage.records.query("render", { in: { status: [...PENDING_RENDER_STATUSES] }, limit: options.limit ?? 50 });
        const seen = new Set<string>();
        let checked = 0;
        let completed = 0;
        for (const r of page.items) {
            const key = r.requestId ?? r.id;
            if (seen.has(key)) continue;
            seen.add(key);
            checked++;
            try {
                const after = await this.syncRender(r.id);
                if (!PENDING_RENDER_STATUSES.includes(after.status)) completed++;
            } catch {
                /* keep going; the next round retries */
            }
        }
        return { checked, completed };
    }

    /** Polls pending renders every `intervalMs`. Returns a stop function. */
    startPolling(intervalMs = 5000): () => void {
        let running = false;
        const timer = setInterval(async () => {
            if (running) return;
            running = true;
            try {
                await this.syncPendingRenders();
            } finally {
                running = false;
            }
        }, intervalMs);
        timer.unref?.();
        return () => clearInterval(timer);
    }

    /** Waits until the render leaves the pending states (for scripts and tests). */
    async waitForRender(renderId: string, options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<Render> {
        const deadline = Date.now() + (options.timeoutMs ?? 5 * 60 * 1000);
        for (;;) {
            const r = await this.syncRender(renderId);
            if (!PENDING_RENDER_STATUSES.includes(r.status)) return r;
            if (Date.now() > deadline) return r;
            await new Promise((res) => setTimeout(res, options.pollIntervalMs ?? 2000));
        }
    }

    /**
     * Webhook entry point. The payload is not trusted: the token authenticates the
     * call and the result is fetched from the provider by `syncRender`.
     */
    async handleProviderWebhook(renderId: string, token: string): Promise<Render> {
        const render = await this.getRender(renderId);
        if (!render || !render.webhookToken || !safeEqual(render.webhookToken, token)) throw new NotFoundError("render", renderId);
        return this.syncRender(renderId);
    }

    async cancelRender(renderId: string): Promise<Render> {
        const render = await this.getRender(renderId);
        if (!render) throw new NotFoundError("render", renderId);
        if (!PENDING_RENDER_STATUSES.includes(render.status)) return render;
        if (render.requestId) await this.provider.cancel?.(render.endpoint, render.requestId).catch(() => undefined);
        await this.finishAll(await this.siblings(render), { status: "canceled" });
        return (await this.getRender(renderId))!;
    }

    /** Runs (or re-runs) the configured reviewer on a finished render. */
    async reviewRender(renderId: string): Promise<Render> {
        const render = await this.requireFinishedRender(renderId);
        const review = await this.runReview(render, render.image.blobKey, render.image.mimeType, render.sourceUrl);
        if (!review) throw new ValidationError("No reviewer configured");
        return this.mutateRender(renderId, (x) => void (x.review = review));
    }

    // -- renders --------------------------------------------------------------

    async getRender(id: string): Promise<Render | null> {
        return this.storage.records.get("render", id);
    }

    /** Renders, newest first. */
    async listRenders(filter: RenderListOptions = {}): Promise<Page<Render>> {
        return this.storage.records.query("render", {
            where: {
                ...(filter.targetKind ? { targetKind: filter.targetKind } : {}),
                ...(filter.targetId ? { targetId: filter.targetId } : {}),
                ...(filter.status ? { status: filter.status } : {}),
            },
            order: "desc",
            limit: filter.limit,
            cursor: filter.cursor,
        });
    }

    async deleteRender(id: string): Promise<boolean> {
        const render = await this.getRender(id);
        if (!render) return false;
        if (PENDING_RENDER_STATUSES.includes(render.status) && render.requestId) {
            await this.provider.cancel?.(render.endpoint, render.requestId).catch(() => undefined);
        }
        if (render.targetKind === "scene" && (await this.getEntity("scene", render.targetId))) {
            await this.mutateEntity("scene", render.targetId, (s) => (s.selectedRenderId === id ? void delete s.selectedRenderId : false));
        }
        await this.storage.records.delete("render", id);
        if (render.image) await this.storage.blobs.delete(render.image.blobKey);
        return true;
    }

    /** Chooses which render illustrates the scene (`null` clears the choice). */
    async selectSceneRender(sceneId: string, renderId: string | null): Promise<Scene> {
        if (renderId !== null) {
            const render = await this.getRender(renderId);
            if (!render) throw new NotFoundError("render", renderId);
            if (render.targetKind !== "scene" || render.targetId !== sceneId) {
                throw new ValidationError(`render "${renderId}" does not belong to scene "${sceneId}"`);
            }
            if (render.status !== "succeeded") throw new ValidationError(`render "${renderId}" has no image`);
        }
        return this.mutateEntity("scene", sceneId, (s) => {
            if (renderId === null) delete s.selectedRenderId;
            else s.selectedRenderId = renderId;
        });
    }

    /** Copies a render's image into an entity's reference images (e.g. an approved character design). */
    async promoteRenderToReference(renderId: string, target: Omit<AddReferenceInput, "image">): Promise<ReferenceImage> {
        const render = await this.requireFinishedRender(renderId);
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
        const draft = parse(this.schemas.record as unknown as ZodType<EntityByKind[K]>, this.kind === "scene" ? withSceneIndexes(candidate) : candidate, this.kind);
        await this.engine.assertLinks(draft);
        let record: EntityByKind[K];
        try {
            record = await this.engine.writeEntity(this.kind, draft, 0);
        } catch (err) {
            if (err instanceof VersionConflictError) throw new ConflictError(`${this.kind} "${id}" already exists`);
            throw err;
        }

        if (record.kind === "scene") await this.engine.syncSceneMembership(record.id, undefined, record.storyId);
        return record;
    }

    async get(id: string): Promise<EntityByKind[K] | null> {
        return this.engine.getEntity(this.kind, id);
    }

    async require(id: string): Promise<EntityByKind[K]> {
        return this.engine.requireEntity(this.kind, id);
    }

    async getMany(ids: readonly string[]): Promise<Array<EntityByKind[K] | null>> {
        return this.engine.storage.records.getMany(this.kind, ids) as Promise<Array<EntityByKind[K] | null>>;
    }

    /** Oldest first, paginated. */
    async list(options: ListOptions = {}): Promise<Page<EntityByKind[K]>> {
        return this.engine.storage.records.query(this.kind, {
            ...(options.tag ? { contains: { tags: options.tag } } : {}),
            ...(options.storyId && this.kind === "scene" ? { where: { storyId: options.storyId } } : {}),
            limit: options.limit,
            cursor: options.cursor,
        }) as Promise<Page<EntityByKind[K]>>;
    }

    async update(id: string, patch: PatchInputByKind[K], options: UpdateOptions = {}): Promise<EntityByKind[K]> {
        const existing = await this.require(id);
        if (options.expectedVersion !== undefined && existing.version !== options.expectedVersion) {
            throw new VersionConflictError(this.kind, id, options.expectedVersion, existing.version);
        }
        const data = parse(this.schemas.patch as unknown as ZodType<Record<string, unknown>>, patch, `${this.kind} patch`);
        const merged = mergePatch(existing, data);
        merged.updatedAt = nowIso();
        const draft = parse(this.schemas.record as unknown as ZodType<EntityByKind[K]>, this.kind === "scene" ? withSceneIndexes(merged as unknown as Record<string, unknown>) : merged, this.kind);
        await this.engine.assertLinks(draft);
        const record = await this.engine.writeEntity(this.kind, draft, existing.version);

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

        const renders = await allPages((cursor) => this.engine.listRenders({ targetKind: this.kind, targetId: id, cursor, limit: 200 }));
        for (const render of renders) await this.engine.deleteRender(render.id);
        await this.engine.storage.records.delete(this.kind, id);
        for (const ref of existing.references) await this.engine.storage.blobs.delete(ref.blobKey);
        return true;
    }
}

export function createStoryEngine(options: StoryEngineOptions): StoryEngine {
    return new StoryEngine(options);
}

export type { Accessory, Character, Location, Scene, Story, Style };
