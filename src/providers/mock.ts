import sharp from "sharp";
import type { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from "./types.js";

export interface MockImageProvider extends ImageProvider {
    /** Every request received, in order. */
    readonly calls: ImageGenerationRequest[];
}

function sizeFor(aspectRatio: string): { width: number; height: number } {
    const m = /^(\d+):(\d+)$/.exec(aspectRatio);
    if (!m) return { width: 64, height: 64 };
    const w = Number(m[1]);
    const h = Number(m[2]);
    return w >= h ? { width: 64, height: Math.max(1, Math.round((64 * h) / w)) } : { width: Math.max(1, Math.round((64 * w) / h)), height: 64 };
}

/** Offline provider returning small solid-color PNGs. For tests and UI development. */
export function createMockImageProvider(options: { failWith?: string } = {}): MockImageProvider {
    const calls: ImageGenerationRequest[] = [];
    return {
        name: "mock",
        calls,
        async generate(req): Promise<ImageGenerationResult> {
            calls.push(req);
            if (options.failWith) throw new Error(options.failWith);
            const { width, height } = sizeFor(req.aspectRatio);
            const images = await Promise.all(
                Array.from({ length: req.numImages }, async (_, i) => ({
                    mimeType: "image/png",
                    data: await sharp({
                        create: { width, height, channels: 4, background: { r: (40 * i) % 256, g: 120, b: 200, alpha: 1 } },
                    })
                        .png()
                        .toBuffer(),
                })),
            );
            const endpoint = req.mode === "reference-to-image" ? (req.editEndpoint ?? "mock/edit") : (req.endpoint ?? "mock/generate");
            return { endpoint, images };
        },
    };
}
