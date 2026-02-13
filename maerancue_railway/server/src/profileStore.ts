export type Profile = {
  userId: string;
  displayName: string;
  updatedAt: number;
};

const profiles = new Map<string, Profile>();

export const PROFILES = {
  get(userId: string): Profile | null {
    return profiles.get(userId) ?? null;
  },
  upsert(userId: string, displayName: string): Profile {
    const p: Profile = { userId, displayName, updatedAt: Date.now() };
    profiles.set(userId, p);
    return p;
  }
};
