import { createFalClient, type FalClient } from "@fal-ai/client";
import { realValue, requireFalKey } from "../config.js";
import { ProviderError } from "../errors.js";
import { isTransientError, withRetry } from "../retry.js";
import { downloadImage, toDataUri } from "./http.js";
import type {
    BackgroundRemover,
    GeneratedImage,
    ImageJob,
    ImageProvider,
    ImageReviewer,
    JobState,
    ProviderJob,
    ProviderOutput,
    ReviewInput,
    SubmitResult,
} from "./types.js";

export const DEFAULT_FAL_ENDPOINT = "fal-ai/gemini-3-pro-image-preview";
export const DEFAULT_FAL_EDIT_ENDPOINT = "fal-ai/gemini-3-pro-image-preview/edit";
/** Not yet verified against a live account — check before relying on it. */
export const DEFAULT_FAL_UPSCALE_ENDPOINT = "fal-ai/esrgan";
/** Not yet verified against a live account — check before relying on it. */
export const DEFAULT_FAL_VISION_ENDPOINT = "fal-ai/any-llm/vision";

export interface FalAuthOptions {
    /** FAL API key; defaults to FAL_KEY / FALAI_API_KEY. Placeholder values count as missing. */
    apiKey?: string;
    /** Use an existing client instead of creating one. */
    client?: FalClient;
}

export interface FalProviderOptions extends FalAuthOptions {
    defaultEndpoint?: string;
    defaultEditEndpoint?: string;
    defaultUpscaleEndpoint?: string;
    /** Builds the upscaler input; default `{ image_url, scale }`. */
    buildUpscaleInput?: (job: { imageUrl: string; scale: number }) => Record<string, unknown>;
    /** How long an uploaded reference is assumed to stay available. Default 24 h. */
    uploadTtlMs?: number;
}

/** Lazily creates the client so a missing key only fails when FAL is actually used. */
function clientFactory(options: FalAuthOptions): () => FalClient {
    let client = options.client;
    return () => {
        if (client) return client;
        const credentials = requireFalKey({
            falKey: realValue(options.apiKey) ?? realValue(process.env.FAL_KEY) ?? realValue(process.env.FALAI_API_KEY),
        });
        client = createFalClient({ credentials });
        return client;
    };
}

function fluxImageSize(aspectRatio: string, resolution: string): string {
    switch (aspectRatio) {
        case "1:1":
            return resolution.toUpperCase() !== "1K" ? "square_hd" : "square";
        case "4:3":
            return "landscape_4_3";
        case "3:4":
            return "portrait_4_3";
        case "16:9":
            return "landscape_16_9";
        case "9:16":
            return "portrait_16_9";
        default:
            return "square";
    }
}

/** Builds the endpoint input. Flux endpoints use `image_size`, Gemini-style ones `aspect_ratio` + `resolution`. */
export function buildFalInput(endpoint: string, job: ImageJob): Record<string, unknown> {
    const base: Record<string, unknown> = {
        prompt: job.prompt,
        num_images: job.numImages,
        output_format: job.outputFormat,
    };
    if (endpoint.includes("/flux")) {
        base.image_size = fluxImageSize(job.aspectRatio, job.resolution);
    } else {
        base.aspect_ratio = job.aspectRatio;
        base.resolution = job.resolution;
    }
    if (job.mode === "reference-to-image") {
        base.image_urls = job.references.map((r) => r.url);
    }
    return { ...base, ...(job.providerOptions ?? {}) };
}

/** Accepts both `{ images: [{url}] }` (generators) and `{ image: {url} }` (upscalers, rembg). */
export function parseFalOutputs(data: unknown): ProviderOutput[] {
    const d = data as
        | { images?: Array<{ url?: string; content_type?: string }>; image?: { url?: string; content_type?: string } }
        | undefined;
    const list = d?.images ?? (d?.image ? [d.image] : []);
    return list
        .filter((i) => typeof i?.url === "string" && i.url.length > 0)
        .map((i) => ({ url: i.url!, ...(i.content_type ? { mimeType: i.content_type } : {}) }));
}

function errorMessage(err: unknown): string {
    const e = err as { message?: string; body?: { detail?: unknown } };
    const detail = e?.body?.detail;
    if (detail) return `${e.message ?? "FAL error"}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    return e?.message ?? String(err);
}

export function createFalImageProvider(options: FalProviderOptions = {}): ImageProvider {
    const client = clientFactory(options);
    const uploadTtlMs = options.uploadTtlMs ?? 24 * 60 * 60 * 1000;

    const resolveEndpoint = (job: ProviderJob): string => {
        if (job.type === "upscale") return job.endpoint ?? options.defaultUpscaleEndpoint ?? DEFAULT_FAL_UPSCALE_ENDPOINT;
        return job.mode === "reference-to-image"
            ? (job.editEndpoint ?? options.defaultEditEndpoint ?? DEFAULT_FAL_EDIT_ENDPOINT)
            : (job.endpoint ?? options.defaultEndpoint ?? realValue(process.env.IMGEN_ENDPOINT) ?? DEFAULT_FAL_ENDPOINT);
    };

    const buildInput = (endpoint: string, job: ProviderJob): Record<string, unknown> => {
        if (job.type === "image") return buildFalInput(endpoint, job);
        const input = options.buildUpscaleInput?.({ imageUrl: job.image.url, scale: job.scale }) ?? {
            image_url: job.image.url,
            scale: job.scale,
        };
        return { ...input, ...(job.providerOptions ?? {}) };
    };

    return {
        name: "fal",
        resolveEndpoint,

        async submit(job, submitOptions = {}): Promise<SubmitResult> {
            const endpoint = resolveEndpoint(job);
            try {
                const res = await withRetry(() =>
                    client().queue.submit(endpoint, {
                        input: buildInput(endpoint, job),
                        ...(submitOptions.webhookUrl ? { webhookUrl: submitOptions.webhookUrl } : {}),
                    }),
                );
                return { requestId: res.request_id, endpoint };
            } catch (err) {
                throw new ProviderError(`FAL submit to ${endpoint} failed: ${errorMessage(err)}`, err);
            }
        },

        async check(endpoint, requestId): Promise<JobState> {
            const status = await withRetry(() => client().queue.status(endpoint, { requestId }));
            if (status.status === "IN_QUEUE") return { state: "queued" };
            if (status.status === "IN_PROGRESS") return { state: "running" };
            try {
                const result = await withRetry(() => client().queue.result(endpoint, { requestId }));
                const outputs = parseFalOutputs(result.data);
                return outputs.length ? { state: "completed", outputs } : { state: "failed", error: `${endpoint} returned no images` };
            } catch (err) {
                if (isTransientError(err)) throw err;
                return { state: "failed", error: errorMessage(err) };
            }
        },

        async cancel(endpoint, requestId) {
            await client().queue.cancel(endpoint, { requestId });
        },

        async uploadImage(data, mimeType) {
            const url = await withRetry(() => client().storage.upload(new Blob([Buffer.from(data)], { type: mimeType })));
            return { url, expiresAt: new Date(Date.now() + uploadTtlMs).toISOString() };
        },
    };
}

/** Background removal via `fal-ai/imageutils/rembg` (accepts data URIs, so local images work). */
export function createFalBackgroundRemover(options: FalAuthOptions = {}): BackgroundRemover {
    const client = clientFactory(options);
    return {
        name: "fal-rembg",
        async removeBackground(image: GeneratedImage): Promise<GeneratedImage> {
            const result = await withRetry(() =>
                client().subscribe("fal-ai/imageutils/rembg", {
                    input: { image_url: image.sourceUrl ?? toDataUri(image.data, image.mimeType), crop_to_bbox: true },
                }),
            );
            const url = parseFalOutputs(result.data)[0]?.url;
            if (!url) throw new ProviderError("fal rembg returned no image");
            return downloadImage(url, "image/png");
        },
    };
}

export interface FalVisionReviewerOptions extends FalAuthOptions {
    /** Vision-LLM endpoint. Unverified default; confirm on a live account. */
    endpoint?: string;
    /** Model name passed to the endpoint. */
    model?: string;
    /** Override the request body if the endpoint's input differs. */
    buildInput?: (args: { prompt: string; systemPrompt: string; imageUrl: string; model?: string }) => Record<string, unknown>;
}

const REVIEW_SYSTEM_PROMPT =
    "You are a strict QA reviewer for story-book illustrations. Answer ONLY with JSON: " +
    '{"flagged": boolean, "consistencyScore": number between 0 and 1, "issues": string[]}. ' +
    "flagged = true if the image contains violence, nudity, gore, frightening or otherwise unsuitable content for the stated audience. " +
    "consistencyScore = how well the image matches the description (characters, outfits, objects, setting, number of characters). " +
    "issues = short concrete problems (wrong hair color, extra character, text in image...).";

/** Uses a vision LLM on FAL to flag unsuitable content and score consistency with the description. */
export function createFalVisionReviewer(options: FalVisionReviewerOptions = {}): ImageReviewer {
    const client = clientFactory(options);
    const endpoint = options.endpoint ?? DEFAULT_FAL_VISION_ENDPOINT;
    return {
        name: `fal-vision:${endpoint}`,
        async review(input: ReviewInput) {
            const prompt = `${input.audience ? `Audience: ${input.audience}.\n` : ""}Description the illustration was generated from:\n${input.prompt}`;
            const body = options.buildInput?.({ prompt, systemPrompt: REVIEW_SYSTEM_PROMPT, imageUrl: input.image.url, model: options.model }) ?? {
                prompt,
                system_prompt: REVIEW_SYSTEM_PROMPT,
                image_url: input.image.url,
                ...(options.model ? { model: options.model } : {}),
            };
            const result = await withRetry(() => client().subscribe(endpoint, { input: body }));
            const text = String((result.data as { output?: unknown })?.output ?? "");
            const json = /\{[\s\S]*\}/.exec(text)?.[0];
            if (!json) throw new ProviderError(`Reviewer returned no JSON: ${text.slice(0, 200)}`);
            const parsed = JSON.parse(json) as { flagged?: unknown; consistencyScore?: unknown; issues?: unknown };
            const score = Number(parsed.consistencyScore);
            return {
                flagged: parsed.flagged === true,
                ...(Number.isFinite(score) ? { consistencyScore: Math.min(1, Math.max(0, score)) } : {}),
                issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).slice(0, 20) : [],
            };
        },
    };
}
