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

function extractDiscordId(s) {
    const raw = String(s ?? "").trim();
    const m = raw.match(/(\d{15,20})/);
    return m ? m[1] : null;
}
function normNameKey(s) {
    return normStr(s, 64).toLowerCase();
}

function hasMutualBlock(a, b, resolveNameToId) {
    const aIds = new Set();
    const bIds = new Set();
    const aNames = new Set();
    const bNames = new Set();
    for (const x of (a.blacklist ?? [])) {
        const raw = normStr(x, 64);
        if (!raw)
            continue;
        const id = extractDiscordId(raw) ?? resolveNameToId(raw) ?? (/^\d{15,20}$/.test(raw) ? raw : null);
        if (id)
            aIds.add(id);
        aNames.add(raw.toLowerCase());
    }
    for (const x of (b.blacklist ?? [])) {
        const raw = normStr(x, 64);
        if (!raw)
            continue;
        const id = extractDiscordId(raw) ?? resolveNameToId(raw) ?? (/^\d{15,20}$/.test(raw) ? raw : null);
        if (id)
            bIds.add(id);
        bNames.add(raw.toLowerCase());
    }
    if (aIds.has(b.userId) || bIds.has(a.userId))
        return true;
    if (aNames.has(b.userId.toLowerCase()) || bNames.has(a.userId.toLowerCase()))
        return true;
    const aName = normNameKey(a.displayName);
    const bName = normNameKey(b.displayName);
    if (aNames.has(bName) || bNames.has(aName))
        return true;
    return false;
}
export class QueueStore {
    // userId -> entry
    byUserId = new Map();
    // groundId -> EMA avg wait ms
    avgWaitMsByGround = new Map();
    EMA_ALPHA = 0.25; // higher = more reactive
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
            searchingSince: Date.now(),
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
        cur.searchingSince = undefined;
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
                // track wait time (best-effort)
                const now = Date.now();
                const aSince = a.searchingSince ?? now;
                const bSince = b.searchingSince ?? now;
                const waitMs = Math.max(0, now - Math.min(aSince, bSince));
                this.bumpAvgWait(huntingGroundId, waitMs);
                a.state = "matched";
                b.state = "matched";
                a.matchId = matchId;
                b.matchId = matchId;
                a.leaderId = leaderId;
                b.leaderId = leaderId;
                a.channel = undefined;
                b.channel = undefined;
                a.searchingSince = undefined;
                b.searchingSince = undefined;
                a.updatedAt = Date.now();
                b.updatedAt = Date.now();
                this.byUserId.set(a.userId, a);
                this.byUserId.set(b.userId, b);
                return { ok: true, a, b, matchId, leaderId };
            }
        }
        return { ok: false };
    }
    bumpAvgWait(huntingGroundId, waitMs) {
        const hg = normStr(huntingGroundId, 64);
        if (!hg)
            return;
        const prev = this.avgWaitMsByGround.get(hg);
        const next = prev == null ? waitMs : prev * (1 - this.EMA_ALPHA) + waitMs * this.EMA_ALPHA;
        this.avgWaitMsByGround.set(hg, Math.max(0, Math.floor(next)));
    }
    getAvgWaitByGround() {
        const out = {};
        for (const [k, v] of this.avgWaitMsByGround.entries())
            out[k] = v;
        return out;
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
