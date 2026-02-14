"use client";

import React from "react";

type Props = {
  query: string;
  onChangeQuery: (v: string) => void;
  countText: string;
  muted: React.CSSProperties;
  card: React.CSSProperties;
  cardHeader: React.CSSProperties;
};

export function SearchHeader({ query, onChangeQuery, countText, muted, card, cardHeader }: Props) {
  return (
    <header style={{ ...card, gridColumn: "2", gridRow: "1", display: "flex", alignItems: "center" }}>
      <div style={{ ...cardHeader, borderBottom: "none", width: "100%" }}>
        <div style={{ fontWeight: 800 }}>사냥터 검색</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, justifyContent: "flex-end" }}>
          <input
            value={query}
            onChange={(e) => onChangeQuery(e.target.value)}
            placeholder=""
            style={{
              width: "min(640px, 100%)",
              maxWidth: 720,
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 12,
              padding: "10px 12px",
              color: "#e6e8ee",
              outline: "none",
            }}
          />
          <div style={muted}>{countText}</div>
        </div>
      </div>
    </header>
  );
}
