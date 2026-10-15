import type { ZodError } from "zod";

export type StoryErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "IN_USE" | "PROVIDER" | "LIMIT" | "CONFIG";

export class StoryEngineError extends Error {
    constructor(
        readonly code: StoryErrorCode,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = "StoryEngineError";
    }
}

export class NotFoundError extends StoryEngineError {
    constructor(kind: string, id: string) {
        super("NOT_FOUND", `${kind} "${id}" not found`, { kind, id });
    }
}

export class ValidationError extends StoryEngineError {
    constructor(message: string, details?: unknown) {
        super("VALIDATION", message, details);
    }

    static fromZod(context: string, error: ZodError): ValidationError {
        const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
        return new ValidationError(`Invalid ${context}: ${summary}`, issues);
    }
}

export class ConflictError extends StoryEngineError {
    constructor(message: string, details?: unknown) {
        super("CONFLICT", message, details);
    }
}

export class InUseError extends StoryEngineError {
    constructor(kind: string, id: string, usedBy: Array<{ kind: string; id: string }>) {
        const list = usedBy.map((u) => `${u.kind}:${u.id}`).join(", ");
        super("IN_USE", `${kind} "${id}" is still referenced by ${list}`, { kind, id, usedBy });
    }
}

export class ProviderError extends StoryEngineError {
    constructor(message: string, details?: unknown) {
        super("PROVIDER", message, details);
    }
}

export class VersionConflictError extends ConflictError {
    constructor(kind: string, id: string, expected: number, actual: number | undefined) {
        super(`${kind} "${id}" was modified concurrently (expected version ${expected}, found ${actual ?? "none"})`, {
            kind,
            id,
            expected,
            actual,
        });
    }
}

export class LimitExceededError extends StoryEngineError {
    constructor(message: string, details?: unknown) {
        super("LIMIT", message, details);
    }
}

export class ConfigError extends StoryEngineError {
    constructor(message: string, details?: unknown) {
        super("CONFIG", message, details);
    }
}
