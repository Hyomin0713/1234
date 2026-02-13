export type Buffs = {
  simb: number; // 심비
  bbeong: number; // 뻥비
  sharp: number; // 샾비
};

export type PartyMember = {
  userId: string;
  displayName: string;
  joinedAt: number;
};

export type Party = {
  channel: string;

  partyId: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  members: PartyMember[];
  buffs: Buffs;
};

function clampInt(n: any, lo: number, hi: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function normStr(s: any, max = 64) {
  return String(s ?? "").trim().slice(0, max);
}

function makePartyId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export class PartyStore {
  private parties = new Map<string, Party>(); // partyId -> Party
  private userToParty = new Map<string, string>(); // userId -> partyId

  getParty(partyId: string) {
    return this.parties.get(normStr(partyId, 16));
  }

  getPartyIdOfUser(userId: string) {
    return this.userToParty.get(normStr(userId, 64));
  }

  getPartyOfUser(userId: string) {
    const pid = this.getPartyIdOfUser(userId);
    if (!pid) return null;
    return this.getParty(pid) ?? null;
  }

  createForMatchedPair(a: { userId: string; displayName: string }, b: { userId: string; displayName: string }, opts?: { channel?: string }) {
    const ap = this.getPartyOfUser(a.userId);
    if (ap) return ap;
    const bp = this.getPartyOfUser(b.userId);
    if (bp) return bp;

    const partyId = makePartyId();
    const now = Date.now();
    const party: Party = {
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

  leave(userId: string) {
    const uid = normStr(userId, 64);
    const pid = this.userToParty.get(uid);
    if (!pid) return null;

    const p = this.parties.get(pid);
    this.userToParty.delete(uid);
    if (!p) return null;

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

  setChannel(ownerId: string, channel: string) {
    const party = this.getPartyOfUser(ownerId);
    if (!party) return null;
    if (party.ownerId !== ownerId) return null;
    const v = isValidChannel(channel);
    if (!v) return null;
    party.channel = v;
    party.updatedAt = Date.now();
    this.parties.set(party.partyId, party);
    return party;
  }

  updateBuffs(userId: string, patch: Partial<Buffs>) {
    const party = this.getPartyOfUser(userId);
    if (!party) return null;
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


function isValidChannel(s: any) {
  const t = String(s ?? "").trim().toUpperCase();
  // A-Z-001..999
  if (!/^[A-Z]-\d{3}$/.test(t)) return null;
  const num = Number(t.split("-")[1]);
  if (!Number.isFinite(num) || num < 1 || num > 999) return null;
  return t;
}
