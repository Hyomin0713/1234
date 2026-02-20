import { Server, Socket } from "socket.io";
import { PartyStore } from "./partyStore";
import { assignUserToRandomOpenParty } from "./matchmaker";
import { Buffs, Job } from "./types";

/**
 * Socket event handlers for:
 * - party:create / party:join / party:leave / party:setOpen / party:updateBuffs
 * - match:join (random) / match:leave
 * - heartbeat / party:reconnect
 */

function safeJob(x: any): Job | null {
  return (x === "warrior" || x === "thief" || x === "archer" || x === "mage") ? x : null;
}

function coerceBuffs(b: any): Partial<Buffs> {
  const out: Partial<Buffs> = {};
  if (b && typeof b === "object") {
    if (typeof b.simbi === "number") out.simbi = Math.max(0, Math.floor(b.simbi));
    if (typeof b.ppungbi === "number") out.ppungbi = Math.max(0, Math.floor(b.ppungbi));
    if (typeof b.shopbi === "number") out.shopbi = Math.max(0, Math.floor(b.shopbi));
  }
  return out;
}

function broadcastPartyState(io: Server, store: PartyStore, partyId: string) {
  const state = store.toPartyState(partyId);
  if (!state) return;
  // broadcast to all party members by their sockets
  for (const m of state.members) {
    const sid = store.socketsByUserId.get(m.id);
    if (sid) io.to(sid).emit("party:state", state);
  }
}

export function registerQueueSocketHandlers(io: Server, socket: Socket, store: PartyStore) {
  // You can attach auth here: e.g. socket.data.userId = ...
  // For MVP, client must send userId on events.

  socket.on("heartbeat", (payload: { userId: string; partyId?: string }) => {
    if (!payload?.userId) return;
    store.touchUser(payload.userId);
    store.setUserSocket(payload.userId, socket.id);

    if (payload.partyId) {
      const p = store.getParty(payload.partyId);
      if (p) {
        // extend TTL on heartbeat from any member
        p.expiresAt = Date.now() + Number(process.env.PARTY_TTL_MINUTES ?? 30) * 60_000;
        p.updatedAt = Date.now();
        store.reindexParty(p);
      }
    }
  });

  socket.on("party:create", (payload: { leaderId: string; job: Job; isOpen?: boolean }) => {
    const job = safeJob(payload?.job);
    if (!payload?.leaderId || !job) return;

    store.setUserSocket(payload.leaderId, socket.id);

    const party = store.createParty(payload.leaderId, job, { isOpen: payload.isOpen ?? true, maxMembers: 6 });
    socket.emit("party:created", { partyId: party.id });
    broadcastPartyState(io, store, party.id);
  });

  socket.on("party:join", async (payload: { partyId: string; userId: string; job: Job }) => {
    const job = safeJob(payload?.job);
    if (!payload?.partyId || !payload?.userId || !job) return;

    store.setUserSocket(payload.userId, socket.id);

    const partyId = payload.partyId;
    const joined = await store.withPartyLock(partyId, async () => store.joinParty(partyId, payload.userId, job));
    if (!joined) {
      socket.emit("party:joinResult", { ok: false, reason: "LOCKED_TRY_AGAIN" });
      return;
    }
    if (!joined.ok) {
      socket.emit("party:joinResult", { ok: false, reason: joined.reason });
      return;
    }

    socket.emit("party:joinResult", { ok: true, partyId });
    broadcastPartyState(io, store, partyId);

    // if party became full and is matched without channel yet, you can assign a channel here
    const p = store.getParty(partyId);
    if (p && p.members.length >= p.maxMembers && p.status === "matched" && !p.channelId) {
      // optional: auto assign channel
      const channelId = `x-${Math.floor(100 + Math.random() * 900)}`;
      store.assignChannel(partyId, channelId);
      io.to(socket.id).emit("match:found", { partyId, channelId });
      broadcastPartyState(io, store, partyId);
    }
  });

  socket.on("party:leave", async (payload: { partyId: string; userId: string }) => {
    if (!payload?.partyId || !payload?.userId) return;
    const p = await store.withPartyLock(payload.partyId, async () => store.leaveParty(payload.partyId, payload.userId));
    socket.emit("party:left", { ok: true });
    if (p) broadcastPartyState(io, store, payload.partyId);
  });

  socket.on("party:setOpen", (payload: { partyId: string; leaderId: string; isOpen: boolean }) => {
    if (!payload?.partyId || typeof payload.isOpen !== "boolean") return;
    const p = store.getParty(payload.partyId);
    if (!p) return;
    if (p.leaderId !== payload.leaderId) {
      socket.emit("party:setOpenResult", { ok: false, reason: "NOT_LEADER" });
      return;
    }
    store.setPartyOpen(payload.partyId, payload.isOpen);
    socket.emit("party:setOpenResult", { ok: true });
    broadcastPartyState(io, store, payload.partyId);
  });

  socket.on("party:updateBuffs", (payload: { partyId: string; userId: string; buffs: Partial<Buffs> }) => {
    if (!payload?.partyId || !payload?.userId) return;
    // allow any member to update (or restrict to leader if you want)
    const p = store.getParty(payload.partyId);
    if (!p) return;
    if (!p.members.includes(payload.userId)) {
      socket.emit("party:updateBuffsResult", { ok: false, reason: "NOT_MEMBER" });
      return;
    }

    store.updateBuffs(payload.partyId, coerceBuffs(payload.buffs));
    socket.emit("party:updateBuffsResult", { ok: true });
    broadcastPartyState(io, store, payload.partyId);
  });

  // Random match: user wants to "just join any open party"
  socket.on("match:join", async (payload: { userId: string; job: Job }) => {
    const job = safeJob(payload?.job);
    if (!payload?.userId || !job) return;

    store.setUserSocket(payload.userId, socket.id);
    store.upsertUser(payload.userId, job, store.usersById.get(payload.userId)?.blacklist ?? []);

    const assigned = await assignUserToRandomOpenParty(store, payload.userId, job, { sampleSize: 20 });
    if (!assigned.ok) {
      socket.emit("match:assigned", { ok: false, reason: assigned.reason });
      return;
    }

    socket.emit("match:assigned", { ok: true, partyId: assigned.party.id });
    broadcastPartyState(io, store, assigned.party.id);

    // auto channel assignment when full
    const p = store.getParty(assigned.party.id);
    if (p && p.members.length >= p.maxMembers && p.status === "matched" && !p.channelId) {
      const channelId = `x-${Math.floor(100 + Math.random() * 900)}`;
      store.assignChannel(p.id, channelId);
      io.to(socket.id).emit("match:found", { partyId: p.id, channelId });
      broadcastPartyState(io, store, p.id);
    }
  });

  socket.on("party:reconnect", (payload: { userId: string; partyId: string }) => {
    if (!payload?.userId || !payload?.partyId) return;
    store.setUserSocket(payload.userId, socket.id);

    const p = store.getParty(payload.partyId);
    if (!p) {
      socket.emit("party:reconnectResult", { ok: false, reason: "PARTY_NOT_FOUND" });
      return;
    }
    if (!p.members.includes(payload.userId)) {
      socket.emit("party:reconnectResult", { ok: false, reason: "NOT_MEMBER" });
      return;
    }
    socket.emit("party:reconnectResult", { ok: true });
    broadcastPartyState(io, store, payload.partyId);
  });

  socket.on("disconnect", () => {
    // We don't know userId here unless you store it in socket.data.
    // For MVP, rely on heartbeat cleanup rather than disconnect.
  });
}
