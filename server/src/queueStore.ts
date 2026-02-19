// Optimized QueueStore for high concurrency (100~1000 users)
// Changes vs previous:
// - Maintain byGround index to avoid scanning all users
// - Batch matching via a scheduler tick (debounced), not per-event immediate full scan
// - FIFO matching to avoid per-tick sort, and reduce O(k^2) blow-ups
//
// NOTE: This keeps the old public method name `tryMatch` so existing callers continue to work.
//       In this version, `tryMatch(groundId)` simply marks the ground as dirty for the next tick.

type BuffRange = { min?: number; max?: number };
export type BuffSpec = {
  simbi?: BuffRange; // 심비
  ppungbi?: BuffRange; // 뻥비
  sharpbi?: BuffRange; // 샾비
};

export type QueueStatus = "idle" | "searching" | "matched" | "paused";

export type QueueUser = {
  sid: string;             // session id
  discordId?: string;      // stable id if available
  nickname?: string;       // in-app nickname (unique)
  level?: number;
  job?: string;
  power?: number;
  groundId?: string;       // hunting ground id/name key used for grouping
  buffs?: BuffSpec;        // what the user provides/has OR what the party provides
  wants?: BuffSpec;        // what the user/party is looking for (optional)
  status: QueueStatus;
  matchedAt?: number;
  searchingSince?: number;
  blacklist?: string[];    // list of discordId or nickname strings
};

type MatchResult = {
  aSid: string;
  bSid: string;
  groundId: string;
  channel?: string;
  createdAt: number;
};

function now() {
  return Date.now();
}

function clampInt(x: any, lo: number, hi: number): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  const t = Math.trunc(n);
  return Math.max(lo, Math.min(hi, t));
}

function inRange(x: number | undefined, r?: BuffRange): boolean {
  if (r == null) return true;
  if (x == null) return false;
  const mn = r.min ?? -Infinity;
  const mx = r.max ?? Infinity;
  return x >= mn && x <= mx;
}

// `provider` offers buffs, `seeker` wants buffs.
// If seeker has no wants -> accept.
// If seeker has wants but provider has no buffs -> reject.
// For each buff, if seeker specifies range, provider must satisfy it.
function buffsCompatible(provider?: BuffSpec, seekerWants?: BuffSpec): boolean {
  if (!seekerWants) return true;

  // If seeker wants ANY constraint, provider must have that value.
  const p = provider ?? {};
  const w = seekerWants;

  const simOk = !w.simbi || inRange((p.simbi?.max ?? p.simbi?.min) as any, w.simbi);
  const ppOk = !w.ppungbi || inRange((p.ppungbi?.max ?? p.ppungbi?.min) as any, w.ppungbi);
  const shOk = !w.sharpbi || inRange((p.sharpbi?.max ?? p.sharpbi?.min) as any, w.sharpbi);

  return simOk && ppOk && shOk;
}

function normalizeIdLike(s?: string) {
  return (s ?? "").trim().toLowerCase();
}

function isBlacklisted(a: QueueUser, b: QueueUser): boolean {
  const aList = (a.blacklist ?? []).map(normalizeIdLike);
  const bList = (b.blacklist ?? []).map(normalizeIdLike);

  const aDid = normalizeIdLike(a.discordId);
  const bDid = normalizeIdLike(b.discordId);
  const aNick = normalizeIdLike(a.nickname);
  const bNick = normalizeIdLike(b.nickname);

  // any direction => exclude
  const aBlocksB =
    (bDid && aList.includes(bDid)) ||
    (bNick && aList.includes(bNick));
  const bBlocksA =
    (aDid && bList.includes(aDid)) ||
    (aNick && bList.includes(aNick));

  return aBlocksB || bBlocksA;
}

export class QueueStore {
  private users = new Map<string, QueueUser>(); // sid -> user

  // Index: groundId -> set of sids in that ground
  private byGround = new Map<string, Set<string>>();

  // Index: groundId -> FIFO array of sids currently searching (may contain stale sids, lazily cleaned)
  private searchingFifo = new Map<string, string[]>();

  // Quick membership for searching state (groundId -> set of searching sids)
  private searchingSet = new Map<string, Set<string>>();

  // GroundIds that need matching on next tick
  private dirtyGrounds = new Set<string>();

  // Stats
  private emaWaitMs = 0;
  private emaAlpha = 0.08;

  // Scheduler
  private tickMs: number;
  private maxPairsPerGroundPerTick: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts?: { tickMs?: number; maxPairsPerGroundPerTick?: number }) {
    this.tickMs = clampInt(opts?.tickMs ?? 150, 50, 1000);
    this.maxPairsPerGroundPerTick = clampInt(opts?.maxPairsPerGroundPerTick ?? 30, 1, 200);

    // Start the scheduler immediately (safe in single-node environment)
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Don't keep process alive only for timer
    // @ts-ignore
    if (this.timer?.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getEmaWaitMs() {
    return this.emaWaitMs;
  }

  getUser(sid: string) {
    return this.users.get(sid);
  }

  upsert(user: Partial<QueueUser> & { sid: string }) {
    const prev = this.users.get(user.sid);
    const next: QueueUser = {
      sid: user.sid,
      status: user.status ?? prev?.status ?? "idle",
      discordId: user.discordId ?? prev?.discordId,
      nickname: user.nickname ?? prev?.nickname,
      level: user.level ?? prev?.level,
      job: user.job ?? prev?.job,
      power: user.power ?? prev?.power,
      groundId: user.groundId ?? prev?.groundId,
      buffs: user.buffs ?? prev?.buffs,
      wants: user.wants ?? prev?.wants,
      blacklist: user.blacklist ?? prev?.blacklist ?? [],
      matchedAt: user.matchedAt ?? prev?.matchedAt,
      searchingSince: user.searchingSince ?? prev?.searchingSince,
    };

    this.users.set(user.sid, next);

    // Update ground index
    this.reindexGround(prev, next);

    // Update searching indexes
    this.reindexSearching(prev, next);

    // If user changes anything relevant, mark their ground dirty
    if (next.groundId) this.markDirty(next.groundId);

    return next;
  }

  remove(sid: string) {
    const prev = this.users.get(sid);
    if (!prev) return;

    this.users.delete(sid);

    // Remove from ground index
    if (prev.groundId) {
      const set = this.byGround.get(prev.groundId);
      if (set) {
        set.delete(sid);
        if (set.size === 0) this.byGround.delete(prev.groundId);
      }
      this.markDirty(prev.groundId);
    }

    // Remove from searching set (fifo lazily cleaned)
    if (prev.groundId) {
      const sset = this.searchingSet.get(prev.groundId);
      if (sset) {
        sset.delete(sid);
        if (sset.size === 0) this.searchingSet.delete(prev.groundId);
      }
    }
  }

  // Backward-compatible: old code may call tryMatch(groundId) on every event.
  // We debounce by marking dirty; scheduler tick will do work.
  tryMatch(groundId?: string) {
    if (!groundId) return;
    this.markDirty(groundId);
  }

  // Optional: explicitly request matching for user's current ground
  tryMatchByUser(sid: string) {
    const u = this.users.get(sid);
    if (u?.groundId) this.markDirty(u.groundId);
  }

  // returns sids in a ground (fast, uses index)
  listByGround(groundId: string): QueueUser[] {
    const set = this.byGround.get(groundId);
    if (!set) return [];
    const out: QueueUser[] = [];
    for (const sid of set) {
      const u = this.users.get(sid);
      if (u) out.push(u);
    }
    return out;
  }

  // In case you need "who's searching now" for UI or debugging
  listSearchingByGround(groundId: string): QueueUser[] {
    const sset = this.searchingSet.get(groundId);
    if (!sset) return [];
    const out: QueueUser[] = [];
    for (const sid of sset) {
      const u = this.users.get(sid);
      if (u) out.push(u);
    }
    return out;
  }

  // Called by server when it actually forms a match and needs to update both users.
  // This is a pure helper: mark matched & compute wait EMA.
  finalizeMatch(aSid: string, bSid: string) {
    const a = this.users.get(aSid);
    const b = this.users.get(bSid);
    if (!a || !b) return;

    const t = now();
    a.status = "matched";
    b.status = "matched";
    a.matchedAt = t;
    b.matchedAt = t;

    // Update EMA wait (use both searchingSince times if available)
    const aw = a.searchingSince ? t - a.searchingSince : 0;
    const bw = b.searchingSince ? t - b.searchingSince : 0;
    const w = (aw > 0 && bw > 0) ? Math.round((aw + bw) / 2) : (aw || bw || 0);
    if (w > 0) {
      this.emaWaitMs = this.emaWaitMs === 0 ? w : (this.emaWaitMs * (1 - this.emaAlpha) + w * this.emaAlpha);
    }

    // Remove from searching set
    if (a.groundId) this.searchingSet.get(a.groundId)?.delete(aSid);
    if (b.groundId) this.searchingSet.get(b.groundId)?.delete(bSid);
  }

  // === Internal ===
  private reindexGround(prev?: QueueUser, next?: QueueUser) {
    const prevG = prev?.groundId;
    const nextG = next?.groundId;

    if (prevG && prevG !== nextG) {
      const set = this.byGround.get(prevG);
      if (set) {
        set.delete(next!.sid);
        if (set.size === 0) this.byGround.delete(prevG);
      }
    }

    if (nextG) {
      let set = this.byGround.get(nextG);
      if (!set) {
        set = new Set<string>();
        this.byGround.set(nextG, set);
      }
      set.add(next!.sid);
    }
  }

  private reindexSearching(prev?: QueueUser, next?: QueueUser) {
    const prevG = prev?.groundId;
    const nextG = next?.groundId;

    // remove from old searching set if needed
    if (prev && prevG && (prevG !== nextG || prev.status !== next.status)) {
      if (prev.status === "searching") {
        this.searchingSet.get(prevG)?.delete(prev.sid);
      }
    }

    // add to new searching set if needed
    if (next && nextG && next.status === "searching") {
      let sset = this.searchingSet.get(nextG);
      if (!sset) {
        sset = new Set<string>();
        this.searchingSet.set(nextG, sset);
      }
      if (!sset.has(next.sid)) {
        sset.add(next.sid);

        // FIFO push (stale entries are OK; we'll lazily clean on tick)
        let fifo = this.searchingFifo.get(nextG);
        if (!fifo) {
          fifo = [];
          this.searchingFifo.set(nextG, fifo);
        }
        fifo.push(next.sid);
      }

      // Ensure searchingSince set
      if (!next.searchingSince) next.searchingSince = now();
    } else if (next && nextG && next.status !== "searching") {
      // If they stop searching, ensure membership removed
      this.searchingSet.get(nextG)?.delete(next.sid);
    }
  }

  private markDirty(groundId: string) {
    this.dirtyGrounds.add(groundId);
  }

  private tick() {
    if (this.dirtyGrounds.size === 0) return;

    // Copy then clear to avoid endless loops; newly dirtied grounds will be picked next tick.
    const grounds = Array.from(this.dirtyGrounds);
    this.dirtyGrounds.clear();

    for (const g of grounds) {
      this.matchGround(g);
    }
  }

  private matchGround(groundId: string) {
    const sset = this.searchingSet.get(groundId);
    if (!sset || sset.size < 2) return;

    const fifo = this.searchingFifo.get(groundId) ?? [];
    if (fifo.length === 0) return;

    let pairsFormed = 0;

    // Lazily clean FIFO head until it points to a valid searching sid
    const popValid = (): string | null => {
      while (fifo.length > 0) {
        const sid = fifo.shift()!;
        if (sset.has(sid)) return sid; // still searching
      }
      return null;
    };

    // Attempt to form pairs
    while (pairsFormed < this.maxPairsPerGroundPerTick && sset.size >= 2) {
      const aSid = popValid();
      if (!aSid) break;

      const a = this.users.get(aSid);
      if (!a || a.status !== "searching" || a.groundId !== groundId) {
        sset.delete(aSid);
        continue;
      }

      // Find a partner by scanning a limited window from FIFO to avoid O(k^2) worst-case.
      // If not found, requeue `aSid` once and stop for this tick to avoid spin.
      let bSid: string | null = null;

      const scanLimit = Math.min(60, fifo.length + 20); // allow some slack for stale entries
      const scanned: string[] = [];
      for (let i = 0; i < scanLimit; i++) {
        const cand = popValid();
        if (!cand) break;
        scanned.push(cand);

        const b = this.users.get(cand);
        if (!b || b.status !== "searching" || b.groundId !== groundId) {
          sset.delete(cand);
          continue;
        }

        // Blacklist exclusion
        if (isBlacklisted(a, b)) continue;

        // Buff compatibility (both directions if wants present)
        if (!buffsCompatible(a.buffs, b.wants)) continue;
        if (!buffsCompatible(b.buffs, a.wants)) continue;

        bSid = cand;
        break;
      }

      // Push back any scanned-but-not-used sids to the tail to keep FIFO fair
      if (bSid) {
        for (const sid of scanned) {
          if (sid !== bSid && sset.has(sid)) fifo.push(sid);
        }

        // Mark match: caller/server will likely emit socket event with details
        this.finalizeMatch(aSid, bSid);
        pairsFormed++;
      } else {
        // No partner found quickly; requeue A and also requeue scanned for fairness
        if (sset.has(aSid)) fifo.push(aSid);
        for (const sid of scanned) {
          if (sset.has(sid)) fifo.push(sid);
        }
        // Stop this tick to avoid burning CPU on hard-to-match sets
        break;
      }
    }

    // If still enough searching, keep dirty so we continue next tick
    const sset2 = this.searchingSet.get(groundId);
    if (sset2 && sset2.size >= 2) this.markDirty(groundId);
  }
}

// singleton export (match existing code style)
export const QUEUE = new QueueStore();
