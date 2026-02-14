export type Job = "전사" | "도적" | "궁수" | "마법사";

export type UserProfile = {
  userId: string;
  displayName: string;
  level: number;
  job: Job;
  power: number;
  blacklist: string[];
  updatedAt: number;
};

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

export class UserStore {
  private byId = new Map<string, UserProfile>();
  private nameToId = new Map<string, string>();

  rememberName(userId: string, displayName: string) {
    const uid = normStr(userId, 64);
    const name = normStr(displayName, 64);
    if (!uid || !name) return;
    this.nameToId.set(name, uid);
    this.nameToId.set(name.toLowerCase(), uid);
  }

  resolveNameToId(s: string): string | null {
    const t = normStr(s, 64);
    if (!t) return null;
    if (/^[0-9]{5,}$/.test(t)) return t;
    return this.nameToId.get(t) ?? this.nameToId.get(t.toLowerCase()) ?? null;
  }

  get(userId: string) {
    return this.byId.get(normStr(userId, 64));
  }

  upsert(userId: string, patch: Partial<UserProfile>) {
    const uid = normStr(userId, 64);
    if (!uid) return null;

    const cur = this.byId.get(uid);
    const displayName = normStr(patch.displayName ?? cur?.displayName ?? "익명", 64) || "익명";
    const next: UserProfile = {
      userId: uid,
      displayName,
      level: clamp(patch.level ?? cur?.level ?? 1, 1, 300),
      job: (patch.job as any) ?? cur?.job ?? "전사",
      power: clamp(patch.power ?? cur?.power ?? 0, 0, 9_999_999),
      blacklist: normList(patch.blacklist ?? cur?.blacklist ?? []),
      updatedAt: Date.now(),
    };
    this.byId.set(uid, next);
    this.rememberName(uid, displayName);
    return next;
  }
}

export const USERS = new UserStore();
