"use client";

import React from "react";

type Props = {
  isLoggedIn: boolean;
  discordName: string;
  discordTag: string;
  onLogin: () => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  muted: React.CSSProperties;
  card: React.CSSProperties;
  cardHeader: React.CSSProperties;
};

export function DiscordAside({
  isLoggedIn,
  discordName,
  discordTag,
  onLogin,
  onLogout,
  onOpenSettings,
  muted,
  card,
  cardHeader,
}: Props) {
  return (
    <aside
      style={{
        ...card,
        gridColumn: "1",
        gridRow: "1 / span 3",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={cardHeader}>
        <div style={{ fontWeight: 800 }}>메랜큐</div>
        <div style={{ ...muted }}>beta</div>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {!isLoggedIn ? (
          <>
            <div style={{ fontWeight: 700, fontSize: 14 }}>디스코드 로그인</div>
            <button
              onClick={onLogin}
              style={{
                width: "100%",
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(88,101,242,0.18)",
                color: "#e6e8ee",
                padding: "10px 12px",
                borderRadius: 12,
                cursor: "pointer",
                fontWeight: 700,
              }}
              title="디스코드 OAuth 로그인"
            >
              디스코드로 로그인
            </button>
            <div style={muted}>※ 로그인 후 레벨/직업/스공/블랙리스트 입력 → 사냥터 큐 참가 가능</div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 36,
                  minHeight: 44,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.10)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 800,
                }}
              >
                {discordName.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ lineHeight: 1.15 }}>
                <div style={{ fontWeight: 800 }}>{discordName}</div>
                <div style={{ ...muted }}>@{discordTag}</div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onLogout}
                style={{
                  flex: 1,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e8ee",
                  padding: "10px 12px",
                  borderRadius: 12,
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                로그아웃
              </button>
              <button
                onClick={onOpenSettings}
                style={{
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e8ee",
                  padding: "10px 12px",
                  borderRadius: 12,
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                ⚙
              </button>
            </div>
          </>
        )}
      </div>

      <div style={{ padding: 14, borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: "auto" }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>가이드</div>
        <div style={muted}>2번 검색 → 3번 리스트에서 사냥터 선택 → 7번 정보 입력 → 큐 참가 → 매칭완료 채널 표시</div>
      </div>
    </aside>
  );
}
