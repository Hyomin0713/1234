function clampInt(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v))
        return lo;
    return Math.max(lo, Math.min(hi, Math.floor(v)));
}
function normStr(s, max = 64) {
    return String(s ?? "").trim().slice(0, max);
}
function makePartyId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++)
        out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
export class PartyStore {
    parties = new Map();
    userToParty = new Map();
    getParty(partyId) {
        return this.parties.get(normStr(partyId, 16));
    }
    getPartyIdOfUser(userId) {
        return this.userToParty.get(normStr(userId, 64));
    }
    getPartyOfUser(userId) {
        const pid = this.getPartyIdOfUser(userId);
        if (!pid)
            return null;
        return this.getParty(pid) ?? null;
    }
    createForMatchedPair(a, b, opts) {
        const ap = this.getPartyOfUser(a.userId);
        if (ap)
            return ap;
        const bp = this.getPartyOfUser(b.userId);
        if (bp)
            return bp;
        const partyId = makePartyId();
        const now = Date.now();
        const party = {
            partyId,
            ownerId: a.userId,
            channel: (opts?.channel ?? "A-001"),
            createdAt: now,
            updatedAt: now,
            members: [
                { userId: a.userId, displayName: normStr(a.displayName, 64) || "익명", joinedAt: now },
                { userId: b.userId, displayName: normStr(b.displayName, 64) || "익명", joinedAt: now },
            ],
            buffs: { simb: 0, bbeong: 0, sharp: 0 },
        };
        this.parties.set(partyId, party);
        this.userToParty.set(a.userId, partyId);
        this.userToParty.set(b.userId, partyId);
        return party;
    }
    leave(userId) {
        const uid = normStr(userId, 64);
        const pid = this.userToParty.get(uid);
        if (!pid)
            return null;
        const p = this.parties.get(pid);
        this.userToParty.delete(uid);
        if (!p)
            return null;
        p.members = p.members.filter((m) => m.userId !== uid);
        p.updatedAt = Date.now();
        if (p.ownerId === uid) {
            p.ownerId = p.members[0]?.userId ?? "";
        }
        if (p.members.length === 0) {
            this.parties.delete(pid);
            return null;
        }
        this.parties.set(pid, p);
        return p;
    }
    setChannel(ownerId, channel) {
        const party = this.getPartyOfUser(ownerId);
        if (!party)
            return null;
        if (party.ownerId !== ownerId)
            return null;
        const v = isValidChannel(channel);
        if (!v)
            return null;
        party.channel = v;
        party.updatedAt = Date.now();
        this.parties.set(party.partyId, party);
        return party;
    }
    updateBuffs(userId, patch) {
        const party = this.getPartyOfUser(userId);
        if (!party)
            return null;
        party.buffs = {
            simb: clampInt(patch.simb ?? party.buffs.simb, 0, 300),
            bbeong: clampInt(patch.bbeong ?? party.buffs.bbeong, 0, 300),
            sharp: clampInt(patch.sharp ?? party.buffs.sharp, 0, 300),
        };
        party.updatedAt = Date.now();
        this.parties.set(party.partyId, party);
        return party;
    }
}
export const PARTY = new PartyStore();
function isValidChannel(s) {
    const t = String(s ?? "").trim().toUpperCase();
    if (!/^[A-Z]-\d{3}$/.test(t))
        return null;
    const num = Number(t.split("-")[1]);
    if (!Number.isFinite(num) || num < 1 || num > 999)
        return null;
    return t;
}
