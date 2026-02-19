import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

export type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
};

export type Session = {
  sid: string;
  user: DiscordUser;
  createdAt: number;
  lastSeenAt: number;
};

const COOKIE_NAME = "ml_session";
const sessions = new Map<string, Session>();

export function getCookieName() {
  return COOKIE_NAME;
}

export function createSession(user: DiscordUser): Session {
  const sid = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  const s: Session = { sid, user, createdAt: now, lastSeenAt: now };
  sessions.set(sid, s);
  return s;
}

export function destroySession(sid: string) {
  sessions.delete(sid);
}

export function getSession(sid?: string | null): Session | null {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  return s;
}

function parseCookie(header?: string) {
  const out: Record<string, string> = {};
  if (!header) return out;
  const parts = header.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSidFromRequest(req: Request): string | null {
  // 1) explicit header (fallback 방식)
  const header = req.header("x-ml-session");
  if (header) return header;

  // 2) cookie
  const cookies = parseCookie(req.header("cookie") || "");
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];

  // 3) query (?sid=...)
  const q = req.query?.sid;
  if (typeof q === "string" && q) return q;

  return null;
}

export function setSessionCookie(res: Response, sid: string) {
  const isProd = process.env.NODE_ENV === "production";
  // SameSite=Lax + Path=/는 Railway 단일 도메인에 적합
  // secure는 https 환경에서만 true
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30d
  });
}

export function clearSessionCookie(res: Response) {
  res.cookie(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sid = getSidFromRequest(req);
  const s = getSession(sid);
  if (!s) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  // @ts-expect-error attach
  req.session = s;
  next();
}

export function getAuthedSession(req: Request): Session | null {
  // @ts-expect-error attached by requireAuth
  return req.session || null;
}
