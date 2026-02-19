// server/src/userStore.ts
export type UserProfile = {
  sid: string;
  discordId?: string;
  username?: string;
  nickname?: string;
  level?: number;
  job?: string;
  power?: number;
  blacklist: string[];
};

function norm(s?: string) {
  return (s ?? "").trim().toLowerCase();
}

export class UserStore {
  private bySid = new Map<string, UserProfile>();
  private nicknameToSid = new Map<string, string>();

  get(sid: string) {
    return this.bySid.get(sid);
  }

  isNameAvailable(nickname: string, sid?: string) {
    const key = norm(nickname);
    if (!key) return false;
    const owner = this.nicknameToSid.get(key);
    if (!owner) return true;
    return sid ? owner === sid : false;
  }

  upsert(input: Partial<UserProfile> & { sid: string }) {
    const prev = this.bySid.get(input.sid);
    const next: UserProfile = {
      sid: input.sid,
      discordId: input.discordId ?? prev?.discordId,
      username: input.username ?? prev?.username,
      nickname: input.nickname ?? prev?.nickname,
      level: input.level ?? prev?.level,
      job: input.job ?? prev?.job,
      power: input.power ?? prev?.power,
      blacklist: input.blacklist ?? prev?.blacklist ?? [],
    };

    const prevNick = norm(prev?.nickname);
    const nextNick = norm(next.nickname);

    if (prevNick && prevNick !== nextNick) {
      const owner = this.nicknameToSid.get(prevNick);
      if (owner === next.sid) this.nicknameToSid.delete(prevNick);
    }
    if (nextNick) this.nicknameToSid.set(nextNick, next.sid);

    this.bySid.set(next.sid, next);
    return next;
  }

  addToBlacklist(sid: string, value: string) {
    const u = this.bySid.get(sid);
    if (!u) return;
    const v = norm(value);
    if (!v) return;
    const xs = new Set((u.blacklist ?? []).map(norm));
    xs.add(v);
    u.blacklist = Array.from(xs);
  }

  remove(sid: string) {
    const prev = this.bySid.get(sid);
    if (!prev) return;
    const prevNick = norm(prev.nickname);
    if (prevNick) {
      const owner = this.nicknameToSid.get(prevNick);
      if (owner === sid) this.nicknameToSid.delete(prevNick);
    }
    this.bySid.delete(sid);
  }
}

export const USERS = new UserStore();
