"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type Job = "전사" | "도적" | "궁수" | "마법사";
type MatchState = "idle" | "searching" | "matched";
type QueueStatusPayload = { state: MatchState; channel?: string; message?: string };
type MeResponse = { user: { id: string; username: string; global_name: string | null; avatar: string | null }; profile?: { displayName: string } | null };


type HuntingGround = {
  id: string;
  name: string;
  area: string;
  recommendedLevel: string;
  tags: string[];
  note: string;
};

const GROUNDS: HuntingGround[] = [
  {
    id: "hg-kerning-1",
    name: "커닝시티 지하철 1구역",
    area: "커닝",
    recommendedLevel: "21~30",
    tags: ["혼잡", "저레벨", "파티"],
    note: "초반 파티 사냥용. 자리 경쟁 잦음.",
  },
  {
    id: "hg-orbis-1",
    name: "오르비스 탑 20층",
    area: "오르비스",
    recommendedLevel: "31~45",
    tags: ["안정", "파티", "원거리유리"],
    note: "몹 밀집 좋음. 원거리 직업 체감 좋음.",
  },
  {
    id: "hg-ellinia-1",
    name: "엘리니아 북쪽 숲",
    area: "엘리니아",
    recommendedLevel: "15~25",
    tags: ["여유", "솔플", "초보"],
    note: "큐보다 솔플 선호 구간. 테스트용으로 남김.",
  },
  {
    id: "hg-ludi-1",
    name: "루디브리엄 시계탑 2층",
    area: "루디",
    recommendedLevel: "45~60",
    tags: ["파티", "인기", "자리거래많음"],
    note: "자리 공유/파티 매칭 수요 높음.",
  },
  {
    id: "hg-omega-1",
    name: "오메가 섹터 구역 A",
    area: "오메가",
    recommendedLevel: "55~70",
    tags: ["파티", "경험치", "사냥터핵심"],
    note: "레벨대 맞추기 좋음. 큐 테스트 추천.",
  },
];

function clampInt(v: string, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeLocalGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function safeLocalSet(key: string, value: any) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function Page() {
  // 1) 디스코드 로그인 (현재는 UI만 / 추후 /auth/discord 연결)
  const [me, setMe] = useState<MeResponse | null>(null);
  const isLoggedIn = !!me?.user?.id;

  // Fetch login state right after OAuth redirect (and on hard refresh)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // OAuth fallback: server may redirect to /#sid=... to recover session
        // if the browser didn't persist Set-Cookie. Hash is client-only.
        const sid = typeof window !== "undefined" && window.location.hash.startsWith("#sid=")
          ? window.location.hash.slice("#sid=".length)
          : "";

        const res = await fetch("/api/me", {
          credentials: "include",
          headers: sid ? { "x-ml-session": decodeURIComponent(sid) } : undefined,
        });
        if (!alive) return;
        if (!res.ok) {
          setMe(null);
          return;
        }
        const data = (await res.json()) as MeResponse;
        setMe(data);

        // Clean the hash so it doesn't stick around.
        if (sid && typeof window !== "undefined") {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      } catch {
        // Network errors shouldn't crash the page.
        setMe(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Discord profile display helpers (safe for build + unauth states)
  const discordName = (me?.user?.global_name ?? me?.user?.username ?? "User").trim() || "User";
  // Discord 'tag' is effectively the username in new Discord. Keep as a secondary line.
  const discordTag = (me?.user?.username ?? "unknown").trim() || "unknown";
  const [nickname, setNickname] = useState("");
  useEffect(() => {
    const n = (me?.profile?.displayName ?? me?.user?.global_name ?? me?.user?.username ?? "").trim();
    if (n) setNickname((prev) => (prev ? prev : n));
  }, [me]);

  // 2) 사냥터 검색
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(GROUNDS[0]?.id ?? "");

  // 7) 큐 정보
  const [level, setLevel] = useState(50);
  const [job, setJob] = useState<Job>("전사");
  const [power, setPower] = useState(12000);

  const [blackInput, setBlackInput] = useState("");
  const [blacklist, setBlacklist] = useState<string[]>(["포켓몬성능"]);

  // 매칭 상태
  const [matchState, setMatchState] = useState<MatchState>("idle");
  const [channel, setChannel] = useState<string>("");

  const [dotTick, setDotTick] = useState(1);
  useEffect(() => {
    if (matchState !== "searching") {
      setDotTick(1);
      return;
    }
    const id = setInterval(() => setDotTick((t) => (t % 3) + 1), 650);
    return () => clearInterval(id);
  }, [matchState]);


  const socketRef = useRef<Socket | null>(null);
  const [sockConnected, setSockConnected] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUNDS;
    return GROUNDS.filter((g) => {
      const blob = `${g.name} ${g.area} ${g.recommendedLevel} ${g.tags.join(" ")} ${g.note}`.toLowerCase();
      return blob.includes(q);
    });
  }, [query]);

  const selected = useMemo(
    () => GROUNDS.find((g) => g.id === selectedId) ?? filtered[0] ?? GROUNDS[0],
    [selectedId, filtered]
  );


  // --- persist & realtime queue (socket) ---
  useEffect(() => {
    // restore saved inputs
    const saved = safeLocalGet("mlq.queueForm", null as any);
    if (saved) {
      if (typeof saved.level === "number") setLevel(saved.level);
      if (typeof saved.job === "string") setJob(saved.job as Job);
      if (typeof saved.power === "number") setPower(saved.power);
      if (typeof saved.nickname === "string") setNickname(saved.nickname);
      if (Array.isArray(saved.blacklist)) setBlacklist(saved.blacklist.filter((x: any) => typeof x === "string"));
    }
  }, []);

  useEffect(() => {
    safeLocalSet("mlq.queueForm", { level, job, power, nickname, blacklist });
  }, [level, job, power, nickname, blacklist]);

  useEffect(() => {
    const sck = io({
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
    socketRef.current = sck;

    sck.on("connect", () => setSockConnected(true));
    sck.on("disconnect", () => setSockConnected(false));

    sck.on("queue:status", (p: QueueStatusPayload) => {
      if (!p) return;
      setMatchState(p.state);
      setChannel(p.channel ?? "");
    });

    // ask server to reattach any existing queue state (based on nickname)
    sck.emit("queue:hello", {
      nickname,
      level,
      job,
      power,
      blacklist,
    });

    return () => {
      sck.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // keep server updated when user edits
    const sck = socketRef.current;
    if (!sck) return;
    if (!sockConnected) return;
    sck.emit("queue:updateProfile", { nickname, level, job, power, blacklist });
  }, [nickname, level, job, power, blacklist, sockConnected]);

  const joinQueue = () => {
    const sck = socketRef.current;
    if (!sck) return;
    setMatchState("searching");
    setChannel("");
    sck.emit("queue:join", {
      huntingGroundId: selectedId,
      nickname,
      level,
      job,
      power,
      blacklist,
    });
  };

  const leaveQueue = () => {
    const sck = socketRef.current;
    if (!sck) return;
    sck.emit("queue:leave");
    setMatchState("idle");
    setChannel("");
  };

  function onSelectGround(id: string) {
    setSelectedId(id);
    setMatchState("idle");
    setChannel("");
  }

  function addBlacklist() {
    const v = blackInput.trim();
    if (!v) return;
    if (blacklist.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setBlackInput("");
      return;
    }
    setBlacklist((prev) => [v, ...prev].slice(0, 50));
    setBlackInput("");
  }

  function removeBlacklist(v: string) {
    setBlacklist((prev) => prev.filter((x) => x !== v));
  }

  function startMatching() {
    if (!selected) return;

    // 지금은 OAuth 연동 전이므로, 로그인 여부와 무관하게 큐 참여는 가능하게 둠
    joinQueue();
  }


  const shell: React.CSSProperties = {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "260px 1fr minmax(360px, 440px)",
    gridTemplateRows: "72px 1fr 140px",
    gap: 14,
    padding: 14,
    boxSizing: "border-box",
  };

  // 영역 매핑:
  // 1: left sidebar (col1 rows 1-3)
  // 2: top search (col2 row1)
  // 3-4: center (col2 row2, split inside)
  // 5: right ad (col3 row2)
  // 6: bottom ad (col2-3 row3)
  // 7: queue info (col3 row1 + small area row2 top)
  const card: React.CSSProperties = {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    overflow: "hidden",
  };

  const cardHeader: React.CSSProperties = {
    padding: "12px 14px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  };

  const muted: React.CSSProperties = { color: "rgba(230,232,238,0.7)", fontSize: 12 };

  return (
    <div style={shell}>
      {/* 1) 디스코드 */}
      <aside style={{ ...card, gridColumn: "1", gridRow: "1 / span 3", display: "flex", flexDirection: "column" }}>
        <div style={cardHeader}>
          <div style={{ fontWeight: 800 }}>메랜큐</div>
          <div style={{ ...muted }}>beta</div>
        </div>

        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {!isLoggedIn ? (
            <>
              <div style={{ fontWeight: 700, fontSize: 14 }}>디스코드 로그인</div>
              <button
                onClick={() => (window.location.href = "/auth/discord")}
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
                  onClick={async () => {
                    try {
                      await fetch("/api/logout", { method: "POST", credentials: "include" });
                    } catch {}
                    window.location.reload();
                  }}
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
                  onClick={() => alert("추후: 프로필/설정")}
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
          <div style={muted}>
            2번 검색 → 3번 리스트에서 사냥터 선택 → 7번 정보 입력 → 큐 참가(데모) → 매칭완료 채널 표시
          </div>
        </div>
      </aside>

      {/* 2) 사냥터 검색 */}
      <header style={{ ...card, gridColumn: "2", gridRow: "1", display: "flex", alignItems: "center" }}>
        <div style={{ ...cardHeader, borderBottom: "none", width: "100%" }}>
          <div style={{ fontWeight: 800 }}>사냥터 검색</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, justifyContent: "flex-end" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="예: 루디 / 55 / 파티 / 오메가..."
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
            <div style={muted}>{filtered.length}개</div>
          </div>
        </div>
      </header>

      {/* 7) 큐 정보 (우상단) */}
      <section style={{ ...card, gridColumn: "3", gridRow: "1", display: "flex", flexDirection: "column" }}>
        <div style={{ ...cardHeader, alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontWeight: 800 }}>큐 정보</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>레벨/직업/스공/블랙리스트가 매칭 조건에 반영됩니다.</div>
          </div>
          <div style={{ ...muted, marginLeft: "auto" }}>
            {matchState === "idle" ? "대기" : matchState === "searching" ? `매칭중${".".repeat(dotTick)}` : `완료 (${channel || "채널 발급"})`}
          </div>
        </div>

        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div style={muted}>레벨</div>
              <input
                value={level}
                onChange={(e) => setLevel(clampInt(e.target.value, 1, 250))}
                inputMode="numeric"
                style={{
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 12,
                  padding: "10px 12px",
                  color: "#e6e8ee",
                  outline: "none",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div style={muted}>직업</div>
              <select
                value={job}
                onChange={(e) => setJob(e.target.value as Job)}
                style={{
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 12,
                  padding: "10px 12px",
                  color: "#e6e8ee",
                  outline: "none",
                }}
              >
                <option value="전사">전사</option>
                <option value="도적">도적</option>
                <option value="궁수">궁수</option>
                <option value="마법사">마법사</option>
              </select>
            </label>
          </div>

          <label style={{ display: "grid", gap: 6 }}>
            <div style={muted}>닉네임</div>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="매칭/블랙리스트 기준 닉네임"
              style={{
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: "10px 12px",
                color: "#e6e8ee",
                outline: "none",
                minHeight: 44,
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <div style={muted}>스공</div>
            <input
              value={power}
              onChange={(e) => setPower(clampInt(e.target.value, 0, 9999999))}
              inputMode="numeric"
              style={{
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: "10px 12px",
                color: "#e6e8ee",
                outline: "none",
              }}
            />
          </label>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 800 }}>블랙리스트</div>
              <div style={muted}>서로 블랙이면 매칭 제외</div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={blackInput}
                onChange={(e) => setBlackInput(e.target.value)}
                placeholder="닉네임/ID 추가"
                style={{
                  flex: 1,
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 12,
                  padding: "10px 12px",
                  color: "#e6e8ee",
                  outline: "none",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addBlacklist();
                }}
              />
              <button
                onClick={addBlacklist}
                style={{
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e8ee",
                  padding: "10px 12px",
                  borderRadius: 12,
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                추가
              </button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {blacklist.length === 0 ? (
                <div style={muted}>없음</div>
              ) : (
                blacklist.map((b) => (
                  <button
                    key={b}
                    onClick={() => removeBlacklist(b)}
                    title="클릭해서 제거"
                    style={{
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,80,80,0.10)",
                      color: "#e6e8ee",
                      padding: "6px 10px",
                      borderRadius: 999,
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    {b} ✕
                  </button>
                ))
              )}
            </div>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 800 }}>매칭 상태</div>

            {matchState === "idle" && (
              <div style={muted}>큐에 참가하면 “{`매칭중${".".repeat(dotTick)}`}” 표시 후 채널을 안내합니다.</div>
            )}

            {matchState === "searching" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.65)",
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}
                />
                <div style={{ fontWeight: 800 }}>{`매칭중입니다${".".repeat(dotTick)}`} . . .</div>
              </div>
            )}

            {matchState === "matched" && (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>매칭완료!</div>
                <div style={{ fontWeight: 800 }}>채널은 {channel} 입니다.</div>
              </div>
            )}

            <button
              onClick={startMatching}
              style={{
                marginTop: 6,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(120,200,255,0.14)",
                color: "#e6e8ee",
                padding: "12px 12px",
                borderRadius: 12,
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              큐 참가 (데모)
            </button>

            <style>{`
              @keyframes pulse {
                0%, 100% { transform: scale(1); opacity: .55; }
                50% { transform: scale(1.4); opacity: 1; }
              }
            `}</style>
          </div>
        </div>
      </section>

      {/* 3-4) 메인: 사냥터 리스트/상세 */}
      <main style={{ ...card, gridColumn: "2", gridRow: "2", display: "grid", gridTemplateColumns: "420px 1fr" }}>
        {/* 3) 리스트 */}
        <section style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={cardHeader}>
            <div style={{ fontWeight: 800 }}>사냥터</div>
            <div style={muted}>사냥터 카드</div>
          </div>

          <div style={{ padding: 12, display: "grid", gap: 10, maxHeight: "calc(100vh - 72px - 140px - 14px*4)", overflow: "auto" }}>
            {filtered.map((g) => {
              const active = selected?.id === g.id;
              return (
                <button
                  key={g.id}
                  onClick={() => onSelectGround(g.id)}
                  style={{
                    textAlign: "left",
                    borderRadius: 14,
                    border: active ? "1px solid rgba(120,200,255,0.55)" : "1px solid rgba(255,255,255,0.10)",
                    background: active ? "rgba(120,200,255,0.10)" : "rgba(255,255,255,0.04)",
                    padding: 12,
                    cursor: "pointer",
                    color: "#e6e8ee",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>{g.name}</div>
                    <div style={muted}>{g.area}</div>
                  </div>
                  <div style={{ ...muted, marginTop: 6 }}>권장 레벨: {g.recommendedLevel}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {g.tags.slice(0, 4).map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 11,
                          padding: "4px 8px",
                          borderRadius: 999,
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.10)",
                          color: "rgba(230,232,238,0.9)",
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* 4) 상세 */}
        <section>
          <div style={cardHeader}>
            <div style={{ fontWeight: 900 }}>{selected?.name ?? "사냥터 선택"}</div>
            <div style={muted}>{selected?.recommendedLevel ?? ""}</div>
          </div>

          <div style={{ padding: 14, display: "grid", gap: 12 }}>
            <div style={{ ...card, background: "rgba(0,0,0,0.20)" }}>
              <div style={{ padding: 14, display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 900 }}>정보</div>
                    <div style={muted}>{selected?.area ?? ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 900 }}>현재 큐</div>
                    <div style={muted}>데모: {matchState === "searching" ? 5 : 2}명</div>
                  </div>
                </div>

                <div style={{ ...muted, lineHeight: 1.5 }}>{selected?.note ?? ""}</div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  {(selected?.tags ?? []).map((t) => (
                    <span
                      key={t}
                      style={{
                        fontSize: 13,
                        padding: "6px 10px",
                        borderRadius: 999,
                        background: "rgba(120,200,255,0.08)",
                        border: "1px solid rgba(120,200,255,0.18)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ ...card, background: "rgba(255,255,255,0.04)" }}>
                <div style={{ padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>파티 버프 (예정)</div>
                  <div style={muted}>심비 / 뻥비 / 샾비 항목을 파티에 실시간 공유 (다음 단계)</div>
                </div>
              </div>
              <div style={{ ...card, background: "rgba(255,255,255,0.04)" }}>
                <div style={{ padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>파티 유지 (예정)</div>
                  <div style={muted}>새로고침 후 재입장 유지 + 멤버 실시간 반영 (다음 단계)</div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => startMatching()}
                style={{
                  flex: 1,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(120,200,255,0.14)",
                  color: "#e6e8ee",
                  padding: "12px 12px",
                  borderRadius: 12,
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                이 사냥터로 큐 참가
              </button>
              <button
                onClick={() => alert("추후: 사냥터 등록/수정 UI")}
                style={{
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e8ee",
                  padding: "12px 12px",
                  borderRadius: 12,
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                사냥터 추가(예정)
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* 5) 우측 광고 */}
      <aside style={{ ...card, gridColumn: "3", gridRow: "2" }}>
        <div style={cardHeader}>
          <div style={{ fontWeight: 800 }}>광고 영역</div>
          <div style={muted}>5번</div>
        </div>
        <div style={{ padding: 14 }}>
          <div
            style={{
              height: "calc(100vh - 72px - 140px - 14px*4)",
              borderRadius: 14,
              border: "1px dashed rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.20)",
              display: "grid",
              placeItems: "center",
              color: "rgba(230,232,238,0.65)",
              textAlign: "center",
              padding: 14,
              boxSizing: "border-box",
            }}
          >
            <div>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>AD</div>
              <div style={muted}>여기에 광고/후원 배너</div>
            </div>
          </div>
        </div>
      </aside>

      {/* 6) 하단 광고 */}
      <footer style={{ ...card, gridColumn: "2 / span 2", gridRow: "3" }}>
        <div style={cardHeader}>
          <div style={{ fontWeight: 800 }}>광고 영역</div>
          <div style={muted}>6번</div>
        </div>
        <div style={{ padding: 14 }}>
          <div
            style={{
              height: 72,
              borderRadius: 14,
              border: "1px dashed rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.20)",
              display: "grid",
              placeItems: "center",
              color: "rgba(230,232,238,0.65)",
            }}
          >
            하단 배너 자리
          </div>
        </div>
      </footer>
    </div>
  );
}
