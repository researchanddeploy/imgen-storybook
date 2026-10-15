import sharp from "sharp";
import type { ImageProvider, JobState, ProviderJob, SubmitResult } from "./types.js";

export interface MockJob {
    requestId: string;
    endpoint: string;
    job: ProviderJob;
    webhookUrl?: string;
    checks: number;
    canceled: boolean;
}

export interface MockImageProvider extends ImageProvider {
    /** Every submitted job, in order. */
    readonly jobs: MockJob[];
    readonly uploads: Array<{ url: string; bytes: number }>;
}

export interface MockProviderOptions {
    /** Fail every job with this message (terminal failure). */
    failWith?: string;
    /** Make `submit` throw this error. */
    submitError?: Error;
    /** `check` reports running this many times before completing. Default 0. */
    checksUntilDone?: number;
    /** Expose `uploadImage` (like FAL storage). Default true. */
    supportsUpload?: boolean;
}

function sizeFor(aspectRatio: string): { width: number; height: number } {
    const m = /^(\d+):(\d+)$/.exec(aspectRatio);
    if (!m) return { width: 64, height: 64 };
    const w = Number(m[1]);
    const h = Number(m[2]);
    return w >= h ? { width: 64, height: Math.max(1, Math.round((64 * h) / w)) } : { width: Math.max(1, Math.round((64 * w) / h)), height: 64 };
}

/** Offline queue-based provider returning small solid-color PNGs. For tests and UI development. */
export function createMockImageProvider(options: MockProviderOptions = {}): MockImageProvider {
    const jobs: MockJob[] = [];
    const uploads: Array<{ url: string; bytes: number }> = [];
    const resolveEndpoint = (job: ProviderJob) =>
        job.type === "upscale" ? (job.endpoint ?? "mock/upscale") : job.mode === "reference-to-image" ? (job.editEndpoint ?? "mock/edit") : (job.endpoint ?? "mock/generate");

    const provider: MockImageProvider = {
        name: "mock",
        jobs,
        uploads,
        resolveEndpoint,
        async submit(job, submitOptions = {}): Promise<SubmitResult> {
            if (options.submitError) throw options.submitError;
            const requestId = `req_${jobs.length + 1}`;
            const endpoint = resolveEndpoint(job);
            jobs.push({ requestId, endpoint, job, webhookUrl: submitOptions.webhookUrl, checks: 0, canceled: false });
            return { requestId, endpoint };
        },
        async check(_endpoint, requestId): Promise<JobState> {
            const j = jobs.find((x) => x.requestId === requestId);
            if (!j) return { state: "failed", error: "unknown request" };
            if (j.canceled) return { state: "failed", error: "canceled" };
            j.checks++;
            if (j.checks <= (options.checksUntilDone ?? 0)) return { state: j.checks === 1 ? "queued" : "running" };
            if (options.failWith) return { state: "failed", error: options.failWith };
            const count = j.job.type === "image" ? j.job.numImages : 1;
            const { width, height } =
                j.job.type === "image" ? sizeFor(j.job.aspectRatio) : { width: 64 * j.job.scale, height: 48 * j.job.scale };
            const outputs = await Promise.all(
                Array.from({ length: count }, async (_, i) => ({
                    mimeType: "image/png",
                    data: await sharp({ create: { width, height, channels: 4, background: { r: (40 * i) % 256, g: 120, b: 200, alpha: 1 } } })
                        .png()
                        .toBuffer(),
                })),
            );
            return { state: "completed", outputs };
        },
        async cancel(_endpoint, requestId) {
            const j = jobs.find((x) => x.requestId === requestId);
            if (j) j.canceled = true;
        },
    };
    if (options.supportsUpload !== false) {
        provider.uploadImage = async (data) => {
            const url = `https://mock.storage/upload/${uploads.length + 1}.png`;
            uploads.push({ url, bytes: data.length });
            return { url, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
        };
    }
    return provider;
}
