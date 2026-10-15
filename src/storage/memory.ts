import type { RecordByKind, RecordKind } from "../domain/schemas.js";
import { assertSafeBlobKey, type BlobStore, type RecordStore, type StorageAdapter, type StoredBlob } from "./types.js";

export class MemoryRecordStore implements RecordStore {
    private readonly data = new Map<RecordKind, Map<string, unknown>>();

    private bucket(kind: RecordKind): Map<string, unknown> {
        let b = this.data.get(kind);
        if (!b) {
            b = new Map();
            this.data.set(kind, b);
        }
        return b;
    }

    async get<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null> {
        const v = this.bucket(kind).get(id);
        return v === undefined ? null : (structuredClone(v) as RecordByKind[K]);
    }

    async list<K extends RecordKind>(kind: K): Promise<Array<RecordByKind[K]>> {
        return [...this.bucket(kind).values()].map((v) => structuredClone(v) as RecordByKind[K]);
    }

    async put<K extends RecordKind>(kind: K, record: RecordByKind[K]): Promise<void> {
        this.bucket(kind).set(record.id, structuredClone(record));
    }

    async delete(kind: RecordKind, id: string): Promise<boolean> {
        return this.bucket(kind).delete(id);
    }
}

export class MemoryBlobStore implements BlobStore {
    private readonly data = new Map<string, StoredBlob>();

    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
        assertSafeBlobKey(key);
        this.data.set(key, { data: Buffer.from(data), contentType });
    }

    async get(key: string): Promise<StoredBlob | null> {
        const v = this.data.get(key);
        return v ? { data: Buffer.from(v.data), contentType: v.contentType } : null;
    }

    async delete(key: string): Promise<boolean> {
        return this.data.delete(key);
    }
}

/** Volatile storage, handy for tests and prototyping. */
export function createMemoryStorage(): StorageAdapter {
    return { records: new MemoryRecordStore(), blobs: new MemoryBlobStore() };
}
