import { ProviderError } from "../errors.js";
import { downloadImage } from "./http.js";
import type { BackgroundRemover, GeneratedImage } from "./types.js";

export interface WaveSpeedOptions {
    /** Defaults to WAVESPEED_API_KEY from the environment. */
    apiKey?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

/** WaveSpeed background removal. Requires the image to have a public `sourceUrl`. */
export function createWaveSpeedBackgroundRemover(options: WaveSpeedOptions = {}): BackgroundRemover {
    return {
        name: "wavespeed-rembg",
        async removeBackground(image: GeneratedImage): Promise<GeneratedImage> {
            const apiKey = options.apiKey ?? process.env.WAVESPEED_API_KEY;
            if (!apiKey) throw new ProviderError("WAVESPEED_API_KEY is not set");
            if (!image.sourceUrl) throw new ProviderError("WaveSpeed rembg requires a publicly accessible image URL");

            const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
            const submit = await fetch("https://api.wavespeed.ai/api/v3/wavespeed-ai/image-background-remover", {
                method: "POST",
                headers,
                body: JSON.stringify({ enable_base64_output: false, enable_sync_mode: false, image: image.sourceUrl }),
            });
            if (!submit.ok) throw new ProviderError(`WaveSpeed submit failed: ${submit.status} ${await submit.text()}`);
            const requestId = ((await submit.json()) as { data?: { id?: string } })?.data?.id;
            if (!requestId) throw new ProviderError("WaveSpeed submit returned no request id");

            const deadline = Date.now() + (options.timeoutMs ?? 60_000);
            while (Date.now() < deadline) {
                const poll = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, { headers });
                const json = (await poll.json().catch(() => ({}))) as {
                    data?: { status?: string; outputs?: string[]; error?: string };
                };
                if (!poll.ok) throw new ProviderError(`WaveSpeed poll failed: ${poll.status} ${JSON.stringify(json)}`);
                if (json.data?.status === "completed") {
                    const out = json.data.outputs?.[0];
                    if (!out) throw new ProviderError("WaveSpeed completed but returned no outputs[0]");
                    return downloadImage(out, "image/png");
                }
                if (json.data?.status === "failed") {
                    throw new ProviderError(`WaveSpeed task failed: ${json.data.error ?? "unknown error"}`);
                }
                await new Promise((r) => setTimeout(r, options.pollIntervalMs ?? 500));
            }
            throw new ProviderError("WaveSpeed task timed out");
        },
    };
}
