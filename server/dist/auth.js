const SESSIONS = new Map();
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
function randId(len = 32) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let out = "";
    for (let i = 0; i < len; i++)
        out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
export function newSession(user) {
    const sessionId = randId(40);
    const now = Date.now();
    const s = { sessionId, user, createdAt: now, lastSeenAt: now };
    SESSIONS.set(sessionId, s);
    return s;
}
export function getSession(sessionId) {
    if (!sessionId)
        return null;
    const s = SESSIONS.get(sessionId);
    if (!s)
        return null;
    const now = Date.now();
    if (now - s.lastSeenAt > TTL_MS) {
        SESSIONS.delete(sessionId);
        return null;
    }
    s.lastSeenAt = now;
    return s;
}
export function deleteSession(sessionId) {
    if (!sessionId)
        return;
    SESSIONS.delete(sessionId);
}
export function cleanupSessions() {
    const now = Date.now();
    for (const [id, s] of SESSIONS) {
        if (now - s.lastSeenAt > TTL_MS)
            SESSIONS.delete(id);
    }
}
export function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader)
        return out;
    const parts = cookieHeader.split(/;\s*/g);
    for (const part of parts) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        out[k] = decodeURIComponent(v);
    }
    return out;
}
export function cookieSerialize(name, value, opts = {}) {
    const segs = [`${name}=${encodeURIComponent(value)}`];
    segs.push(`Path=${opts.path ?? "/"}`);
    if (opts.maxAge !== undefined)
        segs.push(`Max-Age=${opts.maxAge}`);
    if (opts.httpOnly)
        segs.push("HttpOnly");
    if (opts.secure)
        segs.push("Secure");
    if (opts.sameSite)
        segs.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
    return segs.join("; ");
}
