export type Job = "전사" | "도적" | "궁수" | "마법사" | "";

export type BuffRange = { min: number; max: number };

export type PartyBuffs = {
  sim: BuffRange;
  ppeong: BuffRange;
  sharp: BuffRange;
};

export type UserProfile = {
  userId: string;
  discordName: string;
  nickname: string; // 메랜큐 표시용
  level: number;
  job: Job;
  atk: number; // 스공(간단히 number)
  blacklist: string[]; // userId 리스트
};

const users = new Map<string, UserProfile>();

function normNick(s: string) {
  return s.trim();
}

export function getUser(userId: string): UserProfile | null {
  return users.get(userId) || null;
}

export function isNicknameAvailable(nickname: string, exceptUserId?: string) {
  const n = normNick(nickname);
  if (!n) return false;
  for (const u of users.values()) {
    if (exceptUserId && u.userId === exceptUserId) continue;
    if (normNick(u.nickname) === n) return false;
  }
  return true;
}

export function upsertUser(input: Partial<UserProfile> & { userId: string; discordName: string }) {
  const prev = users.get(input.userId);
  const next: UserProfile = {
    userId: input.userId,
    discordName: input.discordName,
    nickname: input.nickname ?? prev?.nickname ?? "",
    level: input.level ?? prev?.level ?? 1,
    job: (input.job ?? prev?.job ?? "") as any,
    atk: input.atk ?? prev?.atk ?? 0,
    blacklist: input.blacklist ?? prev?.blacklist ?? [],
  };
  users.set(input.userId, next);
  return next;
}

export function setNickname(userId: string, nickname: string, discordName: string) {
  const n = normNick(nickname);
  if (!n) throw new Error("NICK_REQUIRED");
  if (!isNicknameAvailable(n, userId)) throw new Error("NICK_TAKEN");
  return upsertUser({ userId, discordName, nickname: n });
}

export function addToBlacklist(userId: string, targetUserId: string, discordName: string) {
  const u = upsertUser({ userId, discordName });
  if (!u.blacklist.includes(targetUserId)) u.blacklist.push(targetUserId);
  return u;
}

export function removeFromBlacklist(userId: string, targetUserId: string, discordName: string) {
  const u = upsertUser({ userId, discordName });
  u.blacklist = u.blacklist.filter((x) => x !== targetUserId);
  users.set(userId, u);
  return u;
}
