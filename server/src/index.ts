import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";

// Optional .env loader (local dev)
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

// ✅ one-domain deployment: ORIGIN=PUBLIC_URL (Railway) or your custom domain
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


// In a single-domain setup, CORS isn't strictly needed, but keeping it helps local dev.
app.use(
  cors({
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  })
);
app.use(express.json());

// lightweight rate limiter for OAuth callback
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

function extractSessionId(req: express.Request): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies["ml_session"];
  if (fromCookie) return fromCookie;
  // Fallback for rare cases where the cookie isn't persisted after OAuth redirect.
  // The client may send the session via a header extracted from URL hash.
  const fromHeader = (req.headers["x-ml-session"] as string | undefined) ?? undefined;
  if (fromHeader && typeof fromHeader === "string") return fromHeader;
  return undefined;
}

function setSessionCookie(res: express.Response, sessionId: string) {
  res.setHeader(
    "Set-Cookie",
    cookieSerialize("ml_session", sessionId, {
      httpOnly: true,
      secure: /^https:\/\//i.test(PUBLIC_URL),
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

/** ---------------- Discord OAuth ---------------- */
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

    // Primary: persist cookie for same-domain deployment.
    setSessionCookie(res, s.sessionId);

    // Fallback: also pass sid via URL hash so the client can recover even if
    // the browser did not persist the cookie after the OAuth redirect.
    // (hash is not sent as Referer / request path to servers)
    res.redirect(`/#sid=${encodeURIComponent(s.sessionId)}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});

/** ---------------- Auth APIs ---------------- */

// --- profile APIs ---
// NOTE: we intentionally avoid Express "middleware" style auth here.
// This repo uses a cookie session helper (requireAuth) that returns the user,
// so we call it inside each handler to keep types + control flow simple.
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
  // Refresh cookie (and recover if auth came from x-ml-session header).
  setSessionCookie(res, auth.sessionId);
  // return full in-memory profile used by queue/blacklist UI
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
      secure: /^https:\/\//i.test(PUBLIC_URL),
      sameSite: "lax",
      path: "/",
      maxAge: 0
    })
  );
  res.json({ ok: true });
});

/** ---------------- Profile ---------------- */
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

/** ---------------- Party APIs ---------------- */
app.get("/api/parties", (_req, res) => res.json({ parties: STORE.listParties() }));

app.post("/api/party", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = createPartySchema.parse(req.body);
    const party = STORE.createParty({
      title: body.title,
      ownerId: auth.user.id,
      ownerName: auth.user.global_name ?? auth.user.username,
      lockPassword: body.lockPassword ?? null
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
    const party = STORE.joinParty({
      partyId: body.partyId,
      userId: auth.user.id,
      name: auth.user.global_name ?? auth.user.username,
      lockPassword: body.lockPassword ?? null
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
    const party = STORE.rejoin({ partyId: body.partyId, userId: auth.user.id, name: auth.user.global_name ?? auth.user.username });
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

/** ---------------- Socket.IO ---------------- */
// socket ↔ user mapping (for queue cleanup on disconnect etc.)
const socketToUserId = new Map<string, string>();

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
    socket.join(partyId);
    const party = STORE.getParty(partyId);
    if (party) socket.emit("partyUpdated", { party });
  });

// --- queue matchmaking ---
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
  });

  socket.on("queue:updateProfile", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    socketToUserId.set(socket.id, u.id);
    
    // store profile without joining a ground yet (huntingGroundId required for searching; we keep state via join)
    // We'll just keep it in memory on the client; server will accept latest values when joining.
  });

  socket.on("queue:join", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    const huntingGroundId = String(p?.huntingGroundId ?? "").trim();
    if (!huntingGroundId) return;

    socketToUserId.set(socket.id, u.id);
    
    const displayName = (u.global_name ?? u.username) || u.username;
    USERS.upsert(u.id, { displayName, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0), blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [] });

    const up = QUEUE.upsert(socket.id, huntingGroundId, {
      userId: u.id,
      displayName,
      level: Number(p?.level ?? 1),
      job: p?.job ?? "전사",
      power: Number(p?.power ?? 0),
      blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [],
    } as any);

    if (!up.ok) return;

    socket.emit("queue:status", { state: "searching" });

    const matched = QUEUE.tryMatch(huntingGroundId, resolveNameToId);
    if (matched.ok) {
      // Auto-create party for the matched pair (single-domain cookie session; party lives in memory)
      try {
        const leaderId = matched.leaderId;
        const leaderEntry = matched.a.userId === leaderId ? matched.a : matched.b;
        const otherEntry = leaderEntry === matched.a ? matched.b : matched.a;

        // PartyStore.createParty returns a Party object. Keep payload minimal so TS stays strict.
        const party = STORE.createParty({
          ownerId: leaderId,
          ownerName: leaderEntry.displayName,
          title: `사냥터 ${huntingGroundId}`,
          lockPassword: null
        });
        const partyId = party.id;

        STORE.joinParty({ partyId, userId: otherEntry.userId, name: otherEntry.displayName });

        // remember party id for both queue entries
        QUEUE.setPartyForMatch(matched.matchId, partyId);

        // join socket rooms for realtime party updates
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
  });

  socket.on("queue:leave", () => {
    const u = requireSocketUser(socket);
    const uid = u?.id ?? socketToUserId.get(socket.id);
    if (uid) {
      QUEUE.leave(uid);
      socketToUserId.delete(socket.id);
    }
    socket.emit("queue:status", { state: "idle" });
  });

  socket.on("disconnect", () => {
    const uid = socketToUserId.get(socket.id);
    if (uid) {
      QUEUE.leave(uid);
      socketToUserId.delete(socket.id);
    }
  });

});
// Serve static web build (Next export output)
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