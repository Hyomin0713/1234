import { Job } from "./types";
import { PartyStore } from "./partyStore";

/**
 * Matchmaker: assigns a user to an open party (random-ish but good).
 * Uses sampling to keep it fast even with many parties.
 */

function now() { return Date.now(); }

function sampleFromArray<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  const used = new Set<number>();
  while (out.length < n && used.size < arr.length) {
    const i = Math.floor(Math.random() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]);
  }
  return out;
}

function scoreParty(store: PartyStore, partyId: string, userId: string, job: Job): number {
  const p = store.partiesById.get(partyId);
  if (!p) return -1e9;
  if (p.status !== "open" || !p.isOpen) return -1e9;
  if (p.members.length >= p.maxMembers) return -1e9;

  const u = store.usersById.get(userId);
  if (!u) return -1e9;

  // blacklist conflicts
  for (const mid of p.members) {
    const m = store.usersById.get(mid);
    if (!m) continue;
    if (store.isBlacklisted(u, m)) return -1e9;
  }

  // scoring
  const memberCount = p.members.length;

  // diversity bonus: prefer parties that don't already have this job
  const present = new Set<Job>();
  for (const mid of p.members) {
    const m = store.usersById.get(mid);
    if (m) present.add(m.job);
  }

  const hasSameJob = present.has(job);
  const diversityBonus = hasSameJob ? 0 : 15;

  // fill bonus: prefer fuller parties (finish faster)
  const fillBonus = memberCount * 10;

  // slight penalty if party is too new (optional)
  const ageMs = now() - p.createdAt;
  const ageBonus = Math.min(10, Math.floor(ageMs / 60_000)); // up to +10

  return fillBonus + diversityBonus + ageBonus;
}

export async function assignUserToRandomOpenParty(store: PartyStore, userId: string, job: Job, opts?: { sampleSize?: number }) {
  const sampleSize = Math.max(5, Math.min(50, opts?.sampleSize ?? 20));

  // prefer parties that "need" this job (diversity)
  const preferred = Array.from(store.openPartyIdsByJob.get(job) ?? []);
  const fallback = Array.from(store.openPartyIds);

  const candidates = preferred.length > 0
    ? sampleFromArray(preferred, sampleSize)
    : sampleFromArray(fallback, sampleSize);

  let bestPartyId: string | null = null;
  let bestScore = -1e9;

  for (const pid of candidates) {
    const s = scoreParty(store, pid, userId, job);
    if (s > bestScore) {
      bestScore = s;
      bestPartyId = pid;
    }
  }

  if (!bestPartyId || bestScore < -1e8) {
    return { ok: false as const, reason: "NO_PARTY_FOUND" as const };
  }

  // lock & join to avoid overfill
  const result = await store.withPartyLock(bestPartyId, async () => {
    const joined = store.joinParty(bestPartyId!, userId, job);
    return joined;
  });

  if (!result) return { ok: false as const, reason: "LOCKED_TRY_AGAIN" as const };
  if (!result.ok) return { ok: false as const, reason: result.reason };

  return { ok: true as const, party: result.party };
}
