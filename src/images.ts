import sharp from "sharp";
import { ValidationError } from "./errors.js";

const ACCEPTED: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export interface NormalizedImage {
    data: Buffer;
    mimeType: string;
    width: number;
    height: number;
}

export interface NormalizeOptions {
    /** Longest side after downscaling. Default 1536 (plenty for model conditioning). */
    maxDimension?: number;
    /** Reject inputs larger than this many bytes before decoding. */
    maxBytes?: number;
}

/**
 * Validates an uploaded reference image and prepares it for model conditioning:
 * applies EXIF orientation, downsizes to `maxDimension` and re-encodes in the same
 * format (PNG keeps transparency). A 12 MP phone photo shrinks from ~5 MB to a few
 * hundred KB, which keeps provider requests small.
 */
export async function normalizeReferenceImage(input: Buffer, options: NormalizeOptions = {}): Promise<NormalizedImage> {
    const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
    const maxDimension = options.maxDimension ?? 1536;
    if (input.length === 0) throw new ValidationError("Reference image is empty");
    if (input.length > maxBytes) throw new ValidationError(`Reference image exceeds ${maxBytes} bytes`);

    let format: string | undefined;
    try {
        format = (await sharp(input).metadata()).format;
    } catch {
        throw new ValidationError("Reference image could not be decoded");
    }
    const mimeType = format ? ACCEPTED[format] : undefined;
    if (!format || !mimeType) throw new ValidationError(`Unsupported reference image format: ${format ?? "unknown"} (use png, jpeg or webp)`);

    let pipeline = sharp(input).rotate().resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true });
    pipeline = format === "png" ? pipeline.png({ compressionLevel: 9 }) : format === "webp" ? pipeline.webp({ quality: 90 }) : pipeline.jpeg({ quality: 90, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, mimeType, width: info.width, height: info.height };
}
