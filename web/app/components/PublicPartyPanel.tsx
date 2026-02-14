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
        {sorted.length === 0 ? <div style={{ ...muted, padding: 8 }}>공개 파티가 없습니다.</div> : null}
        {sorted.map((p) => {
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
