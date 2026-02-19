import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";

import { STORE } from "./store.js";
import { QUEUE } from "./queueStore.js";
import { USERS } from "./userStore.js";
import {
  cleanupSessions,
  cookieSerialize,
  deleteSession,
  getSession,
  newSession,
  parseCookies,
  type DiscordUser,
} from "./auth.js";

/**
 * NOTE
 * - This file is meant to be overwritten as-is.
 * - Fixes:
 *   1) Add /api/me, /api/logout so the web can actually detect login after Discord OAuth.
 *   2) Add socket "queue:updateProfile" handler so nickname/profile gets stored server-side.
 *   3) Keep existing behavior: cookie + #sid fallback via x-ml-session header.
 */

// ---- env loading (optional .env for local) ----
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
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.error("[env] failed to load .env:", e);
  }
}
loadDotEnv();

// ---- config ----
const PORT = Number(process.env.PORT ?? 8000);
const MEMBER_TTL_MS = Number(process.env.MEMBER_TTL_MS ?? 70_000);
const PARTY_TTL_MS = Number(process.env.PARTY_TTL_MS ?? 10 * 60_000);

const PUBLIC_URL = (process.env.PUBLIC_URL ?? process.env.ORIGIN ?? `http://localhost:${PORT}`).trim();
const ORIGIN_RAW = (process.env.ORIGIN ?? PUBLIC_URL).trim();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
const DISCORD_REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI ??
  `${PUBLIC_URL.replace(/\/$/, "")}/auth/discord/callback`).trim();

function parseOrigins(raw: string): string[] | "*" {
  if (raw === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ORIGINS = parseOrigins(ORIGIN_RAW);

// ---- app ----
const app = express();

// IMPORTANT for Railway/Render/etc. behind proxy: ensures req.ip + secure cookies behave predictably
app.set("trust proxy", 1);

app.use(
  cors({
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true,
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
  cors: { origin: ORIGINS === "*" ? true : ORIGINS, credentials: true },
});

// ---- helpers ----
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
      maxAge: 60 * 60 * 24 * 7,
    })
  );
}

function clearSessionCookie(res: express.Response) {
  // expire cookie immediately
  res.setHeader(
    "Set-Cookie",
    cookieSerialize("ml_session", "deleted", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })
  );
}

function requireAuth(
  req: express.Request,
  res: express.Response
): { user: DiscordUser; sessionId: string } | null {
  const sid = extractSessionId(req);
  const s = getSession(sid);
  if (!s) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
  return { user: s.user, sessionId: s.sessionId };
}

function extractSessionIdFromSocket(socket: any): string | undefined {
  const cookie = socket?.handshake?.headers?.cookie as string | undefined;
  const cookies = parseCookies(cookie);
  const fromCookie = cookies["ml_session"];
  if (fromCookie) return fromCookie;

  const fromHeader = (socket?.handshake?.headers?.["x-ml-session"] as string | undefined) ?? undefined;
  if (fromHeader && typeof fromHeader === "string") return fromHeader;

  return undefined;
}

const socketToUserId = new Map<string, string>();

function requireSocketUser(socket: any): DiscordUser | null {
  const sid = extractSessionIdFromSocket(socket);
  const s = getSession(sid);
  if (!s) return null;
  socketToUserId.set(socket.id, s.user.id);
  return s.user;
}

function resolveNameToId(s: string): string | null {
  return USERS.resolveNameToId(s);
}

// ---- API ----
app.get("/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

app.get("/auth/discord", (_req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).send("DISCORD_CLIENT_ID not set");
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get(
  "/auth/discord/callback",
  rateLimit({ windowMs: 60_000, max: 30 }),
  async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      if (!code) return res.status(400).send("Missing code");

      const body = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      });

      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!tokenRes.ok) return res.status(500).send("Token exchange failed");

      const tokenJson: any = await tokenRes.json();
      const accessToken = tokenJson.access_token as string;

      const meRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!meRes.ok) return res.status(500).send("Fetch user failed");

      const me: any = await meRes.json();
      const user: DiscordUser = {
        id: String(me.id),
        username: String(me.username),
        global_name: me.global_name ?? null,
        avatar: me.avatar ?? null,
      };

      const s = newSession(user);
      setSessionCookie(res, s.sessionId);

      // IMPORTANT: keep #sid fallback
      res.redirect(`/#sid=${encodeURIComponent(s.sessionId)}`);
    } catch (e) {
      console.error(e);
      res.status(500).send("OAuth error");
    }
  }
);

/**
 * ✅ Fix: web/app/page.tsx calls /api/me to determine login state.
 * Without this endpoint, it ALWAYS shows "logged out".
 */
app.get("/api/me", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  res.json({ user: auth.user, sessionId: auth.sessionId });
});

app.post("/api/logout", (req, res) => {
  const sid = extractSessionId(req);
  if (sid) deleteSession(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** keep profile endpoint for backwards compatibility */
app.get("/api/profile", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const u = auth.user;
  const cur = USERS.get(u.id);
  res.json({
    profile:
      cur ??
      ({
        userId: u.id,
        displayName: "",
        level: 1,
        job: "전사",
        power: 0,
        blacklist: [],
        updatedAt: Date.now(),
      } as any),
  });
});

// ---- socket + matching ----
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
    io.emit("queue:counts", {
      counts: QUEUE.getCountsByGround(),
      avgWaitMs: QUEUE.getAvgWaitByGround(),
    });
  }, 150);
}

function emitQueueStatus(userId: string, socketId?: string) {
  const e = QUEUE.get(userId);
  const sid = socketId ?? e?.socketId;
  if (!sid) return;

  if (!e || e.state === "idle") {
    io.to(sid).emit("queue:status", { state: "idle" });
    return;
  }
  if (e.state === "searching") {
    io.to(sid).emit("queue:status", {
      state: "searching",
      huntingGroundId: e.huntingGroundId,
      since: e.searchingSince ?? Date.now(),
      partyId: (e as any).partyId ?? null,
    });
    return;
  }
  io.to(sid).emit("queue:status", {
    state: "matched",
    matchId: e.matchId ?? null,
    leaderId: e.leaderId ?? null,
    isLeader: e.userId === e.leaderId,
    channel: e.channel ?? null,
    channelReady: Boolean(e.channel),
    partyId: (e as any).partyId ?? null,
    huntingGroundId: e.huntingGroundId,
  });
}

function cleanupPartyMembership(userId: string) {
  const uid = String(userId ?? "").trim();
  if (!uid) return;

  const parties = STORE.listParties();
  for (const ps of parties) {
    const p = STORE.getParty(ps.id);
    if (!p) continue;

    const has = (p.members ?? []).some((m: any) => m.userId === uid);
    if (!has) continue;

    const next = STORE.leaveParty({ partyId: p.id, userId: uid });
    if (!next) {
      io.to(p.id).emit("partyDeleted", { partyId: p.id });
      broadcastParties();
      continue;
    }

    // if party once reached 6, then any member leaves => pause until owner resumes
    if (next.wasFullOnce && (next.members?.length ?? 0) > 0 && (next.members?.length ?? 0) < 6) {
      next.matchingPaused = true;
      next.updatedAt = Date.now();
    }
    broadcastParty(p.id);
  }
}

io.on("connection", (socket) => {
  const ensureLoggedIn = () => {
    const u = requireSocketUser(socket);
    if (!u) {
      socket.emit("queue:toast", { type: "error", message: "로그인이 필요합니다." });
      socket.emit("queue:status", { state: "idle" });
      return null;
    }
    return u;
  };

  // ✅ Fix: allow the web to push profile after login
  socket.on("queue:updateProfile", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    // allow blacklist updates later if you decide to send it
    const patch: any = {
      displayName: String(p?.displayName ?? "").trim().slice(0, 64),
      level: Number(p?.level ?? 1),
      job: p?.job,
      power: Number(p?.power ?? 0),
    };
    if (Array.isArray(p?.blacklist)) patch.blacklist = p.blacklist;

    const next = USERS.upsert(u.id, patch);
    if (next?.displayName) {
      // tell client it's saved (optional)
      socket.emit("profile:saved", { profile: next });
    }
  });

  socket.on("queue:join", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    const meProfile = USERS.get(u.id);
    if (!meProfile?.displayName) {
      socket.emit("profile:error", { code: "NICK_REQUIRED" });
      return;
    }
    if (!USERS.isNameAvailable(u.id, meProfile.displayName)) {
      socket.emit("profile:error", { code: "NICK_TAKEN" });
      return;
    }

    const displayName = meProfile.displayName;

    let partyId: string | undefined = undefined;
    const requestedPartyId = String(p?.partyId ?? "").trim();
    if (requestedPartyId) {
      const party = STORE.getParty(requestedPartyId);
      if (party && party.ownerId === u.id) partyId = party.id;
    }

    if (partyId) {
      const party = STORE.getParty(partyId);
      if (party && party.ownerId === u.id && party.matchingPaused) {
        socket.emit("queue:toast", { type: "info", message: "파티장이 매칭을 재개해야 합니다." });
        socket.emit("queue:status", { state: "idle" });
        return;
      }
      if (party && (party.members?.length ?? 0) >= 6) {
        socket.emit("queue:toast", { type: "info", message: "파티가 가득 찼습니다." });
        socket.emit("queue:status", { state: "idle" });
        return;
      }
    }

    const huntingGroundId = String(p?.huntingGroundId ?? "octopus").trim() || "octopus";

    const up = QUEUE.upsert(socket.id, huntingGroundId, {
      userId: u.id,
      displayName,
      level: Number(meProfile.level ?? 1),
      job: meProfile.job ?? "전사",
      power: Number(meProfile.power ?? 0),
      blacklist: Array.isArray(meProfile.blacklist) ? meProfile.blacklist : [],
      partyId,
    } as any);
    if (!up.ok) return;

    socket.emit("queue:status", { state: "searching" });
    broadcastQueueCounts();

    const matched = QUEUE.tryMatch(huntingGroundId, resolveNameToId);
    if (matched.ok) {
      // keep existing auto-party behavior (leader creates party, other joins)
      try {
        const leaderId = matched.leaderId;
        const leaderEntry = matched.a.userId === leaderId ? matched.a : matched.b;
        const otherEntry = leaderEntry === matched.a ? matched.b : matched.a;

        let pid = String((leaderEntry as any).partyId ?? "").trim();
        let party = pid ? STORE.getParty(pid) : null;

        if (!party || party.ownerId !== leaderId) {
          party = STORE.createParty({
            ownerId: leaderId,
            ownerName: leaderEntry.displayName,
            ownerLevel: Number(leaderEntry.level ?? 1),
            ownerJob: (leaderEntry.job as any) ?? "전사",
            ownerPower: Number(leaderEntry.power ?? 0),
            title: `사냥터 ${huntingGroundId}`,
            groundId: huntingGroundId,
            groundName: `사냥터 ${huntingGroundId}`,
            lockPassword: null,
          });
          pid = party.id;
        }

        if ((party.members?.length ?? 0) < 6) {
          STORE.joinParty({
            partyId: pid,
            userId: otherEntry.userId,
            name: otherEntry.displayName,
            level: Number(otherEntry.level ?? 1),
            job: (otherEntry.job as any) ?? "전사",
            power: Number(otherEntry.power ?? 0),
          });
        }

        QUEUE.setPartyForMatch(matched.matchId, pid);

        const sa = io.sockets.sockets.get(matched.a.socketId);
        const sb = io.sockets.sockets.get(matched.b.socketId);
        sa?.join(pid);
        sb?.join(pid);
        broadcastParty(pid);

        const after = STORE.getParty(pid);
        if (after && (after.members?.length ?? 0) >= 6) {
          after.wasFullOnce = true;
          after.matchingPaused = false;
          QUEUE.leave(leaderId);
          emitQueueStatus(leaderId);
        }
      } catch (e) {
        console.error("[queue] failed to auto-create party", e);
      }

      emitQueueStatus(matched.a.userId, matched.a.socketId);
      emitQueueStatus(matched.b.userId, matched.b.socketId);
      broadcastQueueCounts();
    }
  });

  socket.on("party:startMatching", (p: any) => {
    const u = ensureLoggedIn();
    if (!u) return;

    const partyId = String(p?.partyId ?? "").trim();
    if (!partyId) return;

    const party = STORE.getParty(partyId);
    if (!party || party.ownerId !== u.id) return;
    if ((party.members?.length ?? 0) >= 6) return;

    party.matchingPaused = false;
    party.updatedAt = Date.now();
    broadcastParty(partyId);

    const huntingGroundId = String(p?.huntingGroundId ?? party.groundId ?? "octopus").trim() || "octopus";
    const meProfile = USERS.get(u.id);

    if (!meProfile?.displayName) {
      socket.emit("profile:error", { code: "NICK_REQUIRED" });
      return;
    }
    if (!USERS.isNameAvailable(u.id, meProfile.displayName)) {
      socket.emit("profile:error", { code: "NICK_TAKEN" });
      return;
    }

    const up = QUEUE.upsert(socket.id, huntingGroundId, {
      userId: u.id,
      displayName: meProfile.displayName,
      level: Number(meProfile.level ?? 1),
      job: meProfile.job ?? "전사",
      power: Number(meProfile.power ?? 0),
      blacklist: Array.isArray(meProfile.blacklist) ? meProfile.blacklist : [],
      partyId,
    } as any);
    if (!up.ok) return;

    socket.emit("queue:status", { state: "searching" });
    broadcastQueueCounts();
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
    for (const m of r.members) emitQueueStatus(m.userId, m.socketId);
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

// ---- sweeps / static web ----
setInterval(() => {
  try {
    const changedPartyIds = STORE.sweepStaleMembers({
      memberTtlMs: MEMBER_TTL_MS,
      partyTtlMs: PARTY_TTL_MS,
    });

    if (changedPartyIds.length) {
      for (const pid of changedPartyIds) {
        if (!STORE.getParty(pid)) io.to(pid).emit("partyDeleted", { partyId: pid });
      }
      broadcastParties();
    }

    const cleaned = QUEUE.cleanupDanglingParties((pid) => !!STORE.getParty(pid));
    if (cleaned.length) {
      for (const e of cleaned) io.to(e.socketId).emit("queue:status", { state: "idle" });
      broadcastQueueCounts();
    }
  } catch {
    // ignore
  }
}, 15_000).unref();

const webOut = path.resolve(process.cwd(), "../web/out");
if (fs.existsSync(webOut)) {
  app.use(express.static(webOut));
  app.get("*", (_req, res) => res.sendFile(path.join(webOut, "index.html")));
} else {
  console.warn("[web] ../web/out not found.\nDid you run `npm run build` at repo root?");
}

setInterval(() => cleanupSessions(), 60_000).unref();

server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
  console.log(`[server] PUBLIC_URL=${PUBLIC_URL}`);
  console.log(`[server] DISCORD_REDIRECT_URI=${DISCORD_REDIRECT_URI}`);
});
