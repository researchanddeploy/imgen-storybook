import type {
    Accessory,
    AnyEntity,
    CastMember,
    Character,
    EntityKind,
    GenerationSettings,
    Location,
    OutputFormat,
    ReferenceImage,
    Render,
    Scene,
    Story,
    Style,
} from "../domain/schemas.js";

export interface ReferenceBudget {
    /** Total images sent to the model (Gemini 3 Pro Image accepts up to 14). */
    maxReferences: number;
    /** Images taken from a single entity. */
    maxPerEntity: number;
}

export interface PlannedReference {
    /** 1-based position in the image list ("Image 1"). */
    index: number;
    /** entity = an entity's reference image; continuity = another page; base = the image being edited. */
    role: "entity" | "continuity" | "base";
    blobKey: string;
    mimeType: string;
    entityKind?: EntityKind;
    entityId?: string;
    entityName?: string;
    reference?: ReferenceImage;
    renderId?: string;
    /** Human-readable description used in the legend. */
    description?: string;
}

export interface ResolvedGeneration {
    endpoint?: string;
    editEndpoint?: string;
    aspectRatio: string;
    resolution: string;
    outputFormat: OutputFormat;
}

export interface ComposedPrompt {
    prompt: string;
    mode: "text-to-image" | "reference-to-image";
    references: PlannedReference[];
    generation: ResolvedGeneration;
}

export interface ComposeOptions {
    budget: ReferenceBudget;
    /** Lowest-priority generation defaults (engine-level). */
    defaults: ResolvedGeneration;
    /** Highest-priority overrides (per call). */
    overrides?: GenerationSettings;
    /** Free text appended at the end of the prompt. */
    extraInstructions?: string;
    /** Number of images placed before the planned references (e.g. 1 for a refinement base image). */
    indexOffset?: number;
}

export interface ContinuityAnchor {
    scene: Scene;
    render: Render & { image: NonNullable<Render["image"]> };
}

export interface SceneContext {
    scene: Scene;
    story?: Story;
    style?: Style;
    location?: Location;
    characters: ReadonlyMap<string, Character>;
    accessories: ReadonlyMap<string, Accessory>;
    /** Selected illustrations of other pages to keep continuity with. */
    continuity?: ContinuityAnchor[];
}

const entityKey = (kind: EntityKind, id: string) => `${kind}:${id}`;

// ---------------------------------------------------------------------------
// Reference planning
// ---------------------------------------------------------------------------

/** Explicit reference choices per entity (`kind:id` → reference ids, in order). */
export type ReferenceSelections = ReadonlyMap<string, readonly string[]>;

function orderedRefs(entity: AnyEntity, selections?: ReferenceSelections): ReferenceImage[] {
    const chosen = selections?.get(entityKey(entity.kind, entity.id));
    if (chosen?.length) {
        const byId = new Map(entity.references.map((r) => [r.id, r]));
        return chosen.map((id) => byId.get(id)).filter((r): r is ReferenceImage => r !== undefined);
    }
    return [...entity.references].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/**
 * Picks reference images for the given entities (in priority order) within the budget.
 * Round-robin: every entity gets its first (primary or explicitly chosen) image before
 * any entity gets a second one, so a crowded scene never drops a character entirely.
 * The resulting list keeps images of the same entity adjacent.
 */
export function planReferences(
    entities: AnyEntity[],
    budget: ReferenceBudget,
    selections?: ReferenceSelections,
    indexOffset = 0,
): PlannedReference[] {
    const unique = [...new Map(entities.map((e) => [entityKey(e.kind, e.id), e])).values()];
    const queues = unique.map((e) => ({ entity: e, refs: orderedRefs(e, selections).slice(0, Math.max(0, budget.maxPerEntity)) }));
    const taken = new Map<string, ReferenceImage[]>();
    let total = 0;

    for (let round = 0; total < budget.maxReferences; round++) {
        let progressed = false;
        for (const q of queues) {
            if (total >= budget.maxReferences) break;
            const ref = q.refs[round];
            if (!ref) continue;
            const key = entityKey(q.entity.kind, q.entity.id);
            taken.set(key, [...(taken.get(key) ?? []), ref]);
            total++;
            progressed = true;
        }
        if (!progressed) break;
    }

    const out: PlannedReference[] = [];
    for (const { entity } of queues) {
        for (const reference of taken.get(entityKey(entity.kind, entity.id)) ?? []) {
            out.push({
                index: indexOffset + out.length + 1,
                role: "entity",
                blobKey: reference.blobKey,
                mimeType: reference.mimeType,
                entityKind: entity.kind,
                entityId: entity.id,
                entityName: entity.name,
                reference,
            });
        }
    }
    return out;
}

function imageTag(refs: PlannedReference[], kind: EntityKind, id: string): string {
    const idx = refs.filter((r) => r.entityKind === kind && r.entityId === id).map((r) => r.index);
    if (idx.length === 0) return "";
    return idx.length === 1 ? ` [see Image ${idx[0]}]` : ` [see Images ${idx.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

type Line = string | undefined | null | false;

function lines(...items: Line[]): string[] {
    return items.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
}

function field(label: string, value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value.length ? `${label}: ${value.join(", ")}` : undefined;
    return value && value.trim() ? `${label}: ${value.trim()}` : undefined;
}

function section(title: string, body: string[]): string | undefined {
    return body.length ? `${title}\n${body.map((l) => `- ${l}`).join("\n")}` : undefined;
}

function sentence(value: string | undefined): string | undefined {
    const v = value?.trim();
    if (!v) return undefined;
    return /[.!?]$/.test(v) ? v : `${v}.`;
}

function describeStyle(style: Style | undefined): string | undefined {
    if (!style) return undefined;
    return section(
        `ART STYLE — "${style.name}" (apply consistently to the whole image):`,
        lines(
            field("Medium", style.medium),
            sentence(style.description),
            field("Palette", style.palette),
            field("Line work", style.lineWork),
            field("Shading", style.shading),
            field("Lighting", style.lighting),
            field("Texture", style.texture),
            field("Mood", style.mood),
            style.promptHint,
        ),
    );
}

function describeAppearance(c: Character): string | undefined {
    const a = c.appearance;
    const parts = lines(
        field("species", a.species),
        field("age", a.age),
        field("gender", a.gender),
        field("body type", a.bodyType),
        field("height", a.height),
        field("skin", a.skin),
        field("hair", a.hair),
        field("eyes", a.eyes),
        field("face", a.face),
        field("distinguishing features", a.distinguishingFeatures),
    );
    return parts.length ? `Appearance — ${parts.join("; ")}` : undefined;
}

function describeAccessory(a: Accessory, refs: PlannedReference[]): string {
    const details = lines(a.description?.trim(), field("material", a.material), field("colors", a.colors), field("size", a.size), a.promptHint);
    return `${a.name}${imageTag(refs, "accessory", a.id)}${details.length ? ` — ${details.join("; ")}` : ""}`;
}

function describeLocation(loc: Location, timeOfDay: string | undefined, weather: string | undefined, refs: PlannedReference[]) {
    return section(
        `SETTING — "${loc.name}"${imageTag(refs, "location", loc.id)}:`,
        lines(
            sentence(loc.description),
            field("Setting", loc.setting),
            field("Era", loc.era),
            field("Key features", loc.keyFeatures),
            field("Palette", loc.palette),
            field("Time of day", timeOfDay),
            field("Weather", weather),
            loc.promptHint,
        ),
    );
}

const ROLE_NAMES: Record<EntityKind, string> = {
    character: "character",
    accessory: "object",
    location: "location",
    style: "style sample",
    scene: "scene",
    story: "story",
};

function referenceLegend(refs: PlannedReference[]): string | undefined {
    if (refs.length === 0) return undefined;
    const legend = refs.map((r) => {
        if (r.role === "base") return `Image ${r.index}: the current illustration to edit`;
        if (r.role === "continuity") return `Image ${r.index}: ${r.description ?? "another page of this story"} (continuity anchor)`;
        const extra = lines(r.reference?.view, r.reference?.label, r.reference?.notes).join(" — ");
        return `Image ${r.index}: ${ROLE_NAMES[r.entityKind!]} "${r.entityName}"${extra ? ` (${extra})` : ""}`;
    });
    const rules: string[] = [];
    if (refs.some((r) => r.role === "entity" && r.entityKind !== "style")) {
        rules.push(
            "Character, object and location images are the ground truth for identity and design: keep faces, hairstyles, body proportions, colors, outfits and distinctive details identical to them.",
            "Do not copy the backgrounds, poses or framing of the reference images unless the description asks for it.",
        );
    }
    if (refs.some((r) => r.entityKind === "style")) {
        rules.push("Style samples define only the rendering technique, palette and line quality — never copy their content.");
    }
    if (refs.some((r) => r.role === "continuity")) {
        rules.push(
            "Continuity anchors are other pages of the same book: keep rendering, palette, lighting and recurring details consistent with them, but compose this scene fresh.",
        );
    }
    return `${section("REFERENCE IMAGES (attached in this order):", legend)}${rules.length ? `\n${rules.join("\n")}` : ""}`;
}

function constraints(style: Style | undefined, negatives: string[]): string | undefined {
    return section(
        "CONSTRAINTS:",
        lines(
            !style?.allowText && "No text, letters, captions, speech bubbles, signatures or watermarks anywhere in the image.",
            "Exactly one illustration — no panels, collages, borders or model-sheet layouts.",
            negatives.length > 0 && `Avoid: ${[...new Set(negatives)].join(", ")}.`,
        ),
    );
}

export function resolveGeneration(layers: Array<GenerationSettings | undefined>, defaults: ResolvedGeneration): ResolvedGeneration {
    const out: ResolvedGeneration = { ...defaults };
    for (const layer of layers) {
        if (!layer) continue;
        for (const [k, v] of Object.entries(layer)) {
            if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[k] = v;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Scene composition
// ---------------------------------------------------------------------------

export function accessoryIdsForCastMember(member: CastMember, character: Character | undefined): string[] {
    const defaults = member.includeDefaultAccessories === false ? [] : (character?.defaultAccessoryIds ?? []);
    return [...new Set([...defaults, ...(member.accessoryIds ?? [])])];
}

/** Scene-level reference choices: `scene.referenceSelections` plus each cast member's `referenceIds`. */
export function sceneSelections(scene: Scene): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const s of scene.referenceSelections) map.set(entityKey(s.entityKind, s.entityId), s.referenceIds);
    for (const m of scene.cast) if (m.referenceIds?.length) map.set(entityKey("character", m.characterId), m.referenceIds);
    return map;
}

export function composeScenePrompt(ctx: SceneContext, options: ComposeOptions): ComposedPrompt {
    const { scene, story, style, location } = ctx;
    const offset = options.indexOffset ?? 0;

    const castEntries = scene.cast
        .map((member) => ({ member, character: ctx.characters.get(member.characterId) }))
        .filter((e): e is { member: CastMember; character: Character } => e.character !== undefined);

    const carried = new Set<string>();
    const castAccessories = castEntries.map(({ member, character }) => {
        const items = accessoryIdsForCastMember(member, character)
            .map((id) => ctx.accessories.get(id))
            .filter((a): a is Accessory => a !== undefined);
        items.forEach((a) => carried.add(a.id));
        return items;
    });
    const sceneProps = scene.accessoryIds
        .filter((id) => !carried.has(id))
        .map((id) => ctx.accessories.get(id))
        .filter((a): a is Accessory => a !== undefined);

    // Continuity anchors get at most a third of the budget and never crowd out entity references.
    const continuity = (ctx.continuity ?? []).slice(0, Math.max(0, Math.floor(options.budget.maxReferences / 3)));
    const entityRefs = planReferences(
        [...castEntries.map((e) => e.character), ...castAccessories.flat(), ...sceneProps, ...(location ? [location] : []), ...(style ? [style] : [])],
        { ...options.budget, maxReferences: options.budget.maxReferences - continuity.length },
        sceneSelections(scene),
        offset,
    );
    const refs: PlannedReference[] = [
        ...entityRefs,
        ...continuity.map((c, i) => ({
            index: offset + entityRefs.length + i + 1,
            role: "continuity" as const,
            blobKey: c.render.image.blobKey,
            mimeType: c.render.image.mimeType,
            renderId: c.render.id,
            description: `page "${c.scene.name}"`,
        })),
    ];

    const characterBlocks = castEntries.map(({ member, character }, i) => {
        const items = castAccessories[i] ?? [];
        const body = lines(
            sentence(character.description),
            describeAppearance(character),
            field("Outfit", member.outfit ?? character.outfit),
            items.length > 0 && `Carries / wears: ${items.map((a) => describeAccessory(a, refs)).join("; ")}`,
            field("Personality", character.personality),
            character.promptHint,
            field("Position in frame", member.position),
            field("Pose", member.pose),
            field("Action", member.action),
            field("Expression", member.expression),
        );
        return `${i + 1}. ${character.name}${imageTag(refs, "character", character.id)}\n${body.map((l) => `   - ${l}`).join("\n")}`;
    });

    const castCount = castEntries.length;
    const atmosphere = lines(
        field("Lighting", scene.lighting),
        field("Mood", scene.mood),
        field("Shot", scene.camera.shot),
        field("Camera angle", scene.camera.angle),
        field("Lens", scene.camera.lens),
        field("Composition", scene.camera.composition),
    );

    const timeOfDay = scene.timeOfDay ?? location?.defaultTimeOfDay;
    const weather = scene.weather ?? location?.defaultWeather;

    const blocks = lines(
        `Create one finished illustration for an illustrated story${story ? ` titled "${story.name}"` : ""}.`,
        story?.audience && `Intended audience: ${story.audience} — keep the imagery age-appropriate.`,
        referenceLegend(refs),
        describeStyle(style),
        location ? describeLocation(location, timeOfDay, weather, refs) : section("SETTING:", lines(field("Time of day", timeOfDay), field("Weather", weather))),
        castCount > 0 &&
            `CHARACTERS — exactly ${castCount} ${castCount === 1 ? "character appears" : "characters appear"}, each exactly once:\n${characterBlocks.join("\n")}`,
        sceneProps.length > 0 && section("PROPS IN THE SCENE:", sceneProps.map((a) => describeAccessory(a, refs))),
        section(`SCENE — "${scene.name}":`, lines(sentence(scene.description), scene.promptHint)),
        section("CAMERA & ATMOSPHERE:", atmosphere),
        constraints(style, [...(style?.negative ?? []), ...scene.negative]),
        options.extraInstructions,
    );

    return {
        prompt: blocks.join("\n\n"),
        mode: refs.length > 0 || offset > 0 ? "reference-to-image" : "text-to-image",
        references: refs,
        generation: resolveGeneration([style?.generation, story?.generation, scene.generation, options.overrides], options.defaults),
    };
}

// ---------------------------------------------------------------------------
// Refinement of an existing render
// ---------------------------------------------------------------------------

/**
 * Wraps a composition (built with `indexOffset: 1`) into an edit instruction for the
 * image being refined, which becomes Image 1.
 */
export function composeRefinementPrompt(
    base: { blobKey: string; mimeType: string; renderId: string },
    composed: ComposedPrompt,
    instructions: string,
): ComposedPrompt {
    const header = [
        "Edit Image 1 — the current illustration — and apply ONLY this change:",
        instructions.trim(),
        "",
        "Keep everything else exactly as in Image 1: composition, framing, characters, poses, colors and art style.",
        "The description below is the original brief for this illustration; use it and the other reference images to keep everything consistent.",
    ].join("\n");
    return {
        ...composed,
        mode: "reference-to-image",
        prompt: `${header}\n\n---\n\n${composed.prompt}`,
        references: [{ index: 1, role: "base", blobKey: base.blobKey, mimeType: base.mimeType, renderId: base.renderId }, ...composed.references],
    };
}

// ---------------------------------------------------------------------------
// Entity previews (character design, object, location, style sample, story cover)
// ---------------------------------------------------------------------------

export interface PreviewContext {
    entity: AnyEntity;
    style?: Style;
    /** Accessories to show with a character (its defaults). */
    accessories?: Accessory[];
    /** For a story cover: the characters featured. */
    characters?: Character[];
}

const DEFAULT_PREVIEW_FRAMING: Record<EntityKind, string> = {
    character:
        "Character design reference: one full-body view of the character, neutral relaxed standing pose facing the viewer, plain light neutral background, even soft lighting, nothing else in frame.",
    accessory: "Object design reference: the object alone, centered and fully visible, three-quarter view, plain light neutral background, even soft lighting.",
    location: "Establishing wide shot of the location, no characters, showing its key features clearly.",
    style: "A sample illustration that showcases this art style: a cozy cottage at the edge of a forest, with a winding path and a few flowers.",
    scene: "",
    story: "Front cover illustration for the book (leave calm space in the upper third for a title to be added later).",
};

export function composeEntityPreviewPrompt(ctx: PreviewContext, options: ComposeOptions & { framing?: string }): ComposedPrompt {
    const { entity, style } = ctx;
    const accessories = ctx.accessories ?? [];
    const characters = ctx.characters ?? [];

    const refs = planReferences(
        [entity, ...accessories, ...characters, ...(style && style.id !== entity.id ? [style] : [])],
        options.budget,
        undefined,
        options.indexOffset ?? 0,
    );

    let subject: string | undefined;
    switch (entity.kind) {
        case "character":
            subject = section(
                `CHARACTER — "${entity.name}"${imageTag(refs, "character", entity.id)}:`,
                lines(
                    sentence(entity.description),
                    describeAppearance(entity),
                    field("Outfit", entity.outfit),
                    accessories.length > 0 && `Carries / wears: ${accessories.map((a) => describeAccessory(a, refs)).join("; ")}`,
                    field("Personality (convey through posture and expression)", entity.personality),
                    entity.promptHint,
                ),
            );
            break;
        case "accessory":
            subject = section("OBJECT:", [describeAccessory(entity, refs)]);
            break;
        case "location":
            subject = describeLocation(entity, entity.defaultTimeOfDay, entity.defaultWeather, refs);
            break;
        case "story":
            subject = section(
                `STORY — "${entity.name}":`,
                lines(
                    sentence(entity.synopsis ?? entity.description),
                    entity.audience && `Intended audience: ${entity.audience} — keep the imagery age-appropriate.`,
                    characters.length > 0 &&
                        `Featured characters: ${characters
                            .map((c) => `${c.name}${imageTag(refs, "character", c.id)}${c.description ? ` — ${c.description}` : ""}`)
                            .join("; ")}`,
                    entity.promptHint,
                ),
            );
            break;
        case "style":
        case "scene":
            subject = undefined;
            break;
    }

    const effectiveStyle = entity.kind === "style" ? entity : style;
    const blocks = lines(
        options.framing ?? DEFAULT_PREVIEW_FRAMING[entity.kind],
        referenceLegend(refs),
        describeStyle(effectiveStyle),
        subject,
        constraints(effectiveStyle, effectiveStyle?.negative ?? []),
        options.extraInstructions,
    );

    return {
        prompt: blocks.join("\n\n"),
        mode: refs.length > 0 || (options.indexOffset ?? 0) > 0 ? "reference-to-image" : "text-to-image",
        references: refs,
        generation: resolveGeneration(
            [effectiveStyle?.generation, entity.kind === "story" ? entity.generation : undefined, options.overrides],
            options.defaults,
        ),
    };
}
