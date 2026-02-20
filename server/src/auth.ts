// server/src/auth.ts
// Broad-compat session helpers for server/src/index.ts (in-memory).

import crypto from "crypto";

export type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string;
  avatar?: string | null;
};

export type SessionUser = {
  // Many index.ts versions treat session.user as DiscordUser-like
  id: string;
  // and also as app-specific
  discordId: string;
  username: string;
  displayName: string;
};

export type Session = {
  sessionId: string;
  user: SessionUser;
  createdAt: number;
  updatedAt: number;
};

const COOKIE_NAME = "ml_session";
const sessions = new Map<string, Session>();

function normalizeSameSite(v: string): "lax" | "strict" | "none" {
  const s = String(v).trim().toLowerCase();
  if (s === "none") return "none";
  if (s === "strict") return "strict";
  return "lax";
}

export function cookieSerialize(
  name: string,
  value: string,
  opts?: { httpOnly?: boolean; secure?: boolean; sameSite?: "lax" | "strict" | "none"; path?: string; maxAge?: number }
) {
  const parts: string[] = [];
  parts.push(`${name}=${encodeURIComponent(value)}`);
  parts.push(`Path=${opts?.path ?? "/"}`);
  if (opts?.httpOnly ?? true) parts.push("HttpOnly");
  if (opts?.secure) parts.push("Secure");
  // Some browsers are picky about the casing (None/Lax/Strict), so normalize it.
  const ss = (opts?.sameSite ?? "lax").toLowerCase();
  const ssNorm = ss === "none" ? "None" : ss === "strict" ? "Strict" : "Lax";
  parts.push(`SameSite=${ssNorm}`);
  if (typeof opts?.maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.trunc(opts.maxAge))}`);
  return parts.join("; ");
}

export function parseCookies(cookieHeader?: string) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const p of cookieHeader.split(";")) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function toDisplayName(username: string, globalName?: string, discriminator?: string) {
  const base = (globalName ?? "").trim() || username;
  const disc = (discriminator ?? "").trim();
  return disc && disc !== "0" ? `${base}#${disc}` : base;
}

// Accept either a DiscordUser or a plain object (different index.ts versions call this differently)
export function newSession(input: any): Session {
  const t = Date.now();
  const sessionId = newId();

  // DiscordUser shape
  const isDiscordUser = input && typeof input === "object" && typeof input.id === "string" && typeof input.username === "string";

  const discordId: string = isDiscordUser ? input.id : (input.discordId ?? input.userId ?? "");
  const username: string = isDiscordUser ? input.username : (input.username ?? "");
  const displayName: string =
    isDiscordUser
      ? toDisplayName(input.username, input.global_name, input.discriminator)
      : ((input.displayName ?? input.display_name ?? "").trim() || username);

  const s: Session = {
    sessionId,
    user: {
      id: discordId,
      discordId,
      username,
      displayName: displayName || username || discordId,
    },
    createdAt: t,
    updatedAt: t,
  };

  sessions.set(sessionId, s);
  return s;
}

export function getSession(sessionId?: string | null) {
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

export function deleteSession(sessionId?: string | null) {
  if (!sessionId) return false;
  return sessions.delete(sessionId);
}

export function cleanupSessions(maxAgeMs = 1000 * 60 * 60 * 24 * 7) {
  const t = Date.now();
  for (const [sid, s] of sessions) {
    if (t - s.updatedAt > maxAgeMs) sessions.delete(sid);
  }
}

export function readSessionId(req: any): string | null {
  const hdr = req?.headers?.["x-ml-session"];
  if (typeof hdr === "string" && hdr.trim()) return hdr.trim();

  const q = req?.query?.sid;
  if (typeof q === "string" && q.trim()) return q.trim();

  const cookies = parseCookies(req?.headers?.cookie);
  const c = cookies[COOKIE_NAME];
  if (c && c.trim()) return c.trim();

  return null;
}

export function setSessionCookie(res: any, sessionId: string, opts: { secure: boolean }) {
  /**
   * ✅ 가장 흔한 원인: web(Next.js)과 server(API)가 다른 도메인/사이트면
   * SameSite=Lax 쿠키는 fetch/XHR에서 안 붙어서 "로그인했는데 프론트는 로그아웃"처럼 보입니다.
   *
   * 해결: production에서 기본 SameSite=None + Secure=true
   * - 환경변수 COOKIE_SAMESITE로 강제 가능 (none|lax|strict)
   */
  const isProd = process.env.NODE_ENV === "production";
  const sameSite = normalizeSameSite(process.env.COOKIE_SAMESITE ?? (isProd ? "none" : "lax"));

  res.setHeader(
    "Set-Cookie",
    cookieSerialize(COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: opts.secure,
      sameSite,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })
  );
}

export function clearSessionCookie(res: any, opts: { secure: boolean }) {
  const isProd = process.env.NODE_ENV === "production";
  const sameSite = normalizeSameSite(process.env.COOKIE_SAMESITE ?? (isProd ? "none" : "lax"));

  res.setHeader(
    "Set-Cookie",
    cookieSerialize(COOKIE_NAME, "", {
      httpOnly: true,
      secure: opts.secure,
      sameSite,
      path: "/",
      maxAge: 0,
    })
  );
}
