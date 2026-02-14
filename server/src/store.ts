export type Buffs = { simbi: number; ppeongbi: number; syapbi: number };
export type Job = "전사" | "도적" | "궁수" | "마법사";
export type PartyMember = {
  userId: string;
  name: string;
  level: number;
  job: Job;
  power: number;
  joinedAt: number;
  lastSeenAt: number;
  buffs: Buffs;
};
export type Party = {
  id: string;
  title: string;
  ownerId: string;
  groundId: string | null;
  groundName: string | null;
  isLocked: boolean;
  lockPasswordHash: string | null;
  members: PartyMember[];
  createdAt: number;
  updatedAt: number;
};

const PARTY_MAX_MEMBERS = 6;

function pickNextOwnerId(members: PartyMember[]): string {
  if (!members.length) return "";
  const sorted = [...members].sort((a, b) => {
    const as = a.lastSeenAt ?? a.joinedAt;
    const bs = b.lastSeenAt ?? b.joinedAt;
    if (bs !== as) return bs - as;
    return (a.joinedAt ?? 0) - (b.joinedAt ?? 0);
  });
  return sorted[0]?.userId ?? "";
}

function randCode(len = 6) {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function hash(pw: string) {

  let h = 0;
  for (let i = 0; i < pw.length; i++) h = (h * 31 + pw.charCodeAt(i)) >>> 0;
  return String(h);
}

class PartyStore {
  private parties = new Map<string, Party>();

  createParty(args: { title: string; ownerId: string; ownerName: string; lockPassword?: string | null; groundId?: string | null; groundName?: string | null; ownerLevel?: number; ownerJob?: Job; ownerPower?: number }) {
    let id = randCode();
    while (this.parties.has(id)) id = randCode();
    const now = Date.now();
    const party: Party = {
      id,
      title: args.title.trim() || "파티",
      ownerId: args.ownerId,
      groundId: (args.groundId ?? null),
      groundName: (args.groundName ?? null),
      isLocked: false,
      lockPasswordHash: null,
      members: [
        {
          userId: args.ownerId,
          name: args.ownerName,
          level: Math.max(1, Math.min(300, Math.floor(Number(args.ownerLevel ?? 1) || 1))),
          job: (args.ownerJob ?? "전사"),
          power: Math.max(0, Math.min(9_999_999, Math.floor(Number(args.ownerPower ?? 0) || 0))),
          joinedAt: now,
          lastSeenAt: now,
          buffs: { simbi: 0, ppeongbi: 0, syapbi: 0 }
        }
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
      groundId: p.groundId,
      groundName: p.groundName,
      isLocked: p.isLocked,
      memberCount: p.members.length,
      updatedAt: p.updatedAt
    }));
  }

  getParty(id: string) {
    return this.parties.get(id) ?? null;
  }

  deleteParty(id: string) {
    this.parties.delete(id);
  }

  ensureMember(partyId: string, userId: string, name: string, profile?: { level?: number; job?: Job; power?: number }) {
    const p = this.parties.get(partyId);
    if (!p) return null;

    const now = Date.now();
    const idx = p.members.findIndex((m) => m.userId === userId);

    const nextLevel = Math.max(1, Math.min(300, Math.floor(Number(profile?.level ?? 1) || 1)));
    const nextJob: Job = (profile?.job ?? "전사");
    const nextPower = Math.max(0, Math.min(9_999_999, Math.floor(Number(profile?.power ?? 0) || 0)));

    if (idx >= 0) {

      const prev = p.members[idx];
      p.members[idx] = {
        ...prev,
        name,
        level: nextLevel,
        job: nextJob,
        power: nextPower,
        lastSeenAt: now,
      };
    } else {
      if (p.members.length >= PARTY_MAX_MEMBERS) return null;
      p.members.push({
        userId,
        name,
        level: nextLevel,
        job: nextJob,
        power: nextPower,
        joinedAt: now,
        lastSeenAt: now,
        buffs: { simbi: 0, ppeongbi: 0, syapbi: 0 }
      });
    }

    p.updatedAt = now;
    return p;
  }

  updateMemberProfile(userId: string, patch: { name?: string; level?: number; job?: Job; power?: number }) {
    const touched: string[] = [];
    for (const [pid, p] of this.parties) {
      const idx = p.members.findIndex((m) => m.userId === userId);
      if (idx < 0) continue;
      const m = p.members[idx];
      p.members[idx] = {
        ...m,
        name: (patch.name ?? m.name),
        level: patch.level != null ? Math.max(1, Math.min(300, Math.floor(Number(patch.level) || 1))) : m.level,
        job: (patch.job ?? m.job),
        power: patch.power != null ? Math.max(0, Math.min(9_999_999, Math.floor(Number(patch.power) || 0))) : m.power,
      };

      p.updatedAt = Date.now();
      touched.push(pid);
    }
    return touched;
  }

  removeMember(partyId: string, userId: string) {
    const p = this.parties.get(partyId);
    if (!p) return null;
    p.members = p.members.filter((m) => m.userId !== userId);
    if (p.ownerId === userId && p.members.length) {
      p.ownerId = pickNextOwnerId(p.members);
    }
    p.updatedAt = Date.now();
    if (!p.members.length) {
      this.parties.delete(partyId);
      return null;
    }
    return p;
  }



  joinParty(args: { partyId: string; userId: string; name: string; lockPassword?: string | null; groundId?: string | null; groundName?: string | null; level?: number; job?: Job; power?: number }) {
    const chk = this.canJoin(args.partyId, args.lockPassword ?? undefined);
    if (!chk.ok) throw new Error(chk.reason);

    const cur = this.getParty(args.partyId);
    if (!cur) throw new Error("NOT_FOUND");
    const already = cur.members.some((m) => m.userId === args.userId);
    if (!already && cur.members.length >= PARTY_MAX_MEMBERS) throw new Error("FULL");

    const p = this.ensureMember(args.partyId, args.userId, args.name, { level: args.level, job: args.job, power: args.power });
    if (!p) throw new Error("NOT_FOUND");
    return p;
  }

  rejoin(args: { partyId: string; userId: string; name: string; level?: number; job?: Job; power?: number }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");

    const already = p.members.some((m) => m.userId === args.userId);
    if (!already && p.members.length >= PARTY_MAX_MEMBERS) throw new Error("FULL");


    this.ensureMember(args.partyId, args.userId, args.name, { level: args.level, job: args.job, power: args.power });

    return this.getParty(args.partyId);
  }

  leaveParty(args: { partyId: string; userId: string }) {
    this.removeMember(args.partyId, args.userId);
    return this.getParty(args.partyId);
  }

  updateTitle(args: { partyId: string; userId: string; title: string }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");
    if (p.ownerId !== args.userId) throw new Error("NOT_OWNER");
    const out = this.updateTitleInternal(args.partyId, args.title);
    if (!out) throw new Error("NOT_FOUND");
    return out;
  }

  updateMemberName(args: { partyId: string; userId: string; memberId: string; displayName: string }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");
    if (args.userId !== args.memberId && p.ownerId !== args.userId) throw new Error("FORBIDDEN");
    const m = p.members.find((x) => x.userId === args.memberId);
    if (!m) throw new Error("NOT_FOUND");
    m.name = args.displayName.trim() || m.name;
    m.lastSeenAt = Date.now();
    p.updatedAt = Date.now();
    return p;
  }

  updateBuffs(args: { partyId: string; userId: string; buffs: Partial<Buffs> }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");
    if (p.ownerId !== args.userId) throw new Error("NOT_OWNER");
    const out = this.setBuffs(args.partyId, args.userId, args.buffs);
    if (!out) throw new Error("NOT_FOUND");
    return out;
  }

  kick(args: { partyId: string; userId: string; targetUserId: string }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");
    if (p.ownerId !== args.userId) throw new Error("NOT_OWNER");
    const out = this.removeMember(args.partyId, args.targetUserId);
    if (!out) throw new Error("NOT_FOUND");
    return out;
  }

  transferOwner(args: { partyId: string; userId: string; newOwnerId: string }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");
    if (p.ownerId !== args.userId) throw new Error("NOT_OWNER");
    const out = this.transferOwnerInternal(args.partyId, args.newOwnerId);
    if (!out) throw new Error("NOT_FOUND");
    return out;
  }

  setLock(args: { partyId: string; userId: string; isLocked: boolean; lockPassword?: string | null }) {
    const p = this.getParty(args.partyId);
    if (!p) throw new Error("NOT_FOUND");
    if (p.ownerId !== args.userId) throw new Error("NOT_OWNER");
    const out = this.setLockInternal(args.partyId, args.isLocked, args.lockPassword ?? null);
    if (!out) throw new Error("NOT_FOUND");
    return out;
  }


  setBuffs(partyId: string, userId: string, buffs: Partial<Buffs>) {
    const p = this.parties.get(partyId);
    if (!p) return null;
    const m = p.members.find((x) => x.userId === userId);
    if (!m) return null;
    m.buffs = {
      simbi: buffs.simbi ?? m.buffs.simbi,
      ppeongbi: buffs.ppeongbi ?? m.buffs.ppeongbi,
      syapbi: buffs.syapbi ?? m.buffs.syapbi
    };
    m.lastSeenAt = Date.now();
    p.updatedAt = Date.now();
    return p;
  }

  updateTitleInternal(partyId: string, title: string) {
    const p = this.parties.get(partyId);
    if (!p) return null;
    p.title = title.trim() || p.title;
    p.updatedAt = Date.now();
    return p;
  }

  transferOwnerInternal(partyId: string, newOwnerId: string) {
    const p = this.parties.get(partyId);
    if (!p) return null;
    if (!p.members.some((m) => m.userId === newOwnerId)) return null;
    p.ownerId = newOwnerId;
    p.updatedAt = Date.now();
    return p;
  }

  setLockInternal(partyId: string, isLocked: boolean, password: string | null) {
    const p = this.parties.get(partyId);
    if (!p) return null;
    p.isLocked = isLocked;
    p.lockPasswordHash = isLocked ? hash(password ?? "") : null;
    p.updatedAt = Date.now();
    return p;
  }


  touchMember(partyId: string, userId: string) {
    const p = this.parties.get(partyId);
    if (!p) return null;
    const m = p.members.find((x) => x.userId === userId);
    if (!m) return null;
    m.lastSeenAt = Date.now();
    p.updatedAt = Date.now();
    return p;
  }


  sweepStaleMembers(opts: { memberTtlMs: number; partyTtlMs: number }) {
    const now = Date.now();
    const changed = new Set<string>();

    for (const [partyId, p] of this.parties.entries()) {

      const newestSeen = p.members.reduce((mx, m) => Math.max(mx, m.lastSeenAt ?? m.joinedAt), 0);
      if (now - newestSeen > opts.partyTtlMs) {
        this.parties.delete(partyId);
        changed.add(partyId);
        continue;
      }

      const before = p.members.length;
      p.members = p.members.filter((m) => now - (m.lastSeenAt ?? m.joinedAt) <= opts.memberTtlMs);
      if (p.members.length !== before) {

        if (!p.members.some((m) => m.userId === p.ownerId)) {
          p.ownerId = pickNextOwnerId(p.members);
        }
        p.updatedAt = now;
        if (p.members.length === 0) {
          this.parties.delete(partyId);
        } else {
          this.parties.set(partyId, p);
        }
        changed.add(partyId);
      }
    }
    return Array.from(changed);
  }

  canJoin(partyId: string, password: string | undefined) {
    const p = this.parties.get(partyId);
    if (!p) return { ok: false as const, reason: "NOT_FOUND" as const };
    if (!p.isLocked) return { ok: true as const };
    if (hash(password ?? "") !== p.lockPasswordHash) return { ok: false as const, reason: "BAD_PASSWORD" as const };
    return { ok: true as const };
  }
}

export const STORE = new PartyStore();
