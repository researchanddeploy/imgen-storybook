import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { IdSchema, type RecordByKind, type RecordKind } from "../domain/schemas.js";
import { VersionConflictError } from "../errors.js";
import {
    applyQuery,
    assertSafeBlobKey,
    mimeFromKey,
    type BlobStore,
    type Page,
    type PutOptions,
    type RecordQuery,
    type RecordStore,
    type StorageAdapter,
    type StoredBlob,
} from "./types.js";

/** Write to a temp file, then rename: readers on a shared volume never see partial files. */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
}

async function readOrNull(file: string): Promise<Buffer | null> {
    try {
        return await fs.readFile(file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

async function unlinkIfExists(file: string): Promise<boolean> {
    try {
        await fs.unlink(file);
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
    }
}

/**
 * Stores each record as `<root>/<kind>/<id>.json`. Queries scan the kind's directory,
 * so this suits up to a few thousand records per kind. The version check is
 * read-compare-write: it catches stale edits but is not atomic across processes —
 * use the Postgres adapter when several runners write the same records.
 */
export class FileSystemRecordStore implements RecordStore {
    constructor(private readonly root: string) {}

    private file(kind: RecordKind, id: string): string {
        IdSchema.parse(id);
        return path.join(this.root, kind, `${id}.json`);
    }

    async get<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null> {
        if (!IdSchema.safeParse(id).success) return null;
        const buf = await readOrNull(this.file(kind, id));
        return buf ? (JSON.parse(buf.toString("utf-8")) as RecordByKind[K]) : null;
    }

    async getMany<K extends RecordKind>(kind: K, ids: readonly string[]): Promise<Array<RecordByKind[K] | null>> {
        return Promise.all(ids.map((id) => this.get(kind, id)));
    }

    private async all<K extends RecordKind>(kind: K): Promise<Array<RecordByKind[K]>> {
        let names: string[];
        try {
            names = await fs.readdir(path.join(this.root, kind));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw err;
        }
        const records = await Promise.all(
            names.filter((n) => n.endsWith(".json")).map((n) => this.get(kind, n.slice(0, -".json".length))),
        );
        return records.filter((r): r is Awaited<RecordByKind[K]> => r !== null);
    }

    async query<K extends RecordKind>(kind: K, query?: RecordQuery): Promise<Page<RecordByKind[K]>> {
        return applyQuery(await this.all(kind), query);
    }

    async count(kind: RecordKind, query?: RecordQuery): Promise<number> {
        return applyQuery(await this.all(kind), { ...query, limit: undefined, cursor: undefined }).items.length;
    }

    async put<K extends RecordKind>(kind: K, record: RecordByKind[K], options: PutOptions = {}): Promise<void> {
        if (options.expectedVersion !== undefined) {
            const current = await this.get(kind, record.id);
            if ((current?.version ?? 0) !== options.expectedVersion) {
                throw new VersionConflictError(kind, record.id, options.expectedVersion, current?.version);
            }
        }
        await writeAtomic(this.file(kind, record.id), JSON.stringify(record, null, 2));
    }

    async delete(kind: RecordKind, id: string): Promise<boolean> {
        if (!IdSchema.safeParse(id).success) return false;
        return unlinkIfExists(this.file(kind, id));
    }
}

export interface FileSystemBlobStoreOptions {
    /** If the directory is served over HTTP, its base URL (used for `publicUrl`). */
    publicBaseUrl?: string;
}

/** Stores blobs as plain files under `<root>/<key>`; content type is derived from the extension. */
export class FileSystemBlobStore implements BlobStore {
    constructor(
        private readonly root: string,
        private readonly options: FileSystemBlobStoreOptions = {},
    ) {}

    private file(key: string): string {
        assertSafeBlobKey(key);
        return path.join(this.root, ...key.split("/"));
    }

    async put(key: string, data: Uint8Array): Promise<void> {
        await writeAtomic(this.file(key), data);
    }

    async get(key: string): Promise<StoredBlob | null> {
        const data = await readOrNull(this.file(key));
        return data ? { data, contentType: mimeFromKey(key) } : null;
    }

    async delete(key: string): Promise<boolean> {
        return unlinkIfExists(this.file(key));
    }

    async publicUrl(key: string): Promise<string | null> {
        assertSafeBlobKey(key);
        const base = this.options.publicBaseUrl;
        return base ? `${base.replace(/\/+$/, "")}/${key}` : null;
    }
}

export interface FileSystemStorageOptions extends FileSystemBlobStoreOptions {
    /** Root directory; records go to `<root>/records`, blobs to `<root>/blobs`. */
    rootDir: string;
}

export function createFileSystemStorage(options: FileSystemStorageOptions): StorageAdapter {
    const root = path.resolve(options.rootDir);
    return {
        records: new FileSystemRecordStore(path.join(root, "records")),
        blobs: new FileSystemBlobStore(path.join(root, "blobs"), options),
    };
}
