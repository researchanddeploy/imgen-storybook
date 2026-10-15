import type { OutputFormat } from "../domain/schemas.js";

export interface ProviderImageInput {
    /** An http(s) URL or a `data:` URI. */
    url: string;
    mimeType: string;
}

export interface ImageGenerationRequest {
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

export interface GeneratedImage {
    data: Buffer;
    mimeType: string;
    /** Provider-hosted URL, if any (often short-lived). */
    sourceUrl?: string;
}

export interface ImageGenerationResult {
    images: GeneratedImage[];
    /** The endpoint actually called. */
    endpoint: string;
}

export interface ImageProvider {
    readonly name: string;
    generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

export interface BackgroundRemover {
    readonly name: string;
    removeBackground(image: GeneratedImage): Promise<GeneratedImage>;
}
