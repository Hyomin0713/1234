function randMatchId() {
    return `m_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
function randChannel() {
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // A-Z
    const num = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0"); // 001-999
    return `${letter}-${num}`;
}
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
function hasMutualBlock(a, b, resolveNameToId) {
    const aSet = new Set(a.blacklist
        .map((x) => resolveNameToId(x) ?? normStr(x))
        .filter(Boolean));
    const bSet = new Set(b.blacklist
        .map((x) => resolveNameToId(x) ?? normStr(x))
        .filter(Boolean));
    // check by id first
    if (aSet.has(b.userId) || bSet.has(a.userId))
        return true;
    // also check by displayName as fallback
    const aName = normStr(a.displayName, 64);
    const bName = normStr(b.displayName, 64);
    if (aSet.has(bName) || bSet.has(aName))
        return true;
    return false;
}
export class QueueStore {
    // userId -> entry
    byUserId = new Map();
    get(userId) {
        return this.byUserId.get(normStr(userId, 64));
    }
    remove(userId) {
        this.byUserId.delete(normStr(userId, 64));
    }
    upsert(socketId, huntingGroundId, profile) {
        const userId = normStr(profile.userId ?? "", 64);
        if (!userId)
            return { ok: false, error: "missing_user" };
        const displayName = normStr(profile.displayName ?? "익명", 64) || "익명";
        const hg = normStr(huntingGroundId ?? "", 64);
        if (!hg)
            return { ok: false, error: "missing_ground" };
        const next = {
            userId,
            displayName,
            level: clamp(profile.level ?? 1, 1, 300),
            job: profile.job ?? "전사",
            power: clamp(profile.power ?? 0, 0, 9_999_999),
            blacklist: normList(profile.blacklist),
            socketId: normStr(socketId, 128),
            huntingGroundId: hg,
            state: "searching",
            partyId: undefined,
            updatedAt: Date.now()
        };
        this.byUserId.set(userId, next);
        return { ok: true, entry: next };
    }
    leave(userId) {
        const uid = normStr(userId, 64);
        const cur = this.byUserId.get(uid);
        if (!cur)
            return { ok: false };
        cur.state = "idle";
        cur.matchId = undefined;
        cur.leaderId = undefined;
        cur.channel = undefined;
        cur.partyId = undefined;
        cur.updatedAt = Date.now();
        this.byUserId.set(uid, cur);
        return { ok: true, entry: cur };
    }
    setPartyForMatch(matchId, partyId) {
        const mid = normStr(matchId, 128);
        const pid = normStr(partyId, 64);
        const members = [];
        for (const e of this.byUserId.values()) {
            if (e.matchId === mid && e.state === "matched") {
                e.partyId = pid;
                e.updatedAt = Date.now();
                this.byUserId.set(e.userId, e);
                members.push(e);
            }
        }
        return members;
    }
    listByGround(huntingGroundId) {
        const hg = normStr(huntingGroundId, 64);
        const xs = [];
        for (const e of this.byUserId.values()) {
            if (e.huntingGroundId === hg && e.state !== "idle")
                xs.push(e);
        }
        xs.sort((a, b) => b.updatedAt - a.updatedAt);
        return xs;
    }
    /**
     * Return counts of active queue entries (searching+matched) grouped by huntingGroundId.
     * Useful for UI to show "현재 큐 n명".
     */
    getCountsByGround() {
        const counts = {};
        for (const e of this.byUserId.values()) {
            if (!e.huntingGroundId)
                continue;
            if (e.state === "idle")
                continue;
            counts[e.huntingGroundId] = (counts[e.huntingGroundId] ?? 0) + 1;
        }
        return counts;
    }
    // naive match: pair up the oldest two searching users who are not mutually blocked
    tryMatch(huntingGroundId, resolveNameToId) {
        const xs = this.listByGround(huntingGroundId).filter((e) => e.state === "searching");
        for (let i = xs.length - 1; i >= 0; i--) {
            for (let j = i - 1; j >= 0; j--) {
                const a = xs[i];
                const b = xs[j];
                if (a.userId === b.userId)
                    continue;
                if (hasMutualBlock(a, b, resolveNameToId))
                    continue;
                // Leader sets the channel after matching.
                const matchId = randMatchId();
                const leaderId = a.userId;
                a.state = "matched";
                b.state = "matched";
                a.matchId = matchId;
                b.matchId = matchId;
                a.leaderId = leaderId;
                b.leaderId = leaderId;
                a.channel = undefined;
                b.channel = undefined;
                a.updatedAt = Date.now();
                b.updatedAt = Date.now();
                this.byUserId.set(a.userId, a);
                this.byUserId.set(b.userId, b);
                return { ok: true, a, b, matchId, leaderId };
            }
        }
        return { ok: false };
    }
    setChannelByLeader(leaderId, channel) {
        const lid = normStr(leaderId, 64);
        const leader = this.byUserId.get(lid);
        if (!leader || leader.state !== "matched")
            return { ok: false, error: "not_matched" };
        if (leader.leaderId !== lid)
            return { ok: false, error: "not_leader" };
        const matchId = leader.matchId;
        if (!matchId)
            return { ok: false, error: "no_match" };
        const ch = normStr(channel, 16);
        if (!/^[A-Z]-\d{3}$/.test(ch))
            return { ok: false, error: "bad_channel" };
        const members = [];
        for (const e of this.byUserId.values()) {
            if (e.matchId === matchId && e.state === "matched")
                members.push(e);
        }
        if (members.length < 2)
            return { ok: false, error: "missing_pair" };
        for (const e of members) {
            e.channel = ch;
            e.updatedAt = Date.now();
            this.byUserId.set(e.userId, e);
        }
        return { ok: true, matchId, channel: ch, members };
    }
    /**
     * Clear queue entries that reference parties that no longer exist.
     * This prevents clients from being stuck with a stale partyId after TTL/disband.
     */
    cleanupDanglingParties(partyExists) {
        const now = Date.now();
        const cleaned = [];
        for (const e of this.byUserId.values()) {
            if (!e.partyId)
                continue;
            const pid = normStr(e.partyId, 64);
            if (!pid)
                continue;
            if (partyExists(pid))
                continue;
            e.state = "idle";
            e.matchId = undefined;
            e.leaderId = undefined;
            e.channel = undefined;
            e.partyId = undefined;
            e.updatedAt = now;
            this.byUserId.set(e.userId, e);
            cleaned.push(e);
        }
        return cleaned;
    }
}
export const QUEUE = new QueueStore();
