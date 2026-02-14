import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";


function loadDotEnv() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.error("[env] failed to load .env:", e);
  }
}
loadDotEnv();

import { STORE } from "./store.js";
import { PROFILES } from "./profileStore.js";
import { QUEUE } from "./queueStore.js";
import { USERS } from "./userStore.js";
import {
  createPartySchema,
  joinPartySchema,
  rejoinSchema,
  buffsSchema,
  updateMemberSchema,
  updateTitleSchema,
  kickSchema,
  transferOwnerSchema,
  lockSchema,
  profileSchema
} from "./validators.js";
import { cleanupSessions, cookieSerialize, deleteSession, getSession, newSession, parseCookies, type DiscordUser } from "./auth.js";

const PORT = Number(process.env.PORT ?? 8000);


const MEMBER_TTL_MS = Number(process.env.MEMBER_TTL_MS ?? 70_000); 
const PARTY_TTL_MS = Number(process.env.PARTY_TTL_MS ?? 10 * 60_000); 


const PUBLIC_URL = (process.env.PUBLIC_URL ?? process.env.ORIGIN ?? `http://localhost:${PORT}`).trim();
const ORIGIN_RAW = (process.env.ORIGIN ?? PUBLIC_URL).trim();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
const DISCORD_REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI ?? `${PUBLIC_URL.replace(/\/$/, "")}/auth/discord/callback`).trim();

function parseOrigins(raw: string): string[] | "*" {
  if (raw === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ORIGINS = parseOrigins(ORIGIN_RAW);

const app = express();

function resolveNameToId(s: string): string | null {
  return USERS.resolveNameToId(s);
}



app.use(
  cors({
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  })
);
app.use(express.json());


function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || rec.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > opts.max) return res.status(429).json({ error: "RATE_LIMITED" });
    return next();
  };
}

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  }
});

let broadcastTimer: NodeJS.Timeout | null = null;
function broadcastParties() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    io.emit("partiesUpdated", { parties: STORE.listParties() });
  }, 150);
}
function broadcastParty(partyId: string) {
  const party = STORE.getParty(partyId);
  if (party) io.to(partyId).emit("partyUpdated", { party });
  broadcastParties();
}

let queueCountTimer: NodeJS.Timeout | null = null;
function broadcastQueueCounts() {
  if (queueCountTimer) return;
  queueCountTimer = setTimeout(() => {
    queueCountTimer = null;
    io.emit("queue:counts", { counts: QUEUE.getCountsByGround(), avgWaitMs: QUEUE.getAvgWaitByGround() });
  }, 150);
}

function extractSessionId(req: express.Request): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies["ml_session"];
  if (fromCookie) return fromCookie;


  const fromHeader = (req.headers["x-ml-session"] as string | undefined) ?? undefined;
  if (fromHeader && typeof fromHeader === "string") return fromHeader;
  return undefined;
}

function setSessionCookie(res: express.Response, sessionId: string) {
  res.setHeader(
    "Set-Cookie",
    cookieSerialize("ml_session", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7
    })
  );
}

function requireAuth(req: express.Request, res: express.Response): { user: DiscordUser; sessionId: string } | null {
  const sid = extractSessionId(req);
  const s = getSession(sid);
  if (!s) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
  return { user: s.user, sessionId: s.sessionId };
}

app.get("/health", (_req, res) => res.json({ ok: true, now: Date.now() }));


app.get("/auth/discord", (_req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).send("DISCORD_CLIENT_ID not set");
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify"
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  try {
    const code = String(req.query.code ?? "");
    if (!code) return res.status(400).send("Missing code");

    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!tokenRes.ok) return res.status(500).send("Token exchange failed");

    const tokenJson: any = await tokenRes.json();
    const accessToken = tokenJson.access_token as string;

    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!meRes.ok) return res.status(500).send("Fetch user failed");

    const me: any = await meRes.json();

    const user: DiscordUser = {
      id: String(me.id),
      username: String(me.username),
      global_name: me.global_name ?? null,
      avatar: me.avatar ?? null
    };

    const s = newSession(user);


    setSessionCookie(res, s.sessionId);




    res.redirect(`/#sid=${encodeURIComponent(s.sessionId)}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});







app.get("/api/profile", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const u = auth.user;
  const displayName = (u.global_name ?? u.username) || u.username;
  const saved = USERS.upsert(u.id, { displayName })!;
  return res.json({ ok: true, profile: saved });
});

app.put("/api/profile", express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const u = auth.user;
  const displayName = (u.global_name ?? u.username) || u.username;
  const body = req.body ?? {};
  const next = USERS.upsert(u.id, {
    displayName,
    level: body.level,
    job: body.job,
    power: body.power,
    blacklist: body.blacklist,
  });
  return res.json({ ok: true, profile: next });
});

app.get("/api/queue/status", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const cur = QUEUE.get(auth.user.id);
  if (!cur) return res.json({ ok: true, status: { state: "idle" } });
  return res.json({ ok: true, status: { state: cur.state, channel: cur.channel, huntingGroundId: cur.huntingGroundId } });
});


app.get("/api/me", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  setSessionCookie(res, auth.sessionId);

  res.json({ user: auth.user, profile: USERS.get(auth.user.id) ?? null });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies["ml_session"];
  if (sid) deleteSession(sid);
  res.setHeader(
    "Set-Cookie",
    cookieSerialize("ml_session", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0
    })
  );
  res.json({ ok: true });
});


app.post("/api/profile", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = profileSchema.parse(req.body);
    const p = PROFILES.upsert(auth.user.id, body.displayName);
    res.json({ profile: p });
  } catch {
    res.status(400).json({ error: "INVALID_BODY" });
  }
});


app.get("/api/parties", (_req, res) => res.json({ parties: STORE.listParties() }));

app.post("/api/party", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = createPartySchema.parse(req.body);
    const up = USERS.get(auth.user.id);
    const party = STORE.createParty({
      title: body.title,
      ownerId: auth.user.id,
      ownerName: auth.user.global_name ?? auth.user.username,
      ownerLevel: up?.level ?? 1,
      ownerJob: (up?.job as any) ?? "전사",
      ownerPower: up?.power ?? 0,
      lockPassword: body.lockPassword ?? null,
      groundId: body.groundId ?? null,
      groundName: body.groundName ?? null
    });
    broadcastParties();
    res.json({ party });
  } catch {
    res.status(400).json({ error: "INVALID_BODY" });
  }
});

app.post("/api/party/join", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = joinPartySchema.parse(req.body);
    const up = USERS.get(auth.user.id);
    const party = STORE.joinParty({
      partyId: body.partyId,
      userId: auth.user.id,
      name: auth.user.global_name ?? auth.user.username,
      level: up?.level ?? 1,
      job: (up?.job as any) ?? "전사",
      power: up?.power ?? 0,
      lockPassword: body.lockPassword ?? null,
      groundId: body.groundId ?? null,
      groundName: body.groundName ?? null
    });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "JOIN_FAILED" });
  }
});

app.post("/api/party/rejoin", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = rejoinSchema.parse(req.body);
    const up = USERS.get(auth.user.id);
    const party = STORE.rejoin({
      partyId: body.partyId,
      userId: auth.user.id,
      name: auth.user.global_name ?? auth.user.username,
      level: up?.level ?? 1,
      job: (up?.job as any) ?? "전사",
      power: up?.power ?? 0,
    });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "REJOIN_FAILED" });
  }
});

app.post("/api/party/leave", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const partyId = String(req.body?.partyId ?? "");
  if (!partyId) return res.status(400).json({ error: "MISSING_PARTY_ID" });
  STORE.leaveParty({ partyId, userId: auth.user.id });
  broadcastParty(partyId);
  res.json({ ok: true });
});

app.post("/api/party/title", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = updateTitleSchema.parse(req.body);
    const party = STORE.updateTitle({ partyId: body.partyId, userId: auth.user.id, title: body.title });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/member", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = updateMemberSchema.parse(req.body);
    const party = STORE.updateMemberName({ partyId: body.partyId, userId: auth.user.id, memberId: body.memberId, displayName: body.displayName });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/buffs", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = buffsSchema.parse(req.body);
    const party = STORE.updateBuffs({ partyId: body.partyId, userId: auth.user.id, buffs: body.buffs });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/lock", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = lockSchema.parse(req.body);
    const party = STORE.setLock({ partyId: body.partyId, userId: auth.user.id, isLocked: body.isLocked, lockPassword: body.lockPassword });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/kick", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = kickSchema.parse(req.body);
    const party = STORE.kick({ partyId: body.partyId, userId: auth.user.id, targetUserId: body.targetUserId });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "KICK_FAILED" });
  }
});

app.post("/api/party/transfer", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = transferOwnerSchema.parse(req.body);
    const party = STORE.transferOwner({ partyId: body.partyId, userId: auth.user.id, newOwnerId: body.newOwnerId });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "TRANSFER_FAILED" });
  }
});



const socketToUserId = new Map<string, string>();

function cleanupPartyMembership(userId: string) {
  try {
    const cur = QUEUE.get(userId);
    const pid = cur?.partyId;
    if (!pid) return;
    const before = STORE.getParty(pid);
    const out = STORE.leaveParty({ partyId: pid, userId });




    const p = out ?? STORE.getParty(pid);
    const wasAuto = !!before?.title?.startsWith("사냥터 ");
    if (wasAuto && p && p.members.length < 2) {
      STORE.deleteParty(pid);
      io.to(pid).emit("partyDeleted", { partyId: pid });
      broadcastParties();
      return;
    }

    if (!p) {
      io.to(pid).emit("partyDeleted", { partyId: pid });
      broadcastParties();
      return;
    }
    broadcastParty(pid);
  } catch {

  }
}

function requireSocketUser(socket: import("socket.io").Socket): DiscordUser | null {
  try {
    const cookieHeader = (socket.handshake.headers?.cookie ?? "") as string;
    const cookies = parseCookies(cookieHeader);
    const sid = cookies["ml_session"];
    const s = getSession(sid);
    return s?.user ?? null;
  } catch {
    return null;
  }
}
io.on("connection", (socket) => {
  socket.on("joinPartyRoom", ({ partyId }: { partyId: string }) => {
    if (!partyId) return;

    const party = STORE.getParty(partyId);
    if (!party) {

      socket.emit("partyDeleted", { partyId });
      return;
    }

    socket.join(partyId);

    const u = requireSocketUser(socket);
    if (u) {
      STORE.touchMember(partyId, u.id);
    }

    socket.emit("partyUpdated", { party });
  });


  socket.on("party:heartbeat", ({ partyId }: { partyId: string }) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    if (!partyId) return;
    const p = STORE.touchMember(String(partyId), u.id);
    if (p) {

      broadcastParty(String(partyId));
    }
  });


  function ensureLoggedIn() {
    const u = requireSocketUser(socket);
    if (!u) {
      socket.emit("queue:status", { state: "idle", message: "로그인이 필요합니다." });
      return null;
    }
    return u;
  }

  function emitQueueStatus(uid: string, socketId?: string) {
    const cur = QUEUE.get(uid);
    const emitter = socketId ? io.to(socketId) : socket;

    if (!cur || cur.state === "idle") {
      (emitter as any).emit("queue:status", { state: "idle" });
      return;
    }
    if (cur.state === "searching") {
      (emitter as any).emit("queue:status", { state: "searching" });
      return;
    }
    const isLeader = !!cur.leaderId && cur.leaderId === uid;
    (emitter as any).emit("queue:status", {
      state: "matched",
      channel: cur.channel ?? "",
      isLeader,
      channelReady: !!cur.channel,
      partyId: cur.partyId ?? "",
    });
  }

  socket.on("queue:hello", async (_p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    socketToUserId.set(socket.id, u.id);

    emitQueueStatus(u.id);


    socket.emit("queue:counts", { counts: QUEUE.getCountsByGround(), avgWaitMs: QUEUE.getAvgWaitByGround() });
  });

  socket.on("queue:updateProfile", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    socketToUserId.set(socket.id, u.id);

    const displayName = String(p?.displayName ?? (u.global_name ?? u.username) ?? u.username).trim() || (u.global_name ?? u.username);
    const level = Number(p?.level ?? 1);
    const job = p?.job ?? "전사";
    const power = Number(p?.power ?? 0);


    USERS.upsert(u.id, { displayName, level, job, power });


    const cur = QUEUE.get(u.id);
    if (cur && cur.state !== "idle") {
      cur.displayName = displayName;
      cur.level = Math.max(1, Math.min(300, Math.floor(level) || 1));
      cur.job = job;
      cur.power = Math.max(0, Math.min(9_999_999, Math.floor(power) || 0));
      cur.updatedAt = Date.now();
    }


    const touched = STORE.updateMemberProfile(u.id, { name: displayName, level, job, power });
    for (const pid of touched) broadcastParty(pid);
  });

  socket.on("queue:join", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    const huntingGroundId = String(p?.huntingGroundId ?? "").trim();
    if (!huntingGroundId) return;

    socketToUserId.set(socket.id, u.id);

    const displayName = (u.global_name ?? u.username) || u.username;
    USERS.upsert(u.id, { displayName, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0), blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [] });

    const requestedPartyId = String(p?.partyId ?? "").trim();
    let partyId: string | undefined = undefined;
    if (requestedPartyId) {
      const party = STORE.getParty(requestedPartyId);
      if (party && party.ownerId === u.id) partyId = party.id;
    }

    const up = QUEUE.upsert(socket.id, huntingGroundId, {
      userId: u.id,
      displayName,
      level: Number(p?.level ?? 1),
      job: p?.job ?? "전사",
      power: Number(p?.power ?? 0),
      blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [],
      partyId,
    } as any);

    if (!up.ok) return;

    socket.emit("queue:status", { state: "searching" });

    broadcastQueueCounts();

    const matched = QUEUE.tryMatch(huntingGroundId, resolveNameToId);
    if (matched.ok) {

      try {
        const leaderId = matched.leaderId;
        const leaderEntry = matched.a.userId === leaderId ? matched.a : matched.b;
        const otherEntry = leaderEntry === matched.a ? matched.b : matched.a;


        let partyId = String((leaderEntry as any).partyId ?? "").trim();
        let party = partyId ? STORE.getParty(partyId) : null;
        if (!party || party.ownerId !== leaderId || (party.members?.length ?? 0) >= 6) {
          party = STORE.createParty({
            ownerId: leaderId,
            ownerName: leaderEntry.displayName,
            ownerLevel: Number(leaderEntry.level ?? 1),
            ownerJob: (leaderEntry.job as any) ?? "전사",
            ownerPower: Number(leaderEntry.power ?? 0),
            title: `사냥터 ${huntingGroundId}`,
            groundId: huntingGroundId,
            groundName: `사냥터 ${huntingGroundId}`,
            lockPassword: null
          });
          partyId = party.id;
        }

        STORE.joinParty({
          partyId,
          userId: otherEntry.userId,
          name: otherEntry.displayName,
          level: Number(otherEntry.level ?? 1),
          job: (otherEntry.job as any) ?? "전사",
          power: Number(otherEntry.power ?? 0),
        });


        QUEUE.setPartyForMatch(matched.matchId, partyId);


        const sa = io.sockets.sockets.get(matched.a.socketId);
        const sb = io.sockets.sockets.get(matched.b.socketId);
        sa?.join(partyId);
        sb?.join(partyId);
        broadcastParty(partyId);
      } catch (e) {
        console.error("[queue] failed to auto-create party", e);
      }

      emitQueueStatus(matched.a.userId, matched.a.socketId);
      emitQueueStatus(matched.b.userId, matched.b.socketId);

      broadcastQueueCounts();
    }
  });

  socket.on("queue:setChannel", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    const letter = String(p?.letter ?? "").toUpperCase().trim();
    const num = String(p?.num ?? "").trim().padStart(3, "0");
    const channel = `${letter}-${num}`;
    const r = QUEUE.setChannelByLeader(u.id, channel);
    if (!r.ok) {
      socket.emit("queue:toast", { type: "error", message: "채널 설정 실패" });
      emitQueueStatus(u.id);
      return;
    }
    for (const m of r.members) {
      emitQueueStatus(m.userId, m.socketId);
    }

    broadcastQueueCounts();
  });

  socket.on("queue:leave", () => {
    const u = requireSocketUser(socket);
    const uid = u?.id ?? socketToUserId.get(socket.id);
    if (uid) {
      cleanupPartyMembership(uid);
      QUEUE.leave(uid);
      socketToUserId.delete(socket.id);
    }
    socket.emit("queue:status", { state: "idle" });

    broadcastQueueCounts();
  });

  socket.on("disconnect", () => {
    const uid = socketToUserId.get(socket.id);
    if (uid) {
      cleanupPartyMembership(uid);
      QUEUE.leave(uid);
      socketToUserId.delete(socket.id);
    }

    broadcastQueueCounts();
  });

});


setInterval(() => {
  try {
    const changedPartyIds = STORE.sweepStaleMembers({ memberTtlMs: MEMBER_TTL_MS, partyTtlMs: PARTY_TTL_MS });
    if (changedPartyIds.length) {

      for (const pid of changedPartyIds) {
        if (!STORE.getParty(pid)) {
          io.to(pid).emit("partyDeleted", { partyId: pid });
        }
      }
      broadcastParties();
    }


    const cleaned = QUEUE.cleanupDanglingParties((pid) => !!STORE.getParty(pid));
    if (cleaned.length) {
      for (const e of cleaned) {

        io.to(e.socketId).emit("queue:status", { state: "idle" });
      }
      broadcastQueueCounts();
    }
  } catch {

  }
}, 15_000).unref();

const webOut = path.resolve(process.cwd(), "../web/out");
if (fs.existsSync(webOut)) {
  app.use(express.static(webOut));
  app.get("*", (_req, res) => res.sendFile(path.join(webOut, "index.html")));
} else {
  console.warn("[web] ../web/out not found. Did you run `npm run build` at repo root?");
}

setInterval(() => cleanupSessions(), 60_000).unref();

server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
  console.log(`[server] PUBLIC_URL=${PUBLIC_URL}`);
  console.log(`[server] DISCORD_REDIRECT_URI=${DISCORD_REDIRECT_URI}`);
});