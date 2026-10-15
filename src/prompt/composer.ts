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
    entityKind: EntityKind;
    entityId: string;
    entityName: string;
    reference: ReferenceImage;
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
}

export interface SceneContext {
    scene: Scene;
    story?: Story;
    style?: Style;
    location?: Location;
    characters: ReadonlyMap<string, Character>;
    accessories: ReadonlyMap<string, Accessory>;
}

// ---------------------------------------------------------------------------
// Reference planning
// ---------------------------------------------------------------------------

function orderedRefs(entity: AnyEntity): ReferenceImage[] {
    return [...entity.references].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/**
 * Picks reference images for the given entities (in priority order) within the budget.
 * Round-robin: every entity gets its first (primary) image before any entity gets a
 * second one, so a crowded scene never drops a character entirely. The resulting list
 * keeps images of the same entity adjacent.
 */
export function planReferences(entities: AnyEntity[], budget: ReferenceBudget): PlannedReference[] {
    const unique = [...new Map(entities.map((e) => [`${e.kind}:${e.id}`, e])).values()];
    const queues = unique.map((e) => ({ entity: e, refs: orderedRefs(e).slice(0, Math.max(0, budget.maxPerEntity)) }));
    const taken = new Map<string, ReferenceImage[]>();
    let total = 0;

    for (let round = 0; total < budget.maxReferences; round++) {
        let progressed = false;
        for (const q of queues) {
            if (total >= budget.maxReferences) break;
            const ref = q.refs[round];
            if (!ref) continue;
            const key = `${q.entity.kind}:${q.entity.id}`;
            taken.set(key, [...(taken.get(key) ?? []), ref]);
            total++;
            progressed = true;
        }
        if (!progressed) break;
    }

    const out: PlannedReference[] = [];
    for (const { entity } of queues) {
        for (const reference of taken.get(`${entity.kind}:${entity.id}`) ?? []) {
            out.push({ index: out.length + 1, entityKind: entity.kind, entityId: entity.id, entityName: entity.name, reference });
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
    const details = lines(
        a.description?.trim(),
        field("material", a.material),
        field("colors", a.colors),
        field("size", a.size),
        a.promptHint,
    );
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

function referenceLegend(refs: PlannedReference[]): string | undefined {
    if (refs.length === 0) return undefined;
    const roles: Record<EntityKind, string> = {
        character: "character",
        accessory: "object",
        location: "location",
        style: "style sample",
        scene: "scene",
        story: "story",
    };
    const legend = refs.map((r) => {
        const extra = lines(r.reference.view, r.reference.label, r.reference.notes).join(" — ");
        return `Image ${r.index}: ${roles[r.entityKind]} "${r.entityName}"${extra ? ` (${extra})` : ""}`;
    });
    const rules = [
        "Character, object and location images are the ground truth for identity and design: keep faces, hairstyles, body proportions, colors, outfits and distinctive details identical to them.",
        "Do not copy the backgrounds, poses or framing of the reference images unless the description asks for it.",
    ];
    if (refs.some((r) => r.entityKind === "style")) {
        rules.push("Style samples define only the rendering technique, palette and line quality — never copy their content.");
    }
    return `${section("REFERENCE IMAGES (attached in this order):", legend)}\n${rules.join("\n")}`;
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

export function composeScenePrompt(ctx: SceneContext, options: ComposeOptions): ComposedPrompt {
    const { scene, story, style, location } = ctx;

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

    const refs = planReferences(
        [
            ...castEntries.map((e) => e.character),
            ...castAccessories.flat(),
            ...sceneProps,
            ...(location ? [location] : []),
            ...(style ? [style] : []),
        ],
        options.budget,
    );

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
        location
            ? describeLocation(location, timeOfDay, weather, refs)
            : section("SETTING:", lines(field("Time of day", timeOfDay), field("Weather", weather))),
        castCount > 0 &&
            `CHARACTERS — exactly ${castCount} ${castCount === 1 ? "character appears" : "characters appear"}, each exactly once:\n${characterBlocks.join("\n")}`,
        sceneProps.length > 0 && section("PROPS IN THE SCENE:", sceneProps.map((a) => describeAccessory(a, refs))),
        section(`SCENE — "${scene.name}":`, lines(sentence(scene.description), scene.promptHint)),
        section("CAMERA & ATMOSPHERE:", atmosphere),
        constraints(style, [...(style?.negative ?? []), ...scene.negative]),
        options.extraInstructions,
    );

    const generation = resolveGeneration(
        [style?.generation, story?.generation, scene.generation, options.overrides],
        options.defaults,
    );

    return {
        prompt: blocks.join("\n\n"),
        mode: refs.length > 0 ? "reference-to-image" : "text-to-image",
        references: refs,
        generation,
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
    accessory:
        "Object design reference: the object alone, centered and fully visible, three-quarter view, plain light neutral background, even soft lighting.",
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
        // An entity's own preview may use its full per-entity budget plus others.
        options.budget,
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
                        `Featured characters: ${characters.map((c) => `${c.name}${imageTag(refs, "character", c.id)}${c.description ? ` — ${c.description}` : ""}`).join("; ")}`,
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

    const generation = resolveGeneration(
        [effectiveStyle?.generation, entity.kind === "story" ? entity.generation : undefined, options.overrides],
        options.defaults,
    );

    return {
        prompt: blocks.join("\n\n"),
        mode: refs.length > 0 ? "reference-to-image" : "text-to-image",
        references: refs,
        generation,
    };
}
