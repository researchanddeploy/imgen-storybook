import type { RecordByKind, RecordKind } from "../domain/schemas.js";
import { VersionConflictError } from "../errors.js";
import {
    applyQuery,
    assertSafeBlobKey,
    type BlobStore,
    type Page,
    type PutOptions,
    type RecordQuery,
    type RecordStore,
    type StorageAdapter,
    type StoredBlob,
} from "./types.js";

type Stored = { id: string; createdAt: string; version?: number };

export class MemoryRecordStore implements RecordStore {
    private readonly data = new Map<RecordKind, Map<string, Stored>>();

    private bucket(kind: RecordKind): Map<string, Stored> {
        let b = this.data.get(kind);
        if (!b) {
            b = new Map();
            this.data.set(kind, b);
        }
        return b;
    }

    async get<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null> {
        const v = this.bucket(kind).get(id);
        return v === undefined ? null : (structuredClone(v) as unknown as RecordByKind[K]);
    }

    async getMany<K extends RecordKind>(kind: K, ids: readonly string[]): Promise<Array<RecordByKind[K] | null>> {
        return Promise.all(ids.map((id) => this.get(kind, id)));
    }

    async query<K extends RecordKind>(kind: K, query?: RecordQuery): Promise<Page<RecordByKind[K]>> {
        const page = applyQuery([...this.bucket(kind).values()], query);
        return { ...page, items: page.items.map((v) => structuredClone(v) as unknown as RecordByKind[K]) };
    }

    async count(kind: RecordKind, query?: RecordQuery): Promise<number> {
        return applyQuery([...this.bucket(kind).values()], { ...query, limit: undefined, cursor: undefined }).items.length;
    }

    async put<K extends RecordKind>(kind: K, record: RecordByKind[K], options: PutOptions = {}): Promise<void> {
        const current = this.bucket(kind).get(record.id);
        if (options.expectedVersion !== undefined && (current?.version ?? 0) !== options.expectedVersion) {
            throw new VersionConflictError(kind, record.id, options.expectedVersion, current?.version);
        }
        this.bucket(kind).set(record.id, structuredClone(record) as unknown as Stored);
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
