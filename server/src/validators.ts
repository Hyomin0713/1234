type Parser<T> = { parse: (v: any) => T };

function obj<T>(fn: (v: any) => T): Parser<T> {
  return {
    parse(v: any) {
      return fn(v);
    }
  };
}

export const createPartySchema = obj<{ title: string; lockPassword?: string | null }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  const title = String(v.title ?? "").trim();
  if (!title) throw new Error("TITLE_REQUIRED");
  const lockPassword = v.lockPassword == null ? null : String(v.lockPassword);
  return { title, lockPassword };
});

export const joinPartySchema = obj<{ partyId: string; lockPassword?: string | null }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  const partyId = String(v.partyId ?? "").trim();
  if (!partyId) throw new Error("PARTY_ID_REQUIRED");
  const lockPassword = v.lockPassword == null ? null : String(v.lockPassword);
  return { partyId, lockPassword };
});

export const rejoinSchema = obj<{ partyId: string }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  const partyId = String(v.partyId ?? "").trim();
  if (!partyId) throw new Error("PARTY_ID_REQUIRED");
  return { partyId };
});

export const buffsSchema = obj<{ partyId: string; buffs: { simbi: number; ppeongbi: number; syapbi: number } }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  const partyId = String(v.partyId ?? "").trim();
  const b = v.buffs ?? {};
  const simbi = Number(b.simbi ?? 0);
  const ppeongbi = Number(b.ppeongbi ?? 0);
  const syapbi = Number(b.syapbi ?? 0);
  return { partyId, buffs: { simbi, ppeongbi, syapbi } };
});

export const updateMemberSchema = obj<{ partyId: string; memberId: string; displayName: string }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  return {
    partyId: String(v.partyId ?? "").trim(),
    memberId: String(v.memberId ?? "").trim(),
    displayName: String(v.displayName ?? "").trim()
  };
});

export const updateTitleSchema = obj<{ partyId: string; title: string }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  return { partyId: String(v.partyId ?? "").trim(), title: String(v.title ?? "").trim() };
});

export const kickSchema = obj<{ partyId: string; userId: string }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  return { partyId: String(v.partyId ?? "").trim(), userId: String(v.userId ?? "").trim() };
});

export const transferOwnerSchema = obj<{ partyId: string; newOwnerId: string }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  return { partyId: String(v.partyId ?? "").trim(), newOwnerId: String(v.newOwnerId ?? "").trim() };
});

export const lockSchema = obj<{ partyId: string; isLocked: boolean; lockPassword?: string | null }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  return {
    partyId: String(v.partyId ?? "").trim(),
    isLocked: Boolean(v.isLocked),
    lockPassword: v.lockPassword == null ? null : String(v.lockPassword)
  };
});

export const profileSchema = obj<{ displayName: string }>((v) => {
  if (!v || typeof v !== "object") throw new Error("INVALID_BODY");
  const displayName = String(v.displayName ?? "").trim();
  if (!displayName) throw new Error("DISPLAY_NAME_REQUIRED");
  return { displayName };
});
