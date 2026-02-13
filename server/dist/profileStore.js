const profiles = new Map();
export const PROFILES = {
    get(userId) {
        return profiles.get(userId) ?? null;
    },
    upsert(userId, displayName) {
        const p = { userId, displayName, updatedAt: Date.now() };
        profiles.set(userId, p);
        return p;
    }
};
