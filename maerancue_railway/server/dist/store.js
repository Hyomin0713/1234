function randCode(len = 6) {
    const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let out = "";
    for (let i = 0; i < len; i++)
        out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
function hash(pw) {
    // very light hash (NOT for high security); ok for hobby project
    let h = 0;
    for (let i = 0; i < pw.length; i++)
        h = (h * 31 + pw.charCodeAt(i)) >>> 0;
    return String(h);
}
class PartyStore {
    parties = new Map();
    createParty(owner, title) {
        let id = randCode();
        while (this.parties.has(id))
            id = randCode();
        const now = Date.now();
        const party = {
            id,
            title: title.trim() || "파티",
            ownerId: owner.userId,
            isLocked: false,
            lockPasswordHash: null,
            members: [
                { userId: owner.userId, name: owner.name, joinedAt: now, buffs: { simbi: 0, ppeongbi: 0, syapbi: 0 } }
            ],
            createdAt: now,
            updatedAt: now
        };
        this.parties.set(id, party);
        return party;
    }
    listParties() {
        return Array.from(this.parties.values()).map((p) => ({
            id: p.id,
            title: p.title,
            ownerId: p.ownerId,
            isLocked: p.isLocked,
            memberCount: p.members.length,
            updatedAt: p.updatedAt
        }));
    }
    getParty(id) {
        return this.parties.get(id) ?? null;
    }
    deleteParty(id) {
        this.parties.delete(id);
    }
    ensureMember(partyId, userId, name) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        // remove duplicates
        p.members = p.members.filter((m) => m.userId !== userId);
        p.members.push({ userId, name, joinedAt: Date.now(), buffs: { simbi: 0, ppeongbi: 0, syapbi: 0 } });
        p.updatedAt = Date.now();
        return p;
    }
    removeMember(partyId, userId) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        p.members = p.members.filter((m) => m.userId !== userId);
        if (p.ownerId === userId && p.members.length) {
            p.ownerId = p.members[0].userId;
        }
        p.updatedAt = Date.now();
        if (!p.members.length) {
            this.parties.delete(partyId);
            return null;
        }
        return p;
    }
    setBuffs(partyId, userId, buffs) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        const m = p.members.find((x) => x.userId === userId);
        if (!m)
            return null;
        m.buffs = {
            simbi: buffs.simbi ?? m.buffs.simbi,
            ppeongbi: buffs.ppeongbi ?? m.buffs.ppeongbi,
            syapbi: buffs.syapbi ?? m.buffs.syapbi
        };
        p.updatedAt = Date.now();
        return p;
    }
    updateMemberName(partyId, memberId, displayName) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        const m = p.members.find((x) => x.userId === memberId);
        if (!m)
            return null;
        m.name = displayName.trim() || m.name;
        p.updatedAt = Date.now();
        return p;
    }
    updateTitle(partyId, title) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        p.title = title.trim() || p.title;
        p.updatedAt = Date.now();
        return p;
    }
    transferOwner(partyId, newOwnerId) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        if (!p.members.some((m) => m.userId === newOwnerId))
            return null;
        p.ownerId = newOwnerId;
        p.updatedAt = Date.now();
        return p;
    }
    setLock(partyId, isLocked, password) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        p.isLocked = isLocked;
        p.lockPasswordHash = isLocked ? hash(password ?? "") : null;
        p.updatedAt = Date.now();
        return p;
    }
    canJoin(partyId, password) {
        const p = this.parties.get(partyId);
        if (!p)
            return { ok: false, reason: "NOT_FOUND" };
        if (!p.isLocked)
            return { ok: true };
        if (hash(password ?? "") !== p.lockPasswordHash)
            return { ok: false, reason: "BAD_PASSWORD" };
        return { ok: true };
    }
}
export const STORE = new PartyStore();
