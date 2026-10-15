import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-signed, expiring blob links so `<img src>` works without auth headers. */
export function signBlobPath(path: string, secret: string, ttlSeconds = 3600, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + ttlSeconds;
    const sig = createHmac("sha256", secret).update(`${path}\n${exp}`).digest("base64url");
    return `${path}?exp=${exp}&sig=${sig}`;
}

export function verifyBlobSignature(path: string, exp: string | null, sig: string | null, secret: string, now = Date.now()): boolean {
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
    const expected = createHmac("sha256", secret).update(`${path}\n${exp}`).digest();
    const given = Buffer.from(sig, "base64url");
    return given.length === expected.length && timingSafeEqual(given, expected);
}
