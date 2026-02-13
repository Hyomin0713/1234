export type Job = "전사" | "도적" | "궁수" | "마법사";

export type QueueProfile = {
  userId: string;
  displayName: string;
  level: number;
  job: Job;
  power: number;
  // blacklist identifiers - can be discord userIds OR names (server will resolve where possible)
  blacklist: string[];
};

export type QueueEntry = QueueProfile & {
  socketId: string;
  huntingGroundId: string;
  state: "idle" | "searching" | "matched";
  matchId?: string;
  leaderId?: string;
  channel?: string;
  updatedAt: number;
};

function randMatchId() {
  return `m_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function randChannel() {
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // A-Z
  const num = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0"); // 001-999
  return `${letter}-${num}`;
}

function normStr(s: any, max = 64) {
  return String(s ?? "").trim().slice(0, max);
}

function normList(xs: any): string[] {
  if (!Array.isArray(xs)) return [];
  return xs
    .map((x) => normStr(x, 64))
    .filter(Boolean)
    .slice(0, 50);
}

function clamp(n: any, lo: number, hi: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function hasMutualBlock(a: QueueEntry, b: QueueEntry, resolveNameToId: (s: string) => string | null) {
  const aSet = new Set(
    a.blacklist
      .map((x) => resolveNameToId(x) ?? normStr(x))
      .filter(Boolean)
  );
  const bSet = new Set(
    b.blacklist
      .map((x) => resolveNameToId(x) ?? normStr(x))
      .filter(Boolean)
  );
  // check by id first
  if (aSet.has(b.userId) || bSet.has(a.userId)) return true;
  // also check by displayName as fallback
  const aName = normStr(a.displayName, 64);
  const bName = normStr(b.displayName, 64);
  if (aSet.has(bName) || bSet.has(aName)) return true;
  return false;
}

export class QueueStore {
  // userId -> entry
  private byUserId = new Map<string, QueueEntry>();

  get(userId: string) {
    return this.byUserId.get(normStr(userId, 64));
  }

  remove(userId: string) {
    this.byUserId.delete(normStr(userId, 64));
  }

  upsert(socketId: string, huntingGroundId: string | null, profile: Partial<QueueProfile>) {
    const userId = normStr(profile.userId ?? "", 64);
    if (!userId) return { ok: false as const, error: "missing_user" };

    const displayName = normStr(profile.displayName ?? "익명", 64) || "익명";
    const hg = normStr(huntingGroundId ?? "", 64);
    if (!hg) return { ok: false as const, error: "missing_ground" };

    const next: QueueEntry = {
      userId,
      displayName,
      level: clamp(profile.level ?? 1, 1, 300),
      job: (profile.job as any) ?? "전사",
      power: clamp(profile.power ?? 0, 0, 9_999_999),
      blacklist: normList(profile.blacklist),
      socketId: normStr(socketId, 128),
      huntingGroundId: hg,
      state: "searching",
      updatedAt: Date.now()
    };
    this.byUserId.set(userId, next);
    return { ok: true as const, entry: next };
  }

  leave(userId: string) {
    const uid = normStr(userId, 64);
    const cur = this.byUserId.get(uid);
    if (!cur) return { ok: false as const };
    cur.state = "idle";
    cur.matchId = undefined;
    cur.leaderId = undefined;
    cur.channel = undefined;
    cur.updatedAt = Date.now();
    this.byUserId.set(uid, cur);
    return { ok: true as const, entry: cur };
  }

  listByGround(huntingGroundId: string) {
    const hg = normStr(huntingGroundId, 64);
    const xs: QueueEntry[] = [];
    for (const e of this.byUserId.values()) {
      if (e.huntingGroundId === hg && e.state !== "idle") xs.push(e);
    }
    xs.sort((a, b) => b.updatedAt - a.updatedAt);
    return xs;
  }

  // naive match: pair up the oldest two searching users who are not mutually blocked
  tryMatch(huntingGroundId: string, resolveNameToId: (s: string) => string | null) {
    const xs = this.listByGround(huntingGroundId).filter((e) => e.state === "searching");
    for (let i = xs.length - 1; i >= 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const a = xs[i];
        const b = xs[j];
        if (a.userId === b.userId) continue;
        if (hasMutualBlock(a, b, resolveNameToId)) continue;

        // Leader sets the channel after matching.
        const matchId = randMatchId();
        const leaderId = a.userId;
        a.state = "matched";
        b.state = "matched";
        a.matchId = matchId;
        b.matchId = matchId;
        a.leaderId = leaderId;
        b.leaderId = leaderId;
        a.channel = undefined;
        b.channel = undefined;
        a.updatedAt = Date.now();
        b.updatedAt = Date.now();
        this.byUserId.set(a.userId, a);
        this.byUserId.set(b.userId, b);
        return { ok: true as const, a, b, matchId, leaderId };
      }
    }
    return { ok: false as const };
  }

  setChannelByLeader(leaderId: string, channel: string) {
    const lid = normStr(leaderId, 64);
    const leader = this.byUserId.get(lid);
    if (!leader || leader.state !== "matched") return { ok: false as const, error: "not_matched" };
    if (leader.leaderId !== lid) return { ok: false as const, error: "not_leader" };
    const matchId = leader.matchId;
    if (!matchId) return { ok: false as const, error: "no_match" };

    const ch = normStr(channel, 16);
    if (!/^[A-Z]-\d{3}$/.test(ch)) return { ok: false as const, error: "bad_channel" };

    const members: QueueEntry[] = [];
    for (const e of this.byUserId.values()) {
      if (e.matchId === matchId && e.state === "matched") members.push(e);
    }
    if (members.length < 2) return { ok: false as const, error: "missing_pair" };
    for (const e of members) {
      e.channel = ch;
      e.updatedAt = Date.now();
      this.byUserId.set(e.userId, e);
    }
    return { ok: true as const, matchId, channel: ch, members };
  }
}

export const QUEUE = new QueueStore();
