import type { RecordByKind, RecordKind } from "../domain/schemas.js";

export type Scalar = string | number | boolean;

export interface RecordQuery {
    /** Top-level field equals value (`null` = field absent). */
    where?: Record<string, Scalar | null>;
    /** Top-level field is one of the values. */
    in?: Record<string, Scalar[]>;
    /** Top-level array field contains the value (e.g. `tags`). */
    contains?: Record<string, string>;
    /** Only records created at/after this ISO timestamp. */
    createdSince?: string;
    order?: "asc" | "desc";
    /** Page size; omitted = everything. */
    limit?: number;
    /** Opaque cursor from a previous page. */
    cursor?: string;
}

export interface Page<T> {
    items: T[];
    /** Present when more records exist. */
    nextCursor?: string;
}

export interface PutOptions {
    /**
     * Optimistic locking: the version currently stored must equal this, or the
     * write fails with VersionConflictError. Use 0 for "must not exist yet".
     */
    expectedVersion?: number;
}

/**
 * Persistence for entity and render records (JSON documents keyed by kind + id).
 * Records are ordered by `createdAt`, then `id`. Implementations return copies.
 */
export interface RecordStore {
    get<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null>;
    getMany<K extends RecordKind>(kind: K, ids: readonly string[]): Promise<Array<RecordByKind[K] | null>>;
    query<K extends RecordKind>(kind: K, query?: RecordQuery): Promise<Page<RecordByKind[K]>>;
    count(kind: RecordKind, query?: Omit<RecordQuery, "limit" | "cursor" | "order">): Promise<number>;
    put<K extends RecordKind>(kind: K, record: RecordByKind[K], options?: PutOptions): Promise<void>;
    delete(kind: RecordKind, id: string): Promise<boolean>;
}

export interface StoredBlob {
    data: Buffer;
    contentType: string;
}

/**
 * Binary storage for reference images and renders.
 * Keys are relative, slash-separated paths such as `renders/rnd_x.png`.
 */
export interface BlobStore {
    put(key: string, data: Uint8Array, contentType: string): Promise<void>;
    get(key: string): Promise<StoredBlob | null>;
    delete(key: string): Promise<boolean>;
    /** Optional URL under which the blob is publicly reachable. */
    publicUrl?(key: string): Promise<string | null>;
}

export interface StorageAdapter {
    records: RecordStore;
    blobs: BlobStore;
}

const KEY_PATTERN = /^[A-Za-z0-9_\-.]+(\/[A-Za-z0-9_\-.]+)*$/;

export function assertSafeBlobKey(key: string): void {
    if (!KEY_PATTERN.test(key) || key.split("/").some((seg) => seg === "." || seg === "..")) {
        throw new Error(`Unsafe blob key: ${JSON.stringify(key)}`);
    }
}

const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
};

const EXT_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
};

export function mimeFromKey(key: string): string {
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function extFromMime(mime: string): string {
    return EXT_BY_MIME[mime.toLowerCase()] ?? "bin";
}

// ---------------------------------------------------------------------------
// Shared in-process query evaluation (memory and filesystem adapters)
// ---------------------------------------------------------------------------

interface Ordered {
    id: string;
    createdAt: string;
}

export function encodeCursor(r: Ordered): string {
    return Buffer.from(JSON.stringify([r.createdAt, r.id])).toString("base64url");
}

export function decodeCursor(cursor: string): [string, string] {
    try {
        const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
        if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
    } catch {
        /* fall through */
    }
    throw new Error("Invalid cursor");
}

export function matchesQuery(record: Record<string, unknown>, q: RecordQuery = {}): boolean {
    for (const [k, v] of Object.entries(q.where ?? {})) {
        if (v === null ? record[k] !== undefined && record[k] !== null : record[k] !== v) return false;
    }
    for (const [k, vs] of Object.entries(q.in ?? {})) {
        if (!vs.includes(record[k] as Scalar)) return false;
    }
    for (const [k, v] of Object.entries(q.contains ?? {})) {
        const arr = record[k];
        if (!Array.isArray(arr) || !arr.includes(v)) return false;
    }
    if (q.createdSince && String(record.createdAt) < q.createdSince) return false;
    return true;
}

/** Filters, sorts and paginates an in-memory list. */
export function applyQuery<T extends Ordered>(all: T[], q: RecordQuery = {}): Page<T> {
    const dir = q.order === "desc" ? -1 : 1;
    const cmp = (a: Ordered, b: Ordered) =>
        dir * (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let items = all.filter((r) => matchesQuery(r as unknown as Record<string, unknown>, q)).sort(cmp);
    if (q.cursor) {
        const [createdAt, id] = decodeCursor(q.cursor);
        items = items.filter((r) => cmp(r, { createdAt, id }) > 0);
    }
    if (q.limit === undefined || items.length <= q.limit) return { items };
    const page = items.slice(0, q.limit);
    return { items: page, nextCursor: encodeCursor(page[page.length - 1]!) };
}
