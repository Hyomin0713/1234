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
    createParty(args) {
        let id = randCode();
        while (this.parties.has(id))
            id = randCode();
        const now = Date.now();
        const party = {
            id,
            title: args.title.trim() || "파티",
            ownerId: args.ownerId,
            isLocked: false,
            lockPasswordHash: null,
            members: [
                { userId: args.ownerId, name: args.ownerName, joinedAt: now, buffs: { simbi: 0, ppeongbi: 0, syapbi: 0 } }
            ],
            createdAt: now,
            updatedAt: now
        };
        if (args.lockPassword) {
            party.isLocked = true;
            party.lockPasswordHash = hash(args.lockPassword);
        }
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
    joinParty(args) {
        const chk = this.canJoin(args.partyId, args.lockPassword ?? undefined);
        if (!chk.ok)
            throw new Error(chk.reason);
        const p = this.ensureMember(args.partyId, args.userId, args.name);
        if (!p)
            throw new Error("NOT_FOUND");
        return p;
    }
    rejoin(args) {
        const p = this.getParty(args.partyId);
        if (!p)
            throw new Error("NOT_FOUND");
        if (!p.members.some((m) => m.userId === args.userId)) {
            this.ensureMember(args.partyId, args.userId, args.name);
        }
        return this.getParty(args.partyId);
    }
    leaveParty(args) {
        this.removeMember(args.partyId, args.userId);
        return this.getParty(args.partyId);
    }
    updateTitle(args) {
        const p = this.getParty(args.partyId);
        if (!p)
            throw new Error("NOT_FOUND");
        if (p.ownerId !== args.userId)
            throw new Error("NOT_OWNER");
        const out = this.updateTitleInternal(args.partyId, args.title);
        if (!out)
            throw new Error("NOT_FOUND");
        return out;
    }
    updateMemberName(args) {
        const p = this.getParty(args.partyId);
        if (!p)
            throw new Error("NOT_FOUND");
        if (args.userId !== args.memberId && p.ownerId !== args.userId)
            throw new Error("FORBIDDEN");
        const m = p.members.find((x) => x.userId === args.memberId);
        if (!m)
            throw new Error("NOT_FOUND");
        m.name = args.displayName.trim() || m.name;
        p.updatedAt = Date.now();
        return p;
    }
    updateBuffs(args) {
        const out = this.setBuffs(args.partyId, args.userId, args.buffs);
        if (!out)
            throw new Error("NOT_FOUND");
        return out;
    }
    kick(args) {
        const p = this.getParty(args.partyId);
        if (!p)
            throw new Error("NOT_FOUND");
        if (p.ownerId !== args.userId)
            throw new Error("NOT_OWNER");
        const out = this.removeMember(args.partyId, args.targetUserId);
        if (!out)
            throw new Error("NOT_FOUND");
        return out;
    }
    transferOwner(args) {
        const p = this.getParty(args.partyId);
        if (!p)
            throw new Error("NOT_FOUND");
        if (p.ownerId !== args.userId)
            throw new Error("NOT_OWNER");
        const out = this.transferOwnerInternal(args.partyId, args.newOwnerId);
        if (!out)
            throw new Error("NOT_FOUND");
        return out;
    }
    setLock(args) {
        const p = this.getParty(args.partyId);
        if (!p)
            throw new Error("NOT_FOUND");
        if (p.ownerId !== args.userId)
            throw new Error("NOT_OWNER");
        const out = this.setLockInternal(args.partyId, args.isLocked, args.lockPassword ?? null);
        if (!out)
            throw new Error("NOT_FOUND");
        return out;
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
    updateTitleInternal(partyId, title) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        p.title = title.trim() || p.title;
        p.updatedAt = Date.now();
        return p;
    }
    transferOwnerInternal(partyId, newOwnerId) {
        const p = this.parties.get(partyId);
        if (!p)
            return null;
        if (!p.members.some((m) => m.userId === newOwnerId))
            return null;
        p.ownerId = newOwnerId;
        p.updatedAt = Date.now();
        return p;
    }
    setLockInternal(partyId, isLocked, password) {
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
