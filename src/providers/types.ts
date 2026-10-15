import type { OutputFormat, RenderReview } from "../domain/schemas.js";

export interface ProviderImageInput {
    /** An http(s) URL or a `data:` URI. */
    url: string;
    mimeType: string;
}

/** Generate a new image from a prompt, optionally conditioned on reference images. */
export interface ImageJob {
    type: "image";
    prompt: string;
    mode: "text-to-image" | "reference-to-image";
    references: ProviderImageInput[];
    aspectRatio: string;
    resolution: string;
    outputFormat: OutputFormat;
    numImages: number;
    /** Endpoint for text-to-image; provider default when omitted. */
    endpoint?: string;
    /** Endpoint for reference-to-image; provider default when omitted. */
    editEndpoint?: string;
    /** Provider-specific input merged into the request body as-is. */
    providerOptions?: Record<string, unknown>;
}

/** Enlarge an existing image. */
export interface UpscaleJob {
    type: "upscale";
    image: ProviderImageInput;
    scale: number;
    endpoint?: string;
    providerOptions?: Record<string, unknown>;
}

export type ProviderJob = ImageJob | UpscaleJob;

export interface SubmitResult {
    requestId: string;
    endpoint: string;
}

export interface ProviderOutput {
    /** Where to download the image... */
    url?: string;
    /** ...or the bytes themselves. */
    data?: Buffer;
    mimeType?: string;
}

export type JobState =
    | { state: "queued" | "running" }
    | { state: "completed"; outputs: ProviderOutput[] }
    | { state: "failed"; error: string };

/**
 * Queue-based image provider. `submit` returns immediately; completion is observed
 * through `check` (polling) or a webhook that triggers a `check`.
 */
export interface ImageProvider {
    readonly name: string;
    /** The endpoint a job would be sent to (recorded before submission). */
    resolveEndpoint(job: ProviderJob): string;
    submit(job: ProviderJob, options?: { webhookUrl?: string }): Promise<SubmitResult>;
    /** Throws on transient errors (to be retried later); returns `failed` for terminal ones. */
    check(endpoint: string, requestId: string): Promise<JobState>;
    cancel?(endpoint: string, requestId: string): Promise<void>;
    /** Uploads an image to provider storage so requests can reference it by URL. */
    uploadImage?(data: Uint8Array, mimeType: string): Promise<{ url: string; expiresAt?: string }>;
}

export interface GeneratedImage {
    data: Buffer;
    mimeType: string;
    /** Provider-hosted URL, if any (often short-lived). */
    sourceUrl?: string;
}

export interface BackgroundRemover {
    readonly name: string;
    removeBackground(image: GeneratedImage): Promise<GeneratedImage>;
}

export interface ReviewInput {
    image: ProviderImageInput;
    /** The prompt the image was generated from (describes what should be there). */
    prompt: string;
    references: ProviderImageInput[];
    audience?: string;
}

/** Automated QA: content suitability and consistency with references. */
export interface ImageReviewer {
    readonly name: string;
    review(input: ReviewInput): Promise<Omit<RenderReview, "reviewer">>;
}
