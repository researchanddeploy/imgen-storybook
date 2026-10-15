import { ProviderError } from "../errors.js";
import type { GeneratedImage } from "./types.js";

export async function downloadImage(url: string, fallbackMime: string): Promise<GeneratedImage> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new ProviderError(`Failed to download image (${res.status} ${res.statusText}): ${url}`);
    }
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || fallbackMime;
    return { data: Buffer.from(await res.arrayBuffer()), mimeType, sourceUrl: url };
}

export function toDataUri(data: Uint8Array, mimeType: string): string {
    return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

export function mimeForFormat(format: string): string {
    return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}
