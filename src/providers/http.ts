import { ProviderError } from "../errors.js";
import { withRetry } from "../retry.js";
import type { GeneratedImage, ProviderOutput } from "./types.js";

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export async function downloadImage(url: string, fallbackMime: string): Promise<GeneratedImage> {
    return withRetry(async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new HttpError(res.status, `Failed to download image (${res.status} ${res.statusText}): ${url}`);
        const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || fallbackMime;
        return { data: Buffer.from(await res.arrayBuffer()), mimeType, sourceUrl: url };
    }).catch((err) => {
        throw err instanceof ProviderError ? err : new ProviderError((err as Error).message, err);
    });
}

export async function materializeOutput(output: ProviderOutput, fallbackMime: string): Promise<GeneratedImage> {
    if (output.data) return { data: output.data, mimeType: output.mimeType ?? fallbackMime, sourceUrl: output.url };
    if (!output.url) throw new ProviderError("Provider output has neither data nor url");
    if (output.url.startsWith("data:")) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(output.url);
        if (!m) throw new ProviderError("Malformed data URI in provider output");
        const data = m[2] ? Buffer.from(m[3] ?? "", "base64") : Buffer.from(decodeURIComponent(m[3] ?? ""));
        return { data, mimeType: m[1] || fallbackMime };
    }
    return downloadImage(output.url, output.mimeType ?? fallbackMime);
}

export function toDataUri(data: Uint8Array, mimeType: string): string {
    return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

export function mimeForFormat(format: string): string {
    return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}
