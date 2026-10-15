import { createFalClient, type FalClient } from "@fal-ai/client";
import { ProviderError } from "../errors.js";
import { downloadImage, mimeForFormat, toDataUri } from "./http.js";
import type { BackgroundRemover, GeneratedImage, ImageGenerationRequest, ImageGenerationResult, ImageProvider } from "./types.js";

export const DEFAULT_FAL_ENDPOINT = "fal-ai/gemini-3-pro-image-preview";
export const DEFAULT_FAL_EDIT_ENDPOINT = "fal-ai/gemini-3-pro-image-preview/edit";

export interface FalProviderOptions {
    /** FAL API key; defaults to FAL_KEY / FALAI_API_KEY from the environment. */
    apiKey?: string;
    /** Use an existing client instead of creating one. */
    client?: FalClient;
    defaultEndpoint?: string;
    defaultEditEndpoint?: string;
    /** Called with FAL queue log lines. */
    onLog?: (message: string) => void;
}

function resolveClient(options: FalProviderOptions): FalClient {
    if (options.client) return options.client;
    const credentials = options.apiKey ?? process.env.FAL_KEY ?? process.env.FALAI_API_KEY;
    if (!credentials) {
        throw new ProviderError("FAL credentials missing: pass apiKey or set FAL_KEY / FALAI_API_KEY");
    }
    return createFalClient({ credentials });
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
export function buildFalInput(endpoint: string, req: ImageGenerationRequest): Record<string, unknown> {
    const base: Record<string, unknown> = {
        prompt: req.prompt,
        num_images: req.numImages,
        output_format: req.outputFormat,
    };
    if (endpoint.includes("/flux")) {
        base.image_size = fluxImageSize(req.aspectRatio, req.resolution);
    } else {
        base.aspect_ratio = req.aspectRatio;
        base.resolution = req.resolution;
    }
    if (req.mode === "reference-to-image") {
        base.image_urls = req.references.map((r) => r.url);
    }
    return { ...base, ...(req.providerOptions ?? {}) };
}

export function createFalImageProvider(options: FalProviderOptions = {}): ImageProvider {
    let client: FalClient | undefined;
    return {
        name: "fal",
        async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
            client ??= resolveClient(options);
            const endpoint =
                req.mode === "reference-to-image"
                    ? (req.editEndpoint ?? options.defaultEditEndpoint ?? DEFAULT_FAL_EDIT_ENDPOINT)
                    : (req.endpoint ?? options.defaultEndpoint ?? process.env.IMGEN_ENDPOINT ?? DEFAULT_FAL_ENDPOINT);

            let result;
            try {
                result = await client.subscribe(endpoint, {
                    input: buildFalInput(endpoint, req),
                    logs: Boolean(options.onLog),
                    onQueueUpdate: (update) => {
                        if (options.onLog && update.status === "IN_PROGRESS") {
                            update.logs?.forEach((l) => options.onLog?.(l.message));
                        }
                    },
                });
            } catch (err) {
                throw new ProviderError(`FAL request to ${endpoint} failed: ${(err as Error).message}`, err);
            }

            const images = (result.data as { images?: Array<{ url?: string }> } | undefined)?.images ?? [];
            const urls = images.map((i) => i.url).filter((u): u is string => typeof u === "string" && u.length > 0);
            if (urls.length === 0) throw new ProviderError(`FAL endpoint ${endpoint} returned no images`);

            const fallbackMime = mimeForFormat(req.outputFormat);
            return { endpoint, images: await Promise.all(urls.map((u) => downloadImage(u, fallbackMime))) };
        },
    };
}

/** Background removal via `fal-ai/imageutils/rembg` (accepts data URIs, so local images work). */
export function createFalBackgroundRemover(options: Pick<FalProviderOptions, "apiKey" | "client"> = {}): BackgroundRemover {
    let client: FalClient | undefined;
    return {
        name: "fal-rembg",
        async removeBackground(image: GeneratedImage): Promise<GeneratedImage> {
            client ??= resolveClient(options);
            const result = await client.subscribe("fal-ai/imageutils/rembg", {
                input: { image_url: image.sourceUrl ?? toDataUri(image.data, image.mimeType), crop_to_bbox: true },
            });
            const url = (result.data as { image?: { url?: string } } | undefined)?.image?.url;
            if (!url) throw new ProviderError("fal rembg returned no image");
            return downloadImage(url, "image/png");
        },
    };
}
