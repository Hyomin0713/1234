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

function requireAuth(req: express.Request, res: express.Response): { user: DiscordUser } | null {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies["ml_session"];
  const s = getSession(sid);
  if (!s) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
  return { user: s.user };
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

    const isHttps = /^https:\/\//i.test(PUBLIC_URL);
    res.setHeader(
      "Set-Cookie",
      cookieSerialize("ml_session", s.sessionId, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7
      })
    );

    // ✅ redirect back to root (single-domain)
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});

/** ---------------- Auth APIs ---------------- */
app.get("/api/me", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  res.json({ user: auth.user, profile: PROFILES.get(auth.user.id) });
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
io.on("connection", (socket) => {
  socket.on("joinPartyRoom", ({ partyId }: { partyId: string }) => {
    if (!partyId) return;
    socket.join(partyId);
  });

  // --- queue matchmaking ---
  socket.on("queue:hello", (p: any) => {
    const nick = String(p?.nickname ?? "").trim();
    if (!nick) return;

    QUEUE.upsert(socket.id, null, {
      nickname: nick,
      level: p?.level,
      job: p?.job,
      power: p?.power,
      blacklist: p?.blacklist,
    });

    const cur = QUEUE.get(nick);
    if (cur?.state === "matched") socket.emit("queue:status", { state: "matched", channel: cur.channel });
    else if (cur?.state === "searching") socket.emit("queue:status", { state: "searching" });
    else socket.emit("queue:status", { state: "idle" });
  });

  socket.on("queue:updateProfile", (p: any) => {
    const nick = String(p?.nickname ?? "").trim();
    if (!nick) return;

    QUEUE.upsert(socket.id, null, {
      nickname: nick,
      level: p?.level,
      job: p?.job,
      power: p?.power,
      blacklist: p?.blacklist,
    });
  });

  socket.on("queue:join", (p: any) => {
    const huntingGroundId = String(p?.huntingGroundId ?? "").trim();
    const nickname = String(p?.nickname ?? "").trim();
    if (!huntingGroundId || !nickname) return;

    const entry = QUEUE.join(socket.id, huntingGroundId, {
      nickname,
      level: Number(p?.level ?? 1),
      job: p?.job ?? "전사",
      power: Number(p?.power ?? 0),
      blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [],
    } as any);

    if (!entry) return;

    socket.emit("queue:status", { state: "searching" });

    const matched = QUEUE.tryMatch(huntingGroundId);
    if (matched) {
      io.to(matched.a.socketId).emit("queue:status", { state: "matched", channel: matched.channel });
      io.to(matched.b.socketId).emit("queue:status", { state: "matched", channel: matched.channel });
    }
  });

  socket.on("queue:leave", (p: any) => {
    const nick = String(p?.nickname ?? "").trim();
    if (nick) QUEUE.leave(nick);
    else QUEUE.removeBySocket(socket.id);
    socket.emit("queue:status", { state: "idle" });
  });

  socket.on("disconnect", () => {
    QUEUE.removeBySocket(socket.id);
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