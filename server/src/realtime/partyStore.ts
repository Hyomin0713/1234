import { Buffs, Job, Party, PartyStatePayload, QueueUser } from "./types";

/**
 * In-memory store for MVP. Later you can swap this with Redis.
 * Designed for: max 6 party members, a few hundred concurrent users.
 */

const DEFAULT_TTL_MINUTES = Number(process.env.PARTY_TTL_MINUTES ?? 30);
const HEARTBEAT_GRACE_MS = Number(process.env.HEARTBEAT_GRACE_MS ?? 2 * 60_000); // 2 minutes

function now() { return Date.now(); }
function randId(prefix: string) { return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`; }

export class PartyStore {
  // primary stores
  public usersById = new Map<string, QueueUser>();
  public partiesById = new Map<string, Party>();

  // indexes for fast match
  public openPartyIds = new Set<string>(); // party.isOpen && party.status==="open" && not full
  public openPartyIdsByJob = new Map<Job, Set<string>>(); // optional: parties that "want" job

  // socket presence mapping
  public socketsByUserId = new Map<string, string>(); // userId -> socket.id

  // simple in-process locks to avoid overfill on concurrency
  private partyLocks = new Set<string>();

  constructor() {
    // initialize openPartyIdsByJob
    for (const j of ["warrior", "thief", "archer", "mage"] as Job[]) {
      this.openPartyIdsByJob.set(j, new Set());
    }
  }

  // ---- users ----
  upsertUser(userId: string, job: Job, blacklist: string[] = []) {
    const prev = this.usersById.get(userId);
    const u: QueueUser = {
      id: userId,
      job,
      blacklist,
      partyId: prev?.partyId,
      lastSeenAt: now(),
    };
    this.usersById.set(userId, u);
    return u;
  }

  touchUser(userId: string) {
    const u = this.usersById.get(userId);
    if (!u) return;
    u.lastSeenAt = now();
  }

  setUserSocket(userId: string, socketId: string) {
    this.socketsByUserId.set(userId, socketId);
  }

  clearUserSocket(userId: string, socketId?: string) {
    const cur = this.socketsByUserId.get(userId);
    if (!socketId || cur === socketId) this.socketsByUserId.delete(userId);
  }

  // ---- parties ----
  createParty(leaderId: string, leaderJob: Job, opts?: { isOpen?: boolean; maxMembers?: number }) {
    // ensure leader user exists
    this.upsertUser(leaderId, leaderJob, this.usersById.get(leaderId)?.blacklist ?? []);

    const id = randId("party");
    const created = now();
    const party: Party = {
      id,
      leaderId,
      members: [leaderId],
      maxMembers: Math.max(1, Math.min(6, opts?.maxMembers ?? 6)),
      buffs: { simbi: 0, ppungbi: 0, shopbi: 0 },
      isOpen: opts?.isOpen ?? true,
      status: "open",
      createdAt: created,
      updatedAt: created,
      expiresAt: created + DEFAULT_TTL_MINUTES * 60_000,
    };

    this.partiesById.set(id, party);

    const leader = this.usersById.get(leaderId)!;
    leader.partyId = id;

    this.reindexParty(party);
    return party;
  }

  getParty(partyId: string) {
    return this.partiesById.get(partyId);
  }

  setPartyOpen(partyId: string, isOpen: boolean) {
    const p = this.partiesById.get(partyId);
    if (!p) return null;
    p.isOpen = isOpen;
    p.updatedAt = now();
    this.reindexParty(p);
    return p;
  }

  updateBuffs(partyId: string, buffs: Partial<Buffs>) {
    const p = this.partiesById.get(partyId);
    if (!p) return null;
    p.buffs = {
      simbi: typeof buffs.simbi === "number" ? buffs.simbi : p.buffs.simbi,
      ppungbi: typeof buffs.ppungbi === "number" ? buffs.ppungbi : p.buffs.ppungbi,
      shopbi: typeof buffs.shopbi === "number" ? buffs.shopbi : p.buffs.shopbi,
    };
    p.updatedAt = now();
    return p;
  }

  // lock helper to avoid concurrent join overfilling
  async withPartyLock<T>(partyId: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.partyLocks.has(partyId)) return null;
    this.partyLocks.add(partyId);
    try {
      return await fn();
    } finally {
      this.partyLocks.delete(partyId);
    }
  }

  // join party (manual or random assigned)
  joinParty(partyId: string, userId: string, job: Job, blacklist: string[] = []) {
    const p = this.partiesById.get(partyId);
    if (!p) return { ok: false as const, reason: "PARTY_NOT_FOUND" as const };

    if (p.status !== "open" || !p.isOpen) {
      // manual joins may be allowed even if isOpen=false; if you want, loosen this.
      // For MVP, we allow manual join even if isOpen=false by checking a flag later.
    }

    if (p.members.includes(userId)) return { ok: true as const, party: p };

    if (p.members.length >= p.maxMembers) return { ok: false as const, reason: "PARTY_FULL" as const };

    // ensure user exists
    const u = this.upsertUser(userId, job, blacklist);

    // already in another party?
    if (u.partyId && u.partyId !== partyId) return { ok: false as const, reason: "USER_IN_OTHER_PARTY" as const };

    // blacklist conflict check
    for (const mid of p.members) {
      const m = this.usersById.get(mid);
      if (!m) continue;
      if (this.isBlacklisted(u, m)) return { ok: false as const, reason: "BLACKLIST_CONFLICT" as const };
    }

    p.members.push(userId);
    p.updatedAt = now();
    u.partyId = partyId;

    // auto match if full
    if (p.members.length >= p.maxMembers) {
      p.status = "matched";
      p.isOpen = false;
      // channelId is assigned elsewhere by matchmaker; keep as-is here
    }

    this.reindexParty(p);
    return { ok: true as const, party: p };
  }

  leaveParty(partyId: string, userId: string) {
    const p = this.partiesById.get(partyId);
    if (!p) return null;

    p.members = p.members.filter((id) => id !== userId);
    p.updatedAt = now();

    const u = this.usersById.get(userId);
    if (u && u.partyId === partyId) delete u.partyId;

    // if leader left, pick new leader
    if (p.leaderId === userId) {
      p.leaderId = p.members[0] ?? p.leaderId;
    }

    // if party empty -> delete
    if (p.members.length === 0) {
      this.deleteParty(partyId);
      return null;
    }

    // if previously matched but now not full, keep matched if you want.
    // MVP: if someone leaves matched party, keep status matched (channel already decided).
    // If you want, revert to open only if not yet "confirmed".

    // if open & under max, keep open
    this.reindexParty(p);
    return p;
  }

  deleteParty(partyId: string) {
    const p = this.partiesById.get(partyId);
    if (!p) return;

    // clear user party refs
    for (const uid of p.members) {
      const u = this.usersById.get(uid);
      if (u && u.partyId === partyId) delete u.partyId;
    }

    this.partiesById.delete(partyId);
    this.deindexParty(partyId);
  }

  assignChannel(partyId: string, channelId: string) {
    const p = this.partiesById.get(partyId);
    if (!p) return null;
    p.channelId = channelId;
    p.status = "matched";
    p.isOpen = false;
    p.updatedAt = now();
    this.reindexParty(p);
    return p;
  }

  // party state payload for clients
  toPartyState(partyId: string): PartyStatePayload | null {
    const p = this.partiesById.get(partyId);
    if (!p) return null;
    const members = p.members
      .map((id) => this.usersById.get(id))
      .filter(Boolean)
      .map((u) => ({ id: u!.id, job: u!.job }));
    return {
      partyId: p.id,
      leaderId: p.leaderId,
      members,
      buffs: p.buffs,
      status: p.status,
      isOpen: p.isOpen,
      channelId: p.channelId,
      expiresAt: p.expiresAt,
    };
  }

  // ---- maintenance ----
  cleanupExpired() {
    const t = now();
    for (const [partyId, p] of this.partiesById.entries()) {
      if (p.expiresAt <= t) {
        p.status = "expired";
        this.deleteParty(partyId);
      }
    }

    // optional: remove users that are inactive and not in any party
    for (const [userId, u] of this.usersById.entries()) {
      const inactive = (t - u.lastSeenAt) > HEARTBEAT_GRACE_MS;
      if (inactive && !u.partyId) {
        this.usersById.delete(userId);
        this.clearUserSocket(userId);
      }
    }
  }

  // ---- indexing ----
  reindexParty(p: Party) {
    this.deindexParty(p.id);

    const isOpenCandidate = p.status === "open" && p.isOpen && p.members.length < p.maxMembers;
    if (isOpenCandidate) {
      this.openPartyIds.add(p.id);

      // "needs job" index: if party already has that job, we can still allow;
      // But for better diversity, index parties by jobs they DO NOT have yet.
      const present = new Set<Job>();
      for (const uid of p.members) {
        const u = this.usersById.get(uid);
        if (u) present.add(u.job);
      }
      for (const j of ["warrior", "thief", "archer", "mage"] as Job[]) {
        if (!present.has(j)) this.openPartyIdsByJob.get(j)!.add(p.id);
      }
    }
  }

  deindexParty(partyId: string) {
    this.openPartyIds.delete(partyId);
    for (const set of this.openPartyIdsByJob.values()) set.delete(partyId);
  }

  // ---- utils ----
  isBlacklisted(a: QueueUser, b: QueueUser): boolean {
    return a.blacklist.includes(b.id) || b.blacklist.includes(a.id);
  }
}
