import { randomUUID } from "node:crypto";
import type { RecordKind } from "./domain/schemas.js";

const PREFIX: Record<RecordKind | "reference", string> = {
    character: "chr",
    style: "sty",
    location: "loc",
    accessory: "acc",
    scene: "scn",
    story: "sto",
    render: "rnd",
    reference: "ref",
};

export function newId(kind: RecordKind | "reference"): string {
    return `${PREFIX[kind]}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
    return new Date().toISOString();
}
