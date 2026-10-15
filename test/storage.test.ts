import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    PostgresBlobStore,
    PostgresRecordStore,
    VersionConflictError,
    createFileSystemStorage,
    createMemoryStorage,
    migratePostgresStorage,
    type Render,
    type StorageAdapter,
} from "../src/index.js";

function scene(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        kind: "scene",
        version: 1,
        name: id,
        description: "",
        tags: [],
        references: [],
        cast: [],
        accessoryIds: [],
        camera: {},
        negative: [],
        generation: {},
        referenceSelections: [],
        continuity: {},
        castCharacterIds: [],
        usedAccessoryIds: [],
        createdAt,
        updatedAt: createdAt,
        ...extra,
    } as never;
}

let dir: string;
let pglite: PGlite;
const adapters: Array<[string, () => Promise<StorageAdapter>]> = [
    ["memory", async () => createMemoryStorage()],
    ["filesystem", async () => createFileSystemStorage({ rootDir: await mkdtemp(path.join(dir, "fs-")) })],
    [
        "postgres",
        async () => {
            const ns = `t${Math.random().toString(36).slice(2, 8)}`;
            return { records: new PostgresRecordStore({ client: pglite, namespace: ns }), blobs: new PostgresBlobStore({ client: pglite, namespace: ns }) };
        },
    ],
];

beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "imgen-storage-"));
    pglite = new PGlite();
    await migratePostgresStorage(pglite);
    await migratePostgresStorage(pglite); // idempotent
});
afterAll(async () => {
    await pglite.close();
    await rm(dir, { recursive: true, force: true });
});

describe.each(adapters)("%s storage", (_name, make) => {
    it("stores, filters, orders and paginates records", async () => {
        const { records } = await make();
        await records.put("scene", scene("a", "2026-01-01T00:00:00.000Z", { storyId: "s1", tags: ["x"] }));
        await records.put("scene", scene("b", "2026-01-02T00:00:00.000Z", { storyId: "s1" }));
        await records.put("scene", scene("c", "2026-01-03T00:00:00.000Z", { storyId: "s2", tags: ["x", "y"] }));

        expect((await records.get("scene", "a"))?.name).toBe("a");
        expect(await records.get("scene", "missing")).toBeNull();
        expect((await records.getMany("scene", ["c", "zz", "a"])).map((r) => r?.id ?? null)).toEqual(["c", null, "a"]);

        expect((await records.query("scene", { where: { storyId: "s1" } })).items.map((r) => r.id)).toEqual(["a", "b"]);
        expect((await records.query("scene", { contains: { tags: "x" } })).items.map((r) => r.id)).toEqual(["a", "c"]);
        expect((await records.query("scene", { in: { storyId: ["s2"] } })).items.map((r) => r.id)).toEqual(["c"]);
        expect((await records.query("scene", { where: { selectedRenderId: null } })).items).toHaveLength(3);
        expect((await records.query("scene", { createdSince: "2026-01-02T00:00:00.000Z" })).items.map((r) => r.id)).toEqual(["b", "c"]);
        expect(await records.count("scene", { where: { storyId: "s1" } })).toBe(2);

        const p1 = await records.query("scene", { order: "desc", limit: 2 });
        expect(p1.items.map((r) => r.id)).toEqual(["c", "b"]);
        const p2 = await records.query("scene", { order: "desc", limit: 2, cursor: p1.nextCursor });
        expect(p2.items.map((r) => r.id)).toEqual(["a"]);
        expect(p2.nextCursor).toBeUndefined();

        expect(await records.delete("scene", "a")).toBe(true);
        expect(await records.delete("scene", "a")).toBe(false);
    });

    it("enforces optimistic locking", async () => {
        const { records } = await make();
        await records.put("render", { id: "r1", version: 1, createdAt: "2026-01-01T00:00:00.000Z" } as Render, { expectedVersion: 0 });
        await expect(records.put("render", { id: "r1", version: 1, createdAt: "x" } as Render, { expectedVersion: 0 })).rejects.toBeInstanceOf(VersionConflictError);
        await records.put("render", { id: "r1", version: 2, createdAt: "2026-01-01T00:00:00.000Z" } as Render, { expectedVersion: 1 });
        await expect(records.put("render", { id: "r1", version: 2, createdAt: "x" } as Render, { expectedVersion: 1 })).rejects.toBeInstanceOf(VersionConflictError);
        expect((await records.get("render", "r1"))?.version).toBe(2);
    });

    it("stores blobs", async () => {
        const { blobs } = await make();
        await blobs.put("renders/r1.png", Buffer.from([1, 2, 3]), "image/png");
        expect(await blobs.get("renders/r1.png")).toEqual({ data: Buffer.from([1, 2, 3]), contentType: "image/png" });
        await expect(blobs.put("../escape.png", Buffer.from("x"), "image/png")).rejects.toThrow(/Unsafe/);
        expect(await blobs.delete("renders/r1.png")).toBe(true);
        expect(await blobs.get("renders/r1.png")).toBeNull();
    });
});

it("postgres namespaces are isolated", async () => {
    const a = new PostgresRecordStore({ client: pglite, namespace: "tenant_a" });
    const b = new PostgresRecordStore({ client: pglite, namespace: "tenant_b" });
    await a.put("scene", scene("shared-id", "2026-01-01T00:00:00.000Z"));
    expect(await b.get("scene", "shared-id")).toBeNull();
});
