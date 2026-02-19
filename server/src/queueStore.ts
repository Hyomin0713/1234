// server/src/queueStore.ts
type BuffRange = { min?: number; max?: number };
export type BuffSpec = { simbi?: BuffRange; ppungbi?: BuffRange; sharpbi?: BuffRange };
export type QueueStatus = "idle" | "searching" | "matched" | "paused";

export type QueueUser = {
  sid: string;
  discordId?: string;
  nickname?: string;
  level?: number;
  job?: string;
  power?: number;
  groundId?: string;
  buffs?: BuffSpec;
  wants?: BuffSpec;
  status: QueueStatus;
  searchingSince?: number;
  matchedAt?: number;
  blacklist?: string[];
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
  const aDid = norm(a.discordId), bDid = norm(b.discordId);
  const aNick = norm(a.nickname), bNick = norm(b.nickname);
  const aBlocksB = (bDid && aList.has(bDid)) || (bNick && aList.has(bNick));
  const bBlocksA = (aDid && bList.has(aDid)) || (aNick && bList.has(aNick));
  return aBlocksB || bBlocksA;
}

export class QueueStore {
  private users = new Map<string, QueueUser>();
  private byGround = new Map<string, Set<string>>();
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

  // Compatibility surface for existing index.ts
  get(sid: string) { return this.users.get(sid); }
  getCountsByGround() { const out: Record<string, number> = {}; for (const [g, set] of this.searchingSet) out[g] = set.size; return out; }
  getAvgWaitByGround() { const out: Record<string, number> = {}; for (const [g, v] of this.emaWaitMsByGround) out[g] = Math.round(v); return out; }
  tryMatch(groundId?: string, _a?: any, _b?: any) { if (groundId) this.dirty.add(groundId); }
  leave(sid: string) { const u = this.users.get(sid); if (!u) return; if (u.groundId) { this.searchingSet.get(u.groundId)?.delete(sid); this.dirty.add(u.groundId); } u.status = "idle"; }

  // Stubs used by older index.ts flows (safe no-ops)
  setPartyForMatch(_partyId: string, _matchId: string) {}
  setChannelByLeader(_leaderSid: string, _channel: string) { return { ok: true }; }
  cleanupDanglingParties(_cb?: (pid: string) => void) {}

  upsert(u: Partial<QueueUser> & { sid: string }) {
    const prev = this.users.get(u.sid);
    const next: QueueUser = {
      sid: u.sid,
      status: u.status ?? prev?.status ?? "idle",
      discordId: u.discordId ?? prev?.discordId,
      nickname: u.nickname ?? prev?.nickname,
      level: u.level ?? prev?.level,
      job: u.job ?? prev?.job,
      power: u.power ?? prev?.power,
      groundId: u.groundId ?? prev?.groundId,
      buffs: u.buffs ?? prev?.buffs,
      wants: u.wants ?? prev?.wants,
      blacklist: u.blacklist ?? prev?.blacklist ?? [],
      searchingSince: u.searchingSince ?? prev?.searchingSince,
      matchedAt: u.matchedAt ?? prev?.matchedAt,
      channel: u.channel ?? prev?.channel,
    };
    this.users.set(next.sid, next);
    this.reindexGround(prev, next);
    this.reindexSearching(prev, next);
    if (next.groundId) this.dirty.add(next.groundId);
    return next;
  }

  remove(sid: string) {
    const prev = this.users.get(sid);
    if (!prev) return;
    this.users.delete(sid);
    if (prev.groundId) {
      this.byGround.get(prev.groundId)?.delete(sid);
      this.searchingSet.get(prev.groundId)?.delete(sid);
      this.dirty.add(prev.groundId);
    }
  }

  finalizeMatch(aSid: string, bSid: string) { this.finalizeMatch2(aSid, bSid); }

  private reindexGround(prev: QueueUser | undefined, next: QueueUser) {
    const prevG = prev?.groundId;
    const nextG = next.groundId;

    if (prevG && prevG !== nextG) {
      const set = this.byGround.get(prevG);
      if (set) {
        set.delete(next.sid);
        if (set.size === 0) this.byGround.delete(prevG);
      }
    }
    if (nextG) {
      let set = this.byGround.get(nextG);
      if (!set) { set = new Set(); this.byGround.set(nextG, set); }
      set.add(next.sid);
    }
  }

  private reindexSearching(prev: QueueUser | undefined, next: QueueUser) {
    const prevG = prev?.groundId;
    const nextG = next.groundId;

    if (prev && prevG && (prevG !== nextG || prev.status !== next.status)) {
      if (prev.status === "searching") this.searchingSet.get(prevG)?.delete(prev.sid);
    }

    if (nextG && next.status === "searching") {
      let sset = this.searchingSet.get(nextG);
      if (!sset) { sset = new Set(); this.searchingSet.set(nextG, sset); }
      if (!sset.has(next.sid)) {
        sset.add(next.sid);
        let q = this.fifo.get(nextG);
        if (!q) { q = []; this.fifo.set(nextG, q); }
        q.push(next.sid);
      }
      if (!next.searchingSince) next.searchingSince = now();
    } else if (nextG && next.status !== "searching") {
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
      if (!a || a.status !== "searching" || a.groundId !== groundId) {
        sset.delete(aSid);
        continue;
      }

      let bSid: string | null = null;
      const scanned: string[] = [];
      const scanLimit = Math.min(60, q.length + 20);

      for (let i = 0; i < scanLimit; i++) {
        const cand = this.popValid(q, sset);
        if (!cand) break;
        scanned.push(cand);

        const b = this.users.get(cand);
        if (!b || b.status !== "searching" || b.groundId !== groundId) {
          sset.delete(cand);
          continue;
        }

        // One-way blacklist => exclude (A blocks B OR B blocks A)
        if (isEitherBlacklisted(a, b)) continue;

        if (!buffsCompatible(a.buffs, b.wants)) continue;
        if (!buffsCompatible(b.buffs, a.wants)) continue;

        bSid = cand;
        break;
      }

      if (bSid) {
        for (const sid of scanned) if (sid !== bSid && sset.has(sid)) q.push(sid);
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
    a.status = "matched"; b.status = "matched";
    a.matchedAt = t; b.matchedAt = t;

    const g = a.groundId ?? b.groundId ?? "unknown";
    const aw = a.searchingSince ? t - a.searchingSince : 0;
    const bw = b.searchingSince ? t - b.searchingSince : 0;
    const w = (aw > 0 && bw > 0) ? (aw + bw) / 2 : (aw || bw || 0);

    if (w > 0) {
      const prev = this.emaWaitMsByGround.get(g) ?? 0;
      const next = prev === 0 ? w : prev * (1 - this.emaAlpha) + w * this.emaAlpha;
      this.emaWaitMsByGround.set(g, next);
    }

    if (a.groundId) this.searchingSet.get(a.groundId)?.delete(aSid);
    if (b.groundId) this.searchingSet.get(b.groundId)?.delete(bSid);
  }
}

export const QUEUE = new QueueStore();
