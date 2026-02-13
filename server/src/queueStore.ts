export type Job = "전사" | "도적" | "궁수" | "마법사";

export type QueueProfile = {
  nickname: string;
  level: number;
  job: Job;
  power: number;
  blacklist: string[];
};

export type QueueEntry = QueueProfile & {
  socketId: string;
  huntingGroundId: string;
  state: "idle" | "searching" | "matched";
  channel?: string;
  updatedAt: number;
};

function randChannel() {
  const n = Math.floor(Math.random() * 900) + 100; // 100-999
  return `x-${n}`;
}

function normNick(n: string) {
  return (n ?? "").trim().slice(0, 24);
}

function normList(xs: any): string[] {
  if (!Array.isArray(xs)) return [];
  return xs
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 50);
}

function clamp(n: any, lo: number, hi: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export class QueueStore {
  // nickname -> entry
  private byNick = new Map<string, QueueEntry>();

  get(nickname: string) {
    return this.byNick.get(normNick(nickname));
  }

  upsert(socketId: string, huntingGroundId: string | null, profile: Partial<QueueProfile>) {
    const nickname = normNick(profile.nickname ?? "");
    if (!nickname) return null;

    const prev = this.byNick.get(nickname);
    const now = Date.now();
    const next: QueueEntry = {
      socketId,
      huntingGroundId: huntingGroundId ?? prev?.huntingGroundId ?? "",
      nickname,
      level: clamp(profile.level ?? prev?.level ?? 1, 1, 250),
      job: (profile.job ?? prev?.job ?? "전사") as any,
      power: clamp(profile.power ?? prev?.power ?? 0, 0, 9_999_999),
      blacklist: normList(profile.blacklist ?? prev?.blacklist ?? []),
      state: prev?.state ?? "idle",
      channel: prev?.channel,
      updatedAt: now,
    };
    // if socket changed, replace
    next.socketId = socketId;

    this.byNick.set(nickname, next);
    return next;
  }

  join(socketId: string, huntingGroundId: string, profile: QueueProfile) {
    const entry = this.upsert(socketId, huntingGroundId, profile);
    if (!entry) return null;
    entry.huntingGroundId = huntingGroundId;
    entry.state = "searching";
    entry.channel = undefined;
    entry.updatedAt = Date.now();
    this.byNick.set(entry.nickname, entry);
    return entry;
  }

  leave(nickname: string) {
    const n = normNick(nickname);
    const e = this.byNick.get(n);
    if (!e) return null;
    e.state = "idle";
    e.channel = undefined;
    e.updatedAt = Date.now();
    this.byNick.set(n, e);
    return e;
  }

  removeBySocket(socketId: string) {
    for (const [nick, e] of this.byNick) {
      if (e.socketId === socketId) {
        // keep profile but mark idle
        e.state = "idle";
        e.channel = undefined;
        e.updatedAt = Date.now();
        this.byNick.set(nick, e);
      }
    }
  }

  private isBlocked(a: QueueEntry, b: QueueEntry) {
    const an = a.nickname;
    const bn = b.nickname;
    return a.blacklist.includes(bn) || b.blacklist.includes(an);
  }

  tryMatch(huntingGroundId: string) {
    const waiters = [...this.byNick.values()].filter((e) => e.state === "searching" && e.huntingGroundId === huntingGroundId);
    // oldest first
    waiters.sort((x, y) => x.updatedAt - y.updatedAt);

    for (let i = 0; i < waiters.length; i++) {
      for (let j = i + 1; j < waiters.length; j++) {
        const a = waiters[i];
        const b = waiters[j];
        if (a.socketId === b.socketId) continue;
        if (this.isBlocked(a, b)) continue;

        const channel = randChannel();
        a.state = "matched";
        b.state = "matched";
        a.channel = channel;
        b.channel = channel;
        a.updatedAt = Date.now();
        b.updatedAt = Date.now();

        this.byNick.set(a.nickname, a);
        this.byNick.set(b.nickname, b);

        return { a, b, channel };
      }
    }
    return null;
  }
}

export const QUEUE = new QueueStore();
