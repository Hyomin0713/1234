import "dotenv/config";
import express from "express";
import http from "http";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";

import {
  createSession,
  destroySession,
  getCookieName,
  getSidFromRequest,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  getAuthedSession,
  type DiscordUser,
} from "./auth";

import {
  upsertUser,
  setNickname,
  isNicknameAvailable,
  addToBlacklist,
  removeFromBlacklist,
} from "./userStore";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.ORIGIN || "").replace(/\/$/, "");

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI || (PUBLIC_URL ? `${PUBLIC_URL}/auth/discord/callback` : "");

function assertEnv() {
  const missing: string[] = [];
  if (!DISCORD_CLIENT_ID) missing.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) missing.push("DISCORD_CLIENT_SECRET");
  if (!DISCORD_REDIRECT_URI) missing.push("DISCORD_REDIRECT_URI or PUBLIC_URL");
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn("[WARN] missing env:", missing.join(", "));
  }
}
assertEnv();

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

// --- basic health
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- auth
app.get("/auth/discord", (_req, res) => {
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  res.redirect(url.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return res.status(400).send("missing code");

    // token exchange
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return res.status(500).send(`token exchange failed: ${t}`);
    }

    const tokenJson = (await tokenRes.json()) as { access_token: string };

    // fetch user
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });

    if (!meRes.ok) {
      const t = await meRes.text();
      return res.status(500).send(`fetch user failed: ${t}`);
    }

    const user = (await meRes.json()) as DiscordUser;
    const s = createSession(user);
    setSessionCookie(res, s.sid);

    // 프론트 fallback: /#sid=
    const redirectTo = PUBLIC_URL ? `${PUBLIC_URL}/#sid=${encodeURIComponent(s.sid)}` : `/#sid=${encodeURIComponent(s.sid)}`;
    res.redirect(redirectTo);
  } catch (e: any) {
    res.status(500).send(e?.message || "callback error");
  }
});

// --- session apis (문서 기준)
app.get("/api/me", (req, res) => {
  const sid = getSidFromRequest(req);
  const s = getSession(sid);
  if (!s) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  // user profile upsert(디스코드 이름 저장)
  const discordName = s.user.global_name || s.user.username;
  const profile = upsertUser({ userId: s.user.id, discordName });

  res.json({
    ok: true,
    sid: s.sid,
    cookieName: getCookieName(),
    user: s.user,
    profile,
  });
});

app.post("/api/logout", (req, res) => {
  const sid = getSidFromRequest(req);
  if (sid) destroySession(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- profile apis
app.get("/api/profile", requireAuth, (req, res) => {
  const s = getAuthedSession(req)!;
  const discordName = s.user.global_name || s.user.username;
  const profile = upsertUser({ userId: s.user.id, discordName });
  res.json({ ok: true, profile });
});

app.post("/api/profile", requireAuth, (req, res) => {
  const s = getAuthedSession(req)!;
  const discordName = s.user.global_name || s.user.username;

  try {
    const { nickname, level, job, atk } = (req.body || {}) as any;

    if (typeof nickname === "string") {
      setNickname(s.user.id, nickname, discordName);
    }

    upsertUser({
      userId: s.user.id,
      discordName,
      level: typeof level === "number" ? level : undefined,
      job: typeof job === "string" ? job : undefined,
      atk: typeof atk === "number" ? atk : undefined,
    });

    const profile = upsertUser({ userId: s.user.id, discordName });
    res.json({ ok: true, profile });
  } catch (e: any) {
    const msg = e?.message || "UPDATE_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

app.post("/api/blacklist/add", requireAuth, (req, res) => {
  const s = getAuthedSession(req)!;
  const discordName = s.user.global_name || s.user.username;
  const targetUserId = String((req.body || {}).targetUserId || "");
  if (!targetUserId) return res.status(400).json({ ok: false, error: "targetUserId required" });
  const profile = addToBlacklist(s.user.id, targetUserId, discordName);
  res.json({ ok: true, profile });
});

app.post("/api/blacklist/remove", requireAuth, (req, res) => {
  const s = getAuthedSession(req)!;
  const discordName = s.user.global_name || s.user.username;
  const targetUserId = String((req.body || {}).targetUserId || "");
  if (!targetUserId) return res.status(400).json({ ok: false, error: "targetUserId required" });
  const profile = removeFromBlacklist(s.user.id, targetUserId, discordName);
  res.json({ ok: true, profile });
});

// --- static web (Railway 단일 도메인에서 Next 빌드 결과를 같은 서버에서 서빙할 때 사용)
// 현재 레포 구조가 "web" 별도라면, Railway에서 Next를 별도 프로세스로 띄우는 경우엔 아래가 필요 없을 수 있음.

const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: PUBLIC_URL || true,
    credentials: true,
  },
});

io.use((socket, next) => {
  const sid =
    (socket.handshake.auth && (socket.handshake.auth as any).sid) ||
    (socket.handshake.headers["x-ml-session"] as string | undefined);

  const s = getSession(typeof sid === "string" ? sid : null);
  if (!s) return next(new Error("UNAUTHORIZED"));
  (socket as any).session = s;
  next();
});

io.on("connection", (socket) => {
  const s = (socket as any).session as ReturnType<typeof getSession>;
  const discordName = s!.user.global_name || s!.user.username;
  upsertUser({ userId: s!.user.id, discordName });

  // 프론트가 보내는 이벤트(문서/프론트 기준)
  socket.on("queue:updateProfile", (payload: any, cb?: (resp: any) => void) => {
    try {
      const nickname = typeof payload?.nickname === "string" ? payload.nickname : undefined;
      const level = typeof payload?.level === "number" ? payload.level : undefined;
      const job = typeof payload?.job === "string" ? payload.job : undefined;
      const atk = typeof payload?.atk === "number" ? payload.atk : undefined;

      if (nickname !== undefined) {
        if (!isNicknameAvailable(nickname, s!.user.id)) {
          return cb?.({ ok: false, error: "NICK_TAKEN" });
        }
        setNickname(s!.user.id, nickname, discordName);
      }

      const profile = upsertUser({ userId: s!.user.id, discordName, level, job, atk });
      cb?.({ ok: true, profile });
    } catch (e: any) {
      cb?.({ ok: false, error: e?.message || "UPDATE_FAILED" });
    }
  });

  // 최소 호환: 프론트가 큐 참가 전에 닉네임 체크를 원할 때
  socket.on("queue:checkNickname", (payload: any, cb?: (resp: any) => void) => {
    const nickname = String(payload?.nickname || "");
    const ok = isNicknameAvailable(nickname, s!.user.id);
    cb?.({ ok });
  });

  socket.on("disconnect", () => {
    // 현재는 메모리 스토어라 별도 정리 없음
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on :${PORT}`);
});
