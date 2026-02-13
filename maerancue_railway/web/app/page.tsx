"use client";

import { useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";
import { api } from "../lib/api";

type Me = {
  user: {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
  };
  profile: { displayName: string } | null;
};

type Party = {
  id: string;
  title: string;
  ownerId: string;
  isLocked: boolean;
  members: { userId: string; name: string; joinedAt: number; buffs: { simbi: number; ppeongbi: number; syapbi: number } }[];
  updatedAt: number;
};

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [parties, setParties] = useState<Party[]>([]);
  const [loadingParties, setLoadingParties] = useState(false);

  const sock = useMemo(() => {
    let s: Socket | null = null;
    return {
      get() {
        if (!s) s = io(undefined, { withCredentials: true });
        return s;
      },
      close() {
        s?.close();
        s = null;
      }
    };
  }, []);

  async function refreshMe() {
    try {
      setMeErr(null);
      const data = await api<Me>("/api/me");
      setMe(data);
    } catch (e: any) {
      setMe(null);
      setMeErr(e?.message ?? "401");
    }
  }

  async function refreshParties() {
    setLoadingParties(true);
    try {
      const data = await api<{ parties: Party[] }>("/api/parties");
      setParties(data.parties);
    } finally {
      setLoadingParties(false);
    }
  }

  useEffect(() => {
    refreshMe();
    refreshParties();

    const s = sock.get();
    s.on("partiesUpdated", (p: { parties: Party[] }) => setParties(p.parties));
    return () => {
      s.off("partiesUpdated");
      sock.close();
    };
  }, [sock]);

  return (
    <main style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>메랜큐</h1>
      <p style={{ opacity: 0.8, marginTop: 8 }}>사냥터 파티 공유 (단일 도메인 배포용 템플릿)</p>

      <section style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
        {!me ? (
          <a
            href="/auth/discord"
            style={{ padding: "10px 14px", border: "1px solid #ddd", borderRadius: 10, textDecoration: "none", display: "inline-block" }}
          >
            디스코드로 로그인
          </a>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <strong>{me.profile?.displayName ?? me.user.global_name ?? me.user.username}</strong>
            <button
              onClick={async () => {
                await api("/api/logout", { method: "POST" });
                await refreshMe();
              }}
              style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" }}
            >
              로그아웃
            </button>
          </div>
        )}

        <button
          onClick={refreshMe}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" }}
        >
          내 상태 새로고침
        </button>

        <button
          onClick={refreshParties}
          disabled={loadingParties}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" }}
        >
          파티 목록 새로고침
        </button>
      </section>

      {meErr && <p style={{ color: "#b00020" }}>로그인 미확인: {meErr}</p>}

      <hr style={{ margin: "24px 0" }} />

      <h2 style={{ margin: 0 }}>파티 목록</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, marginTop: 12 }}>
        {parties.map((p) => (
          <div key={p.id} style={{ border: "1px solid #eee", borderRadius: 14, padding: 14, background: "white" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{p.title}</strong>
              <span style={{ fontSize: 12, opacity: 0.7 }}>{p.isLocked ? "🔒" : ""}</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>방장코드: {p.id}</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>인원: {p.members.length}</div>
          </div>
        ))}
        {parties.length === 0 && <div style={{ opacity: 0.7 }}>현재 파티가 없습니다.</div>}
      </div>
    </main>
  );
}
