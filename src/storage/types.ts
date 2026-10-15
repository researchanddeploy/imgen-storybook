import type { RecordByKind, RecordKind } from "../domain/schemas.js";

/**
 * Persistence for entity and render records (JSON documents keyed by kind + id).
 * Implementations must return copies, never live references to stored objects.
 */
export interface RecordStore {
    get<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null>;
    list<K extends RecordKind>(kind: K): Promise<Array<RecordByKind[K]>>;
    put<K extends RecordKind>(kind: K, record: RecordByKind[K]): Promise<void>;
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
    /**
     * Optional URL under which the blob is publicly reachable. When present it is
     * exposed to clients and handed to image providers instead of an inline data URI.
     */
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
