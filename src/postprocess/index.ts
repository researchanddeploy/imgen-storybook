import sharp from "sharp";
import type { BackgroundRemover, GeneratedImage } from "../providers/types.js";

export type ResizeFit = "contain" | "cover" | "fill" | "inside" | "outside";

export interface PostProcessOptions {
    /** Cut out the background (needs a BackgroundRemover configured on the engine). */
    removeBackground?: boolean;
    /** Trim transparent margins (PNG with alpha only). */
    autoCrop?: boolean;
    /** Padding after auto-crop, in % of the longer side. Default 5. */
    autoCropPaddingPercent?: number;
    resize?: {
        width: number;
        height: number;
        fit?: ResizeFit;
        /** "nearest" keeps pixel art crisp; default "lanczos3". */
        kernel?: "nearest" | "lanczos3";
    };
}

export interface ImageInfo {
    width?: number;
    height?: number;
}

export async function imageInfo(data: Buffer): Promise<ImageInfo> {
    try {
        const m = await sharp(data).metadata();
        return { width: m.width, height: m.height };
    } catch {
        return {};
    }
}

async function autoCrop(image: GeneratedImage, paddingPercent: number): Promise<GeneratedImage> {
    const meta = await sharp(image.data).metadata();
    if (meta.format !== "png" || !meta.hasAlpha) return image;
    const trimmed = await sharp(image.data)
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 5 })
        .toBuffer({ resolveWithObject: true });
    if (paddingPercent <= 0) return { ...image, data: trimmed.data };
    const pad = Math.ceil(Math.max(trimmed.info.width, trimmed.info.height) * (paddingPercent / 100));
    const data = await sharp(trimmed.data)
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    return { ...image, data };
}

async function resize(image: GeneratedImage, opts: NonNullable<PostProcessOptions["resize"]>): Promise<GeneratedImage> {
    const data = await sharp(image.data)
        .resize(opts.width, opts.height, {
            fit: opts.fit ?? "contain",
            position: "centre",
            kernel: opts.kernel ?? "lanczos3",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
    return { data, mimeType: "image/png" };
}

/** Applies background removal → auto-crop → resize, in that order. */
export async function postProcess(
    image: GeneratedImage,
    options: PostProcessOptions | undefined,
    backgroundRemover: BackgroundRemover | undefined,
): Promise<GeneratedImage> {
    if (!options) return image;
    let out = image;
    if (options.removeBackground) {
        if (!backgroundRemover) throw new Error("removeBackground requested but no backgroundRemover is configured");
        out = await backgroundRemover.removeBackground(out);
    }
    if (options.autoCrop) out = await autoCrop(out, options.autoCropPaddingPercent ?? 5);
    if (options.resize) out = await resize(out, options.resize);
    // Anything derived locally no longer matches the provider URL.
    return out === image ? image : { ...out, sourceUrl: options.autoCrop || options.resize ? undefined : out.sourceUrl };
}
