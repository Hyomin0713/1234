// server/src/queueStore.ts
type BuffRange = { min?: number; max?: number };
export type BuffSpec = { simbi?: BuffRange; ppungbi?: BuffRange; sharpbi?: BuffRange };
export type QueueState = "idle" | "searching" | "matched" | "paused";

export type QueueUser = {
  sid: string;
  userId?: string;
  discordId?: string;
  socketId?: string;
  leaderId?: string;

  nickname?: string;
  displayName?: string;
  username?: string;

  level?: number;
  job?: string;
  power?: number;

  groundId?: string;
  huntingGroundId?: string;

  buffs?: BuffSpec;
  wants?: BuffSpec;
  blacklist?: string[];

  state: QueueState;
  status?: QueueState;
  searchingSince?: number;
  matchedAt?: number;

  matchId?: string;
  channel?: string;
};

function now() { return Date.now(); }
function norm(s?: string) { return (s ?? "").trim().toLowerCase(); }

function inRangeValue(v: number | undefined, r?: BuffRange): boolean {
  if (!r) return true;
  if (v == null) return false;
  const mn = r.min ?? -Infinity;
  const mx = r.max ?? Infinity;
  return v >= mn && v <= mx;
}
function pickProviderValue(r?: BuffRange): number | undefined {
  if (!r) return undefined;
  const v = (r.max ?? r.min);
  return typeof v === "number" ? v : undefined;
}
function buffsCompatible(provider?: BuffSpec, seekerWants?: BuffSpec): boolean {
  if (!seekerWants) return true;
  const p = provider ?? {};
  if (seekerWants.simbi && !inRangeValue(pickProviderValue(p.simbi), seekerWants.simbi)) return false;
  if (seekerWants.ppungbi && !inRangeValue(pickProviderValue(p.ppungbi), seekerWants.ppungbi)) return false;
  if (seekerWants.sharpbi && !inRangeValue(pickProviderValue(p.sharpbi), seekerWants.sharpbi)) return false;
  return true;
}
function isEitherBlacklisted(a: QueueUser, b: QueueUser): boolean {
  const aList = new Set((a.blacklist ?? []).map(norm));
  const bList = new Set((b.blacklist ?? []).map(norm));

  const aDid = norm(a.discordId ?? a.userId);
  const bDid = norm(b.discordId ?? b.userId);
  const aNick = norm(a.nickname);
  const bNick = norm(b.nickname);

  const aBlocksB = (!!bDid && aList.has(bDid)) || (!!bNick && aList.has(bNick));
  const bBlocksA = (!!aDid && bList.has(aDid)) || (!!aNick && bList.has(aNick));
  return aBlocksB || bBlocksA;
}

export class QueueStore {
  private users = new Map<string, QueueUser>();
  private searchingSet = new Map<string, Set<string>>();
  private fifo = new Map<string, string[]>();
  private dirty = new Set<string>();

  private tickMs = 150;
  private maxPairsPerGroundPerTick = 30;
  private timer: NodeJS.Timeout | null = null;

  private emaWaitMsByGround = new Map<string, number>();
  private emaAlpha = 0.08;

  constructor(opts?: { tickMs?: number; maxPairsPerGroundPerTick?: number }) {
    if (opts?.tickMs) this.tickMs = Math.max(50, Math.min(1000, Math.trunc(opts.tickMs)));
    if (opts?.maxPairsPerGroundPerTick) this.maxPairsPerGroundPerTick = Math.max(1, Math.min(200, Math.trunc(opts.maxPairsPerGroundPerTick)));
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // @ts-ignore
    if (this.timer?.unref) this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  get(sid: string) { return this.users.get(sid); }

  getCountsByGround() {
    const out: Record<string, number> = {};
    for (const [g, set] of this.searchingSet) out[g] = set.size;
    return out;
  }

  getAvgWaitByGround() {
    const out: Record<string, number> = {};
    for (const [g, v] of this.emaWaitMsByGround) out[g] = Math.round(v);
    return out;
  }

  tryMatch(groundId?: string, _a?: any, _b?: any) {
    if (!groundId) return;
    this.dirty.add(groundId);
  }

  leave(sid: string) {
    const u = this.users.get(sid);
    if (!u) return;
    const g = u.huntingGroundId ?? u.groundId;
    if (g) {
      this.searchingSet.get(g)?.delete(sid);
      this.dirty.add(g);
    }
    u.state = "idle";
    u.status = "idle";
  }

  setPartyForMatch(_partyId: string, _matchId: string) {}
  setChannelByLeader(_leaderId: string, _channel: string) { return { ok: true, members: [] as any[] }; }
  cleanupDanglingParties(_cb?: (pid: string) => void) { return [] as string[]; }

  upsert(arg1: any, arg2?: any): QueueUser {
    const patch: any = (typeof arg1 === "string") ? { sid: arg1, ...(arg2 ?? {}) } : arg1;
    const prev = this.users.get(patch.sid);

    const next: QueueUser = {
      sid: patch.sid,
      discordId: patch.discordId ?? prev?.discordId,
      userId: patch.userId ?? patch.discordId ?? prev?.userId ?? prev?.discordId,
      socketId: patch.socketId ?? prev?.socketId,
      leaderId: patch.leaderId ?? prev?.leaderId,

      nickname: patch.nickname ?? prev?.nickname,
      displayName: patch.displayName ?? prev?.displayName,
      username: patch.username ?? prev?.username,

      level: patch.level ?? prev?.level,
      job: patch.job ?? prev?.job,
      power: patch.power ?? prev?.power,

      groundId: patch.groundId ?? prev?.groundId,
      huntingGroundId: patch.huntingGroundId ?? patch.groundId ?? prev?.huntingGroundId ?? prev?.groundId,

      buffs: patch.buffs ?? prev?.buffs,
      wants: patch.wants ?? prev?.wants,
      blacklist: patch.blacklist ?? prev?.blacklist ?? [],

      state: patch.state ?? patch.status ?? prev?.state ?? (prev?.status as any) ?? "idle",
      status: patch.status ?? patch.state ?? prev?.status ?? prev?.state ?? "idle",

      searchingSince: patch.searchingSince ?? prev?.searchingSince,
      matchedAt: patch.matchedAt ?? prev?.matchedAt,

      matchId: patch.matchId ?? prev?.matchId,
      channel: patch.channel ?? prev?.channel,
    };

    next.status = next.state;

    this.users.set(next.sid, next);
    this.reindexSearching(prev, next);

    const g = next.huntingGroundId ?? next.groundId;
    if (g) this.dirty.add(g);

    return next;
  }

  remove(sid: string) {
    const prev = this.users.get(sid);
    if (!prev) return;
    this.users.delete(sid);
    const g = prev.huntingGroundId ?? prev.groundId;
    if (g) {
      this.searchingSet.get(g)?.delete(sid);
      this.dirty.add(g);
    }
  }

  finalizeMatch(aSid: string, bSid: string) {
    this.finalizeMatch2(aSid, bSid);
  }

  private reindexSearching(prev: QueueUser | undefined, next: QueueUser) {
    const prevG = prev?.huntingGroundId ?? prev?.groundId;
    const nextG = next.huntingGroundId ?? next.groundId;

    const prevState = prev?.state ?? prev?.status;
    const nextState = next.state ?? next.status;

    if (prev && prevG && (prevG !== nextG || prevState !== nextState)) {
      if (prevState === "searching") this.searchingSet.get(prevG)?.delete(prev.sid);
    }

    if (nextG && nextState === "searching") {
      let sset = this.searchingSet.get(nextG);
      if (!sset) { sset = new Set(); this.searchingSet.set(nextG, sset); }
      if (!sset.has(next.sid)) {
        sset.add(next.sid);
        let q = this.fifo.get(nextG);
        if (!q) { q = []; this.fifo.set(nextG, q); }
        q.push(next.sid);
      }
      if (!next.searchingSince) next.searchingSince = now();
    } else if (nextG && nextState !== "searching") {
      this.searchingSet.get(nextG)?.delete(next.sid);
    }
  }

  private tick() {
    if (this.dirty.size === 0) return;
    const grounds = Array.from(this.dirty);
    this.dirty.clear();
    for (const g of grounds) this.matchGround(g);
  }

  private popValid(q: string[], sset: Set<string>): string | null {
    while (q.length > 0) {
      const sid = q.shift()!;
      if (sset.has(sid)) return sid;
    }
    return null;
  }

  private matchGround(groundId: string) {
    const sset = this.searchingSet.get(groundId);
    if (!sset || sset.size < 2) return;

    const q = this.fifo.get(groundId);
    if (!q || q.length === 0) return;

    let pairs = 0;
    while (pairs < this.maxPairsPerGroundPerTick && sset.size >= 2) {
      const aSid = this.popValid(q, sset);
      if (!aSid) break;

      const a = this.users.get(aSid);
      if (!a) { sset.delete(aSid); continue; }
      const aState = a.state ?? a.status;
      const aG = a.huntingGroundId ?? a.groundId;
      if (aState !== "searching" || aG !== groundId) { sset.delete(aSid); continue; }

      let bSid: string | null = null;
      const scanned: string[] = [];
      const scanLimit = Math.min(60, q.length + 20);

      for (let i = 0; i < scanLimit; i++) {
        const cand = this.popValid(q, sset);
        if (!cand) break;
        scanned.push(cand);

        const b = this.users.get(cand);
        if (!b) { sset.delete(cand); continue; }
        const bState = b.state ?? b.status;
        const bG = b.huntingGroundId ?? b.groundId;
        if (bState !== "searching" || bG !== groundId) { sset.delete(cand); continue; }

        if (isEitherBlacklisted(a, b)) continue; // one-way blocks

        if (!buffsCompatible(a.buffs, b.wants)) continue;
        if (!buffsCompatible(b.buffs, a.wants)) continue;

        bSid = cand;
        break;
      }

      if (bSid) {
        for (const sid of scanned) if (sid != bSid && sset.has(sid)) q.push(sid);
        this.finalizeMatch2(aSid, bSid);
        pairs++;
      } else {
        if (sset.has(aSid)) q.push(aSid);
        for (const sid of scanned) if (sset.has(sid)) q.push(sid);
        break;
      }
    }

    const sset2 = this.searchingSet.get(groundId);
    if (sset2 && sset2.size >= 2) this.dirty.add(groundId);
  }

  private finalizeMatch2(aSid: string, bSid: string) {
    const a = this.users.get(aSid);
    const b = this.users.get(bSid);
    if (!a || !b) return;

    const t = now();
    a.state = "matched"; a.status = "matched";
    b.state = "matched"; b.status = "matched";
    a.matchedAt = t; b.matchedAt = t;

    const g = a.huntingGroundId ?? a.groundId ?? b.huntingGroundId ?? b.groundId ?? "unknown";
    const aw = a.searchingSince ? t - a.searchingSince : 0;
    const bw = b.searchingSince ? t - b.searchingSince : 0;
    const w = (aw > 0 && bw > 0) ? (aw + bw) / 2 : (aw || bw || 0);

    if (w > 0) {
      const prev = this.emaWaitMsByGround.get(g) ?? 0;
      const next = prev === 0 ? w : prev * (1 - this.emaAlpha) + w * this.emaAlpha;
      this.emaWaitMsByGround.set(g, next);
    }

    const ag = a.huntingGroundId ?? a.groundId;
    const bg = b.huntingGroundId ?? b.groundId;
    if (ag) this.searchingSet.get(ag)?.delete(aSid);
    if (bg) this.searchingSet.get(bg)?.delete(bSid);
  }
}

export const QUEUE = new QueueStore();
