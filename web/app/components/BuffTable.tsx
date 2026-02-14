"use client";

import React, { useMemo } from "react";

type Job = "전사" | "도적" | "궁수" | "마법사";

type Member = {
  id: string;
  name: string;
  level?: number | null;
  job?: Job | null;
  power?: number | null;
  buffs?: { simbi?: number; ppeongbi?: number; syapbi?: number } | null;
  isOwner?: boolean;
};

type Party = {
  id: string;
  ownerId?: string | null;
  members?: Member[];
};

type Me = { user: { id: string } } | null;

export function BuffTable(props: {
  partyId: string;
  party: Party | null;
  me: Me;
  myBuffs: { simbi: number; ppeongbi: number; syapbi: number };
  onChangeMyBuffs: (v: { simbi: number; ppeongbi: number; syapbi: number }) => void;
  onPushMyBuffs: (next: { simbi: number; ppeongbi: number; syapbi: number }) => void | Promise<void>;
  fmtNumber: (n: number | null | undefined) => string;
  card: React.CSSProperties;
  muted: React.CSSProperties;
  chip: React.CSSProperties;
  input: React.CSSProperties;
}) {
  const { partyId, party, me, myBuffs, onChangeMyBuffs, onPushMyBuffs, fmtNumber, card, muted, chip, input } = props;
  const myId = me?.user?.id || "";

  const rows = useMemo(() => {
    const ms = (party?.members || []).slice();
    const ownerId = party?.ownerId || party?.members?.find((m) => m.isOwner)?.id;
    ms.sort((a, b) => {
      const ao = a.id === ownerId;
      const bo = b.id === ownerId;
      if (ao && !bo) return -1;
      if (!ao && bo) return 1;
      return a.name.localeCompare(b.name);
    });
    return { ms, ownerId: ownerId || "" };
  }, [party]);

  const myInParty = !!partyId && !!party && (party.members || []).some((m) => m.id === myId);
  const canEdit = myInParty && !!rows.ownerId && rows.ownerId === myId;

  return (
    <div style={{ ...card, background: "rgba(255,255,255,0.04)" }}>
      <div style={{ padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 900 }}>파티 버프</div>
          <div style={muted}>{partyId ? `파티: ${partyId.slice(0, 6)}...` : "파티 없음"}</div>
        </div>
        <button
          onClick={() => onPushMyBuffs(myBuffs)}
          style={{
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(120,200,255,0.12)",
            color: "#e6e8ee",
            padding: "10px 12px",
            borderRadius: 10,
            cursor: canEdit ? "pointer" : "not-allowed",
            opacity: canEdit ? 1 : 0.45,
            fontWeight: 900,
          }}
          disabled={!canEdit}
        >
          버프 저장
        </button>
      </div>

      <div style={{ padding: 14, paddingTop: 0, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div style={muted}>심비</div>
            <input
              value={String(myBuffs.simbi)}
              onChange={(e) => onChangeMyBuffs({ ...myBuffs, simbi: Math.max(0, Math.min(6, Math.floor(Number(e.target.value) || 0))) })}
              style={{ ...input, width: "100%", boxSizing: "border-box" }}
              inputMode="numeric"
              disabled={!canEdit}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div style={muted}>뻥비</div>
            <input
              value={String(myBuffs.ppeongbi)}
              onChange={(e) => onChangeMyBuffs({ ...myBuffs, ppeongbi: Math.max(0, Math.min(6, Math.floor(Number(e.target.value) || 0))) })}
              style={{ ...input, width: "100%", boxSizing: "border-box" }}
              inputMode="numeric"
              disabled={!canEdit}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div style={muted}>샾비</div>
            <input
              value={String(myBuffs.syapbi)}
              onChange={(e) => onChangeMyBuffs({ ...myBuffs, syapbi: Math.max(0, Math.min(6, Math.floor(Number(e.target.value) || 0))) })}
              style={{ ...input, width: "100%", boxSizing: "border-box" }}
              inputMode="numeric"
              disabled={!canEdit}
            />
          </label>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {rows.ms.length === 0 ? <div style={{ ...muted, padding: 8 }}>파티원이 없습니다.</div> : null}
          {rows.ms.map((m) => {
            const isMe = m.id === myId;
            const isOwner = m.id === rows.ownerId;
            const b = m.buffs || {};
            const simbi = Number(b.simbi ?? 0);
            const ppeongbi = Number(b.ppeongbi ?? 0);
            const syapbi = Number(b.syapbi ?? 0);
            return (
              <div key={m.id} style={{ border: "1px solid rgba(255,255,255,0.10)", background: isMe ? "rgba(120,200,255,0.06)" : "rgba(0,0,0,0.20)", borderRadius: 14, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                  <div style={{ fontWeight: 900, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {isOwner ? <span style={{ ...chip, background: "rgba(255,210,120,0.12)", borderColor: "rgba(255,210,120,0.35)" }}>👑</span> : null}
                    <span>{m.name}</span>
                    {isMe ? <span style={{ ...chip, background: "rgba(120,200,255,0.12)", borderColor: "rgba(120,200,255,0.35)" }}>(나)</span> : null}
                  </div>
                  <div style={muted}>{m.level ? `Lv. ${m.level}` : ""}</div>
                </div>
                <div style={{ ...muted, marginTop: 4 }}>
                  {(m.job || "").trim() ? `${m.job}` : "-"} · 스공 {fmtNumber(m.power ?? null)}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <span style={{ ...chip, opacity: simbi ? 1 : 0.45 }}>심비 {simbi}</span>
                  <span style={{ ...chip, opacity: ppeongbi ? 1 : 0.45 }}>뻥비 {ppeongbi}</span>
                  <span style={{ ...chip, opacity: syapbi ? 1 : 0.45 }}>샾비 {syapbi}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
