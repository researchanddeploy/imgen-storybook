import type { RecordByKind, RecordKind } from "../domain/schemas.js";
import { VersionConflictError } from "../errors.js";
import {
    assertSafeBlobKey,
    decodeCursor,
    encodeCursor,
    type BlobStore,
    type Page,
    type PutOptions,
    type RecordQuery,
    type RecordStore,
    type StoredBlob,
} from "./types.js";

/** Anything with a node-postgres compatible `query` (pg.Pool, pg.Client, PGlite). */
export interface SqlClient {
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PostgresStorageOptions {
    client: SqlClient;
    /** Table name prefix. Default "storybook". */
    tablePrefix?: string;
    /** Logical partition, e.g. a tenant id. Default "default". */
    namespace?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function tableNames(prefix = "storybook") {
    if (!IDENT.test(prefix)) throw new Error(`Invalid table prefix: ${prefix}`);
    return { records: `${prefix}_records`, blobs: `${prefix}_blobs` };
}

/** Creates the tables and indexes (idempotent). Run once at startup or in a migration. */
export async function migratePostgresStorage(client: SqlClient, tablePrefix?: string): Promise<void> {
    const t = tableNames(tablePrefix);
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${t.records} (
            namespace  text    NOT NULL,
            kind       text    NOT NULL,
            id         text    NOT NULL,
            version    integer NOT NULL,
            created_at text    NOT NULL,
            data       jsonb   NOT NULL,
            PRIMARY KEY (namespace, kind, id)
        )`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${t.records}_order ON ${t.records} (namespace, kind, created_at, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${t.records}_data ON ${t.records} USING gin (data jsonb_path_ops)`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${t.blobs} (
            namespace    text  NOT NULL,
            key          text  NOT NULL,
            content_type text  NOT NULL,
            data         bytea NOT NULL,
            PRIMARY KEY (namespace, key)
        )`);
}

function assertField(name: string): void {
    if (!FIELD.test(name)) throw new Error(`Invalid query field: ${name}`);
}

export class PostgresRecordStore implements RecordStore {
    private readonly table: string;
    private readonly ns: string;

    constructor(private readonly options: PostgresStorageOptions) {
        this.table = tableNames(options.tablePrefix).records;
        this.ns = options.namespace ?? "default";
    }

    private get db() {
        return this.options.client;
    }

    async get<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null> {
        const { rows } = await this.db.query(`SELECT data FROM ${this.table} WHERE namespace = $1 AND kind = $2 AND id = $3`, [this.ns, kind, id]);
        return rows[0] ? (rows[0].data as RecordByKind[K]) : null;
    }

    async getMany<K extends RecordKind>(kind: K, ids: readonly string[]): Promise<Array<RecordByKind[K] | null>> {
        if (ids.length === 0) return [];
        const { rows } = await this.db.query(`SELECT id, data FROM ${this.table} WHERE namespace = $1 AND kind = $2 AND id = ANY($3::text[])`, [
            this.ns,
            kind,
            [...new Set(ids)],
        ]);
        const byId = new Map(rows.map((r) => [r.id as string, r.data as RecordByKind[K]]));
        return ids.map((id) => byId.get(id) ?? null);
    }

    private filters(kind: RecordKind, q: RecordQuery, params: unknown[]): string[] {
        const p = (v: unknown) => {
            params.push(v);
            return `$${params.length}`;
        };
        const clauses = [`namespace = ${p(this.ns)}`, `kind = ${p(kind)}`];
        for (const [k, v] of Object.entries(q.where ?? {})) {
            assertField(k);
            clauses.push(v === null ? `(data->'${k}') IS NULL OR data->'${k}' = 'null'::jsonb` : `data @> ${p(JSON.stringify({ [k]: v }))}::jsonb`);
        }
        for (const [k, vs] of Object.entries(q.in ?? {})) {
            assertField(k);
            clauses.push(`data->>'${k}' = ANY(${p(vs.map(String))}::text[])`);
        }
        for (const [k, v] of Object.entries(q.contains ?? {})) {
            assertField(k);
            clauses.push(`data @> ${p(JSON.stringify({ [k]: [v] }))}::jsonb`);
        }
        if (q.createdSince) clauses.push(`created_at >= ${p(q.createdSince)}`);
        return clauses.map((c) => `(${c})`);
    }

    async query<K extends RecordKind>(kind: K, q: RecordQuery = {}): Promise<Page<RecordByKind[K]>> {
        const params: unknown[] = [];
        const clauses = this.filters(kind, q, params);
        const desc = q.order === "desc";
        if (q.cursor) {
            const [createdAt, id] = decodeCursor(q.cursor);
            params.push(createdAt, id);
            clauses.push(`((created_at, id) ${desc ? "<" : ">"} ($${params.length - 1}, $${params.length}))`);
        }
        let sql = `SELECT data FROM ${this.table} WHERE ${clauses.join(" AND ")} ORDER BY created_at ${desc ? "DESC" : "ASC"}, id ${desc ? "DESC" : "ASC"}`;
        if (q.limit !== undefined) {
            params.push(q.limit + 1);
            sql += ` LIMIT $${params.length}`;
        }
        const { rows } = await this.db.query(sql, params);
        const items = rows.map((r) => r.data as RecordByKind[K]);
        if (q.limit === undefined || items.length <= q.limit) return { items };
        const page = items.slice(0, q.limit);
        return { items: page, nextCursor: encodeCursor(page[page.length - 1] as { id: string; createdAt: string }) };
    }

    async count(kind: RecordKind, q: RecordQuery = {}): Promise<number> {
        const params: unknown[] = [];
        const clauses = this.filters(kind, q, params);
        const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM ${this.table} WHERE ${clauses.join(" AND ")}`, params);
        return Number(rows[0]?.n ?? 0);
    }

    async put<K extends RecordKind>(kind: K, record: RecordByKind[K], options: PutOptions = {}): Promise<void> {
        const version = record.version ?? 1;
        const args = [this.ns, kind, record.id, version, record.createdAt, JSON.stringify(record)];
        const expected = options.expectedVersion;
        let ok = true;
        if (expected === undefined) {
            await this.db.query(
                `INSERT INTO ${this.table} (namespace, kind, id, version, created_at, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                 ON CONFLICT (namespace, kind, id) DO UPDATE SET version = EXCLUDED.version, created_at = EXCLUDED.created_at, data = EXCLUDED.data`,
                args,
            );
        } else if (expected === 0) {
            const { rows } = await this.db.query(
                `INSERT INTO ${this.table} (namespace, kind, id, version, created_at, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                 ON CONFLICT (namespace, kind, id) DO NOTHING RETURNING id`,
                args,
            );
            ok = rows.length === 1;
        } else {
            const { rows } = await this.db.query(
                `UPDATE ${this.table} SET version = $4, created_at = $5, data = $6::jsonb
                 WHERE namespace = $1 AND kind = $2 AND id = $3 AND version = $7 RETURNING id`,
                [...args, expected],
            );
            ok = rows.length === 1;
        }
        if (!ok) {
            const current = await this.get(kind, record.id);
            throw new VersionConflictError(kind, record.id, expected!, current?.version);
        }
    }

    async delete(kind: RecordKind, id: string): Promise<boolean> {
        const { rows } = await this.db.query(`DELETE FROM ${this.table} WHERE namespace = $1 AND kind = $2 AND id = $3 RETURNING id`, [this.ns, kind, id]);
        return rows.length > 0;
    }
}

/** Blobs in a bytea table. Fine for moderate volumes; for many large images prefer file/object storage. */
export class PostgresBlobStore implements BlobStore {
    private readonly table: string;
    private readonly ns: string;

    constructor(private readonly options: PostgresStorageOptions) {
        this.table = tableNames(options.tablePrefix).blobs;
        this.ns = options.namespace ?? "default";
    }

    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
        assertSafeBlobKey(key);
        await this.options.client.query(
            `INSERT INTO ${this.table} (namespace, key, content_type, data) VALUES ($1, $2, $3, $4)
             ON CONFLICT (namespace, key) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
            [this.ns, key, contentType, Buffer.from(data)],
        );
    }

    async get(key: string): Promise<StoredBlob | null> {
        const { rows } = await this.options.client.query(`SELECT content_type, data FROM ${this.table} WHERE namespace = $1 AND key = $2`, [this.ns, key]);
        return rows[0] ? { contentType: rows[0].content_type, data: Buffer.from(rows[0].data) } : null;
    }

    async delete(key: string): Promise<boolean> {
        const { rows } = await this.options.client.query(`DELETE FROM ${this.table} WHERE namespace = $1 AND key = $2 RETURNING key`, [this.ns, key]);
        return rows.length > 0;
    }
}
