"use client";

import React from "react";

type Ground = {
  id: string;
  name: string;
  area: string;
  recommendedLevel: string;
  tags: string[];
  note: string;
};

export function GroundCardList(props: {
  filtered: Ground[];
  selectedId: string;
  onSelectGround: (id: string) => void;
  isCustomSelected: boolean;
  openNewGround: () => void;
  openEditGround: () => void;
  deleteSelectedGround: () => void;
  cardHeader: React.CSSProperties;
  muted: React.CSSProperties;
  btn: React.CSSProperties;
}) {
  const { filtered, selectedId, onSelectGround, isCustomSelected, openNewGround, openEditGround, deleteSelectedGround, cardHeader, muted, btn } = props;
  return (
    <section style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={cardHeader}>
        <div style={{ fontWeight: 900 }}>사냥터</div>
</div>
      <div style={{ padding: 12, display: "grid", gap: 10 }}>
        {filtered.map((g) => {
          const active = g.id === selectedId;
          return (
            <button
              key={g.id}
              onClick={() => onSelectGround(g.id)}
              style={{
                textAlign: "left",
                border: active ? "1px solid rgba(120,200,255,0.40)" : "1px solid rgba(255,255,255,0.10)",
                background: active ? "rgba(120,200,255,0.10)" : "rgba(255,255,255,0.04)",
                borderRadius: 14,
                padding: 12,
                cursor: "pointer",
                color: "#e6e8ee",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 900 }}>{g.name}</div>
                <div style={{ ...muted, whiteSpace: "nowrap" }}>{g.recommendedLevel}</div>
              </div>
              <div style={{ ...muted, marginTop: 4 }}>{g.area}</div>
              <div style={{ ...muted, marginTop: 6, lineHeight: 1.4 }}>{g.note}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {(g.tags || []).slice(0, 5).map((t) => (
                  <span key={t} style={{ fontSize: 12, padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.03)" }}>
                    {t}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
        {filtered.length === 0 ? <div style={{ ...muted, padding: 10 }}>검색 결과 없음</div> : null}
      </div>
    </section>
  );
}
