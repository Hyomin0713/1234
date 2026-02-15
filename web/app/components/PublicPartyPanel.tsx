"use client";

import React from "react";

type Party = {
  id: string;
  title?: string | null;
  isLocked?: boolean;
  locked?: boolean;
  maxMembers?: number;
  members?: Array<{ id: string; name: string }>;
  memberCount?: number;
  createdAt?: number;
  updatedAt?: number;
  groundId?: string | null;
  groundName?: string | null;
  buffReq?: {
    simbi?: { min: number; max: number };
    ppeongbi?: { min: number; max: number };
    syapbi?: { min: number; max: number };
  };
};

export function PublicPartyPanel(props: {
  selectedName: string | null;
  selectedId: string | null;
  myPartyId: string | null;
  parties: Party[];
  onRefresh: () => void;
  onJoin: (partyId: string, lockPassword?: string) => void;
  card: React.CSSProperties;
  muted: React.CSSProperties;
  btnSm: React.CSSProperties;
  listCard: React.CSSProperties;
  pill: React.CSSProperties;
}) {
  const { selectedName, selectedId, myPartyId, parties, onRefresh, onJoin, card, muted, btnSm, listCard, pill } = props;

  const [fSimMin, setFSimMin] = React.useState(0);
  const [fSimMax, setFSimMax] = React.useState(6);
  const [fPpMin, setFPpMin] = React.useState(0);
  const [fPpMax, setFPpMax] = React.useState(6);
  const [fSyMin, setFSyMin] = React.useState(0);
  const [fSyMax, setFSyMax] = React.useState(6);
  const [filterOn, setFilterOn] = React.useState(false);

  const clamp = (v: any) => {
    const n = Number(String(v).replace(/[^0-9]/g, ""));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(6, Math.floor(n)));
  };
  const sorted = [...(parties || [])].sort((a, b) => {
    const aMine = myPartyId && a.id === myPartyId;
    const bMine = myPartyId && b.id === myPartyId;
    if (aMine && !bMine) return -1;
    if (!aMine && bMine) return 1;
    const ac = a.memberCount ?? a.members?.length ?? 0;
    const bc = b.memberCount ?? b.members?.length ?? 0;
    if (bc !== ac) return bc - ac;
    const at = a.updatedAt ?? a.createdAt ?? 0;
    const bt = b.updatedAt ?? b.createdAt ?? 0;
    return bt - at;
  });

  const filtered = filterOn
    ? sorted.filter((p) => {
        const r = p.buffReq || {};
        const sim = r.simbi || { min: 0, max: 6 };
        const pp = r.ppeongbi || { min: 0, max: 6 };
        const sy = r.syapbi || { min: 0, max: 6 };

        const simMin = Math.min(clamp(fSimMin), clamp(fSimMax));
        const simMax = Math.max(clamp(fSimMin), clamp(fSimMax));
        const ppMin = Math.min(clamp(fPpMin), clamp(fPpMax));
        const ppMax = Math.max(clamp(fPpMin), clamp(fPpMax));
        const syMin = Math.min(clamp(fSyMin), clamp(fSyMax));
        const syMax = Math.max(clamp(fSyMin), clamp(fSyMax));

        return sim.min >= simMin && sim.max <= simMax && pp.min >= ppMin && pp.max <= ppMax && sy.min >= syMin && sy.max <= syMax;
      })
    : sorted;

  return (
    <div style={{ ...card, background: "rgba(255,255,255,0.04)" }}>
      <div style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 900 }}>공개 파티</div>
          <div style={muted}>{selectedName ? `${selectedName} 기준` : "전체"}</div>
        </div>
        <button onClick={onRefresh} style={btnSm}>
          새로고침
        </button>
      </div>

      <div style={{ padding: 14, paddingTop: 0, display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div>
            <div style={muted}>심비</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <input value={String(fSimMin)} onChange={(e) => setFSimMin(clamp(e.target.value))} inputMode="numeric" style={{ ...btnSm, background: "rgba(0,0,0,0.15)", borderRadius: 10 }} />
              <input value={String(fSimMax)} onChange={(e) => setFSimMax(clamp(e.target.value))} inputMode="numeric" style={{ ...btnSm, background: "rgba(0,0,0,0.15)", borderRadius: 10 }} />
            </div>
          </div>
          <div>
            <div style={muted}>뻥비</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <input value={String(fPpMin)} onChange={(e) => setFPpMin(clamp(e.target.value))} inputMode="numeric" style={{ ...btnSm, background: "rgba(0,0,0,0.15)", borderRadius: 10 }} />
              <input value={String(fPpMax)} onChange={(e) => setFPpMax(clamp(e.target.value))} inputMode="numeric" style={{ ...btnSm, background: "rgba(0,0,0,0.15)", borderRadius: 10 }} />
            </div>
          </div>
          <div>
            <div style={muted}>샾비</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <input value={String(fSyMin)} onChange={(e) => setFSyMin(clamp(e.target.value))} inputMode="numeric" style={{ ...btnSm, background: "rgba(0,0,0,0.15)", borderRadius: 10 }} />
              <input value={String(fSyMax)} onChange={(e) => setFSyMax(clamp(e.target.value))} inputMode="numeric" style={{ ...btnSm, background: "rgba(0,0,0,0.15)", borderRadius: 10 }} />
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={btnSm} onClick={() => setFilterOn(true)}>
            조건 적용
          </button>
          <button style={btnSm} onClick={() => setFilterOn(false)}>
            해제
          </button>
        </div>
      </div>

      <div style={{ padding: 14, paddingTop: 0, display: "grid", gap: 10 }}>
        {filtered.length === 0 ? <div style={{ ...muted, padding: 8 }}>공개 파티가 없습니다.</div> : null}
        {filtered.map((p) => {
          const locked = !!(p.isLocked ?? p.locked);
          const count = p.memberCount ?? p.members?.length ?? 0;
          const title = p.title || (selectedName ? `${selectedName} 파티` : "파티");
          const isMine = myPartyId && p.id === myPartyId;
          const gOk = !selectedId || p.groundId === selectedId || (!p.groundId && selectedName && (p.title || "").includes(selectedName));
          if (selectedId && !gOk) return null;
          return (
            <div key={p.id} style={listCard}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 900, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>{title}</span>
                    {locked ? <span style={{ ...pill, borderColor: "rgba(255,180,120,0.35)", background: "rgba(255,180,120,0.10)" }}>잠금</span> : null}
                    {isMine ? <span style={{ ...pill, borderColor: "rgba(120,200,255,0.40)", background: "rgba(120,200,255,0.12)" }}>내 파티</span> : null}
                  </div>
                  <div style={muted}>{`${count}/${p.maxMembers ?? 6}명`}</div>
                  {p.buffReq ? (
                    <div style={{ ...muted, marginTop: 4 }}>{`심 ${p.buffReq.simbi?.min ?? 0}-${p.buffReq.simbi?.max ?? 6} · 뻥 ${p.buffReq.ppeongbi?.min ?? 0}-${p.buffReq.ppeongbi?.max ?? 6} · 샾 ${p.buffReq.syapbi?.min ?? 0}-${p.buffReq.syapbi?.max ?? 6}`}</div>
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={() => {
                      if (count >= (p.maxMembers ?? 6)) return;
                      if (locked) {
                        const pw = prompt("비밀번호");
                        if (pw == null) return;
                        onJoin(p.id, pw);
                      } else {
                        onJoin(p.id);
                      }
                    }}
                    style={{ ...btnSm, cursor: count >= (p.maxMembers ?? 6) ? "not-allowed" : "pointer", opacity: count >= (p.maxMembers ?? 6) ? 0.5 : 1 }}
                    disabled={count >= (p.maxMembers ?? 6)}
                  >
                    참가
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
