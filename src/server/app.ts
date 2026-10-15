import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import pg from "pg";
import { createYoga } from "graphql-yoga";
import type { StorybookConfig } from "../config.js";
import { createStoryEngine, type Pricing, type StoryEngine } from "../engine.js";
import { StoryEngineError } from "../errors.js";
import { createStoryGraphQLSchema } from "../graphql/schema.js";
import { createFalBackgroundRemover, createFalImageProvider, createFalVisionReviewer } from "../providers/fal.js";
import type { ImageProvider, ImageReviewer } from "../providers/types.js";
import { FileSystemBlobStore, createFileSystemStorage } from "../storage/filesystem.js";
import { PostgresRecordStore, migratePostgresStorage, type SqlClient } from "../storage/postgres.js";
import type { StorageAdapter } from "../storage/types.js";
import { signBlobPath, verifyBlobSignature } from "./signing.js";

const TENANT = /^[A-Za-z0-9_-]{1,64}$/;

export interface ServerContext {
    tenant: string;
}

export interface StorybookServerOptions {
    config: StorybookConfig;
    /** Image provider; default FAL with `config.falKey`. */
    provider?: ImageProvider;
    reviewer?: ImageReviewer;
    /** Postgres client for records (default: a pg.Pool on `config.databaseUrl`, if set). */
    sql?: SqlClient;
    /** Storage factory per tenant; overrides the default (Postgres records + /data blobs, or /data only). */
    storageFor?: (tenant: string) => StorageAdapter;
    pricing?: Pricing;
}

export interface StorybookServer {
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    engineFor: (tenant: string) => Promise<StoryEngine>;
    /** Prepares storage (Postgres migrations). Call once before serving. */
    init: () => Promise<void>;
    /** Polls pending renders of every active tenant. Returns a stop function. */
    startPolling: () => () => void;
    close: () => Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

export function createStorybookServer(options: StorybookServerOptions): StorybookServer {
    const { config } = options;
    const pool = options.sql ?? (config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl, max: 10 }) : undefined);
    const provider = options.provider ?? createFalImageProvider({ apiKey: config.falKey });
    const reviewer = options.reviewer ?? (process.env.STORYBOOK_REVIEWER === "fal-vision" ? createFalVisionReviewer({ apiKey: config.falKey }) : undefined);
    const urlSecret = config.apiToken;

    const storageFor =
        options.storageFor ??
        ((tenant: string): StorageAdapter => {
            const root = path.join(config.dataDir, "tenants", tenant);
            if (pool) {
                return { records: new PostgresRecordStore({ client: pool, namespace: tenant }), blobs: new FileSystemBlobStore(path.join(root, "blobs")) };
            }
            return createFileSystemStorage({ rootDir: root });
        });

    const engines = new Map<string, StoryEngine>();
    const engineFor = async (tenant: string): Promise<StoryEngine> => {
        let engine = engines.get(tenant);
        if (!engine) {
            engine = createStoryEngine({
                storage: storageFor(tenant),
                provider,
                reviewer,
                backgroundRemover: createFalBackgroundRemover({ apiKey: config.falKey }),
                limits: {
                    maxRendersPerDay: config.maxRendersPerDay,
                    maxConcurrentRenders: config.maxConcurrentRenders,
                    maxDailyCostUsd: config.maxDailyCostUsd,
                },
                pricing: options.pricing,
                webhookUrl: config.webhooksEnabled
                    ? ({ renderId, token }) => `${config.publicBaseUrl}/webhooks/fal/${tenant}/${renderId}?token=${encodeURIComponent(token)}`
                    : undefined,
            });
            engines.set(tenant, engine);
        }
        return engine;
    };

    const blobUrl = (tenant: string, key: string): string | null => {
        if (!config.publicBaseUrl) return null;
        const p = `/blobs/${tenant}/${key}`;
        return `${config.publicBaseUrl}${urlSecret ? signBlobPath(p, urlSecret) : p}`;
    };

    const yoga = createYoga<{ req: IncomingMessage }, ServerContext>({
        schema: createStoryGraphQLSchema<ServerContext>({
            getEngine: (ctx) => engineFor(ctx.tenant),
            blobUrl: (key, ctx) => blobUrl(ctx.tenant, key),
        }),
        context: ({ req }) => ({ tenant: String(req.headers["x-storybook-tenant"] ?? "default") }),
        graphqlEndpoint: "/graphql",
        landingPage: false,
    });

    const authorized = (req: IncomingMessage): boolean => {
        if (!config.apiToken) return true;
        const given = req.headers["x-storybook-token"];
        return typeof given === "string" && safeEqual(given, config.apiToken);
    };

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
            if (url.pathname === "/health") {
                return sendJson(res, 200, { ok: true, provider: provider.name, falKeyConfigured: Boolean(config.falKey), storage: pool ? "postgres+files" : "files" });
            }

            // FAL webhook: authenticated by the per-render token; the result itself is fetched from FAL.
            const hook = /^\/webhooks\/fal\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
            if (hook && req.method === "POST") {
                req.resume();
                const engine = await engineFor(hook[1]!);
                const render = await engine.handleProviderWebhook(hook[2]!, url.searchParams.get("token") ?? "");
                return sendJson(res, 200, { ok: true, status: render.status });
            }

            const blob = /^\/blobs\/([A-Za-z0-9_-]{1,64})\/(.+)$/.exec(url.pathname);
            if (blob && req.method === "GET") {
                const signed = urlSecret ? verifyBlobSignature(url.pathname, url.searchParams.get("exp"), url.searchParams.get("sig"), urlSecret) : true;
                if (!signed && !authorized(req)) return sendJson(res, 403, { error: "forbidden" });
                const data = await (await engineFor(blob[1]!)).getBlob(decodeURIComponent(blob[2]!));
                if (!data) return sendJson(res, 404, { error: "not found" });
                res.writeHead(200, { "Content-Type": data.contentType, "Cache-Control": "private, max-age=3600" });
                res.end(data.data);
                return;
            }

            if (url.pathname === "/graphql") {
                if (!authorized(req)) return sendJson(res, 401, { error: "missing or invalid x-storybook-token" });
                const tenant = String(req.headers["x-storybook-tenant"] ?? "default");
                if (!TENANT.test(tenant)) return sendJson(res, 400, { error: "invalid x-storybook-tenant" });
                return yoga(req, res);
            }

            return sendJson(res, 404, { error: "not found" });
        } catch (err) {
            if (err instanceof StoryEngineError && err.code === "NOT_FOUND") return sendJson(res, 404, { error: err.message });
            console.error(err);
            return sendJson(res, 500, { error: "internal error" });
        }
    };

    return {
        handler,
        engineFor,
        init: async () => {
            if (pool) await migratePostgresStorage(pool);
        },
        startPolling: () => {
            if (config.pollIntervalMs <= 0) return () => undefined;
            let busy = false;
            const timer = setInterval(async () => {
                if (busy) return;
                busy = true;
                try {
                    for (const engine of engines.values()) await engine.syncPendingRenders().catch((e) => console.error("poll failed", e));
                } finally {
                    busy = false;
                }
            }, config.pollIntervalMs);
            timer.unref();
            return () => clearInterval(timer);
        },
        close: async () => {
            if (pool && "end" in pool && typeof (pool as pg.Pool).end === "function") await (pool as pg.Pool).end();
        },
    };
}
