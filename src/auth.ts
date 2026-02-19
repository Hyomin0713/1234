// server/src/auth.ts
import crypto from "crypto";

export type Session = {
  sessionId: string;
  discordId: string;
  username: string;
  nickname?: string;
  createdAt: number;
  updatedAt: number;
};

const COOKIE_NAME = "ml_session";
const sessions = new Map<string, Session>();

export function cookieSerialize(name: string, value: string, opts?: {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
}) {
  const parts: string[] = [];
  parts.push(`${name}=${encodeURIComponent(value)}`);
  parts.push(`Path=${opts?.path ?? "/"}`);
  if (opts?.httpOnly ?? true) parts.push("HttpOnly");
  if (opts?.secure) parts.push("Secure");
  parts.push(`SameSite=${opts?.sameSite ?? "Lax"}`);
  if (typeof opts?.maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.trunc(opts.maxAge))}`);
  return parts.join("; ");
}

export function parseCookies(cookieHeader?: string) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const p of parts) {
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

export function newSession(input: { discordId: string; username: string; nickname?: string }) {
  const t = Date.now();
  const sessionId = newId();
  const s: Session = {
    sessionId,
    discordId: input.discordId,
    username: input.username,
    nickname: input.nickname,
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
  res.setHeader(
    "Set-Cookie",
    cookieSerialize(COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: opts.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })
  );
}

export function clearSessionCookie(res: any, opts: { secure: boolean }) {
  res.setHeader(
    "Set-Cookie",
    cookieSerialize(COOKIE_NAME, "", {
      httpOnly: true,
      secure: opts.secure,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })
  );
}
