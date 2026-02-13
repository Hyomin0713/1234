function obj(fn) {
    return {
        parse(v) {
            return fn(v);
        }
    };
}
export const createPartySchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    const title = String(v.title ?? "").trim();
    if (!title)
        throw new Error("TITLE_REQUIRED");
    const lockPassword = v.lockPassword == null ? null : String(v.lockPassword);
    return { title, lockPassword };
});
export const joinPartySchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    const partyId = String(v.partyId ?? "").trim();
    if (!partyId)
        throw new Error("PARTY_ID_REQUIRED");
    const lockPassword = v.lockPassword == null ? null : String(v.lockPassword);
    return { partyId, lockPassword };
});
export const rejoinSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    const partyId = String(v.partyId ?? "").trim();
    if (!partyId)
        throw new Error("PARTY_ID_REQUIRED");
    return { partyId };
});
export const buffsSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    const partyId = String(v.partyId ?? "").trim();
    const b = v.buffs ?? {};
    const simbi = Number(b.simbi ?? 0);
    const ppeongbi = Number(b.ppeongbi ?? 0);
    const syapbi = Number(b.syapbi ?? 0);
    return { partyId, buffs: { simbi, ppeongbi, syapbi } };
});
export const updateMemberSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    return {
        partyId: String(v.partyId ?? "").trim(),
        memberId: String(v.memberId ?? "").trim(),
        displayName: String(v.displayName ?? "").trim()
    };
});
export const updateTitleSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    return { partyId: String(v.partyId ?? "").trim(), title: String(v.title ?? "").trim() };
});
export const kickSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    return { partyId: String(v.partyId ?? "").trim(), userId: String(v.userId ?? "").trim() };
});
export const transferOwnerSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    return { partyId: String(v.partyId ?? "").trim(), newOwnerId: String(v.newOwnerId ?? "").trim() };
});
export const lockSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    return {
        partyId: String(v.partyId ?? "").trim(),
        isLocked: Boolean(v.isLocked),
        lockPassword: v.lockPassword == null ? null : String(v.lockPassword)
    };
});
export const profileSchema = obj((v) => {
    if (!v || typeof v !== "object")
        throw new Error("INVALID_BODY");
    const displayName = String(v.displayName ?? "").trim();
    if (!displayName)
        throw new Error("DISPLAY_NAME_REQUIRED");
    return { displayName };
});
