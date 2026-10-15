import { ConfigError } from "./errors.js";

/**
 * Value shipped in `.env.example`. Any key still equal to a placeholder is treated
 * as missing, so a copied-but-unfilled env file fails loudly instead of sending
 * "__SET_YOUR_FAL_KEY__" to FAL.
 */
export const FAL_KEY_PLACEHOLDER = "__SET_YOUR_FAL_KEY__";
const PLACEHOLDER_PATTERN = /^(__SET_[A-Z0-9_]+__|changeme|your[-_ ]?key.*|<.*>)$/i;

export function isPlaceholder(value: string | undefined | null): boolean {
    return !value || value.trim() === "" || PLACEHOLDER_PATTERN.test(value.trim());
}

/** Returns the value unless it is empty or a placeholder. */
export function realValue(value: string | undefined | null): string | undefined {
    return isPlaceholder(value) ? undefined : value!.trim();
}

export interface StorybookConfig {
    /** FAL API key (`FAL_KEY`, fallback `FALAI_API_KEY`). Undefined while the placeholder is in place. */
    falKey?: string;
    wavespeedApiKey?: string;
    /** Postgres connection string; when set, records are stored in Postgres. */
    databaseUrl?: string;
    /** Root for file storage. On FAL Serverless use the persistent `/data` volume. */
    dataDir: string;
    /** Public base URL of this server (used for webhooks and blob links). */
    publicBaseUrl?: string;
    /** Shared secret clients must send as `x-storybook-token`. Unset = no check. */
    apiToken?: string;
    port: number;
    /** Receive FAL completion webhooks (requires a publicly reachable publicBaseUrl). */
    webhooksEnabled: boolean;
    /** Background polling interval for pending renders, ms (0 disables). */
    pollIntervalMs: number;
    maxRendersPerDay?: number;
    maxConcurrentRenders?: number;
    maxDailyCostUsd?: number;
}

function int(value: string | undefined, fallback?: number): number | undefined {
    if (value === undefined || value.trim() === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new ConfigError(`Expected a non-negative number, got "${value}"`);
    return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StorybookConfig {
    const publicBaseUrl = realValue(env.STORYBOOK_PUBLIC_URL)?.replace(/\/+$/, "");
    return {
        falKey: realValue(env.FAL_KEY) ?? realValue(env.FALAI_API_KEY),
        wavespeedApiKey: realValue(env.WAVESPEED_API_KEY),
        databaseUrl: realValue(env.DATABASE_URL),
        dataDir: realValue(env.STORYBOOK_DATA_DIR) ?? "/data/storybook",
        publicBaseUrl,
        apiToken: realValue(env.STORYBOOK_API_TOKEN),
        port: int(env.PORT, 8080)!,
        webhooksEnabled: env.STORYBOOK_WEBHOOKS === "1" && Boolean(publicBaseUrl),
        pollIntervalMs: int(env.STORYBOOK_POLL_INTERVAL_MS, 5000)!,
        maxRendersPerDay: int(env.STORYBOOK_MAX_RENDERS_PER_DAY),
        maxConcurrentRenders: int(env.STORYBOOK_MAX_CONCURRENT_RENDERS),
        maxDailyCostUsd: int(env.STORYBOOK_MAX_DAILY_COST_USD),
    };
}

/** Throws a helpful error when the FAL key is missing or still the placeholder. */
export function requireFalKey(config: Pick<StorybookConfig, "falKey">): string {
    if (!config.falKey) {
        throw new ConfigError(
            "FAL API key is not configured. Set FAL_KEY (locally in .env, on FAL Serverless with " +
                "`fal secrets set FAL_KEY=...`). The value in .env.example is only a placeholder.",
        );
    }
    return config.falKey;
}
