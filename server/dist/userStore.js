function normStr(s, max = 64) {
    return String(s ?? "").trim().slice(0, max);
}
function normList(xs) {
    if (!Array.isArray(xs))
        return [];
    return xs
        .map((x) => normStr(x, 64))
        .filter(Boolean)
        .slice(0, 50);
}
function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v))
        return lo;
    return Math.max(lo, Math.min(hi, Math.floor(v)));
}
export class UserStore {
    byId = new Map();
    nameToId = new Map();
    get(userId) {
        const uid = normStr(userId, 64);
        if (!uid)
            return null;
        return this.byId.get(uid) ?? null;
    }
    rememberName(userId, displayName) {
        const uid = normStr(userId, 64);
        const name = normStr(displayName, 64);
        if (!uid || !name)
            return;
        this.nameToId.set(name, uid);
        this.nameToId.set(name.toLowerCase(), uid);
    }
    isNameAvailable(userId, displayName) {
        const uid = normStr(userId, 64);
        const name = normStr(displayName, 64);
        if (!uid || !name)
            return true;
        const key = name.toLowerCase();
        const existing = this.nameToId.get(key);
        return !existing || existing === uid;
    }
    resolveNameToId(s) {
        const t = normStr(s, 64);
        if (!t)
            return null;
        if (/^[0-9]{5,}$/.test(t))
            return t;
        return this.nameToId.get(t) ?? this.nameToId.get(t.toLowerCase()) ?? null;
    }
    upsert(userId, patch) {
        const uid = normStr(userId, 64);
        if (!uid)
            return null;
        const cur = this.byId.get(uid);
        const displayName = normStr(patch.displayName ?? cur?.displayName ?? "익명", 64) || "익명";
        const next = {
            userId: uid,
            displayName,
            level: clamp(patch.level ?? cur?.level ?? 1, 1, 300),
            job: patch.job ?? cur?.job ?? "전사",
            power: clamp(patch.power ?? cur?.power ?? 0, 0, 9_999_999),
            blacklist: normList(patch.blacklist ?? cur?.blacklist ?? []),
            updatedAt: Date.now(),
        };
        this.byId.set(uid, next);
        this.rememberName(uid, displayName);
        return next;
    }
}
export const USERS = new UserStore();
