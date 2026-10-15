import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { IdSchema, type RecordByKind, type RecordKind } from "../domain/schemas.js";
import { assertSafeBlobKey, mimeFromKey, type BlobStore, type RecordStore, type StorageAdapter, type StoredBlob } from "./types.js";

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

/** Stores each record as `<root>/<kind>/<id>.json`. */
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

    async list<K extends RecordKind>(kind: K): Promise<Array<RecordByKind[K]>> {
        let names: string[];
        try {
            names = await fs.readdir(path.join(this.root, kind));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw err;
        }
        const out: Array<RecordByKind[K]> = [];
        for (const name of names.filter((n) => n.endsWith(".json"))) {
            const rec = await this.get(kind, name.slice(0, -".json".length));
            if (rec) out.push(rec);
        }
        return out;
    }

    async put<K extends RecordKind>(kind: K, record: RecordByKind[K]): Promise<void> {
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
