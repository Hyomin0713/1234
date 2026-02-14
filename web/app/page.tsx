"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { ToastBanner } from "./components/ToastBanner";
import { DiscordAside } from "./components/DiscordAside";
import { SearchHeader } from "./components/SearchHeader";

type Job = "전사" | "도적" | "궁수" | "마법사";
type MatchState = "idle" | "searching" | "matched";
type QueueStatusPayload = { state: MatchState; channel?: string; message?: string; isLeader?: boolean; channelReady?: boolean; partyId?: string };
type MeResponse = { user: { id: string; username: string; global_name: string | null; avatar: string | null }; profile?: { displayName: string } | null };

type Toast = { type: "ok" | "err" | "info"; msg: string };

// Single-domain deploy: keep API calls same-origin by default.
// If you later split domains, set NEXT_PUBLIC_API_BASE and change this.
const API = process.env.NEXT_PUBLIC_API_BASE ?? "";


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

  // Lightweight toast (used by party list join etc.)
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

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

  // Settings modal (profile)
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 사용자 커스텀 사냥터(로컬 저장) — 나중에 사용자가 직접 추가/수정 가능
  const [customGrounds, setCustomGrounds] = useState<HuntingGround[]>([]);
  const [groundEditorOpen, setGroundEditorOpen] = useState(false);
  const [groundDraft, setGroundDraft] = useState<HuntingGround | null>(null);

  useEffect(() => {
    const saved = safeLocalGet("mlq.grounds.custom", [] as any);
    if (Array.isArray(saved)) {
      const cleaned: HuntingGround[] = saved
        .filter((x: any) => x && typeof x.id === "string" && typeof x.name === "string")
        .map((x: any) => ({
          id: String(x.id),
          name: String(x.name),
          area: String(x.area ?? ""),
          recommendedLevel: String(x.recommendedLevel ?? ""),
          tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)) : [],
          note: String(x.note ?? ""),
        }));
      setCustomGrounds(cleaned);
    }
  }, []);

  useEffect(() => {
    safeLocalSet("mlq.grounds.custom", customGrounds);
  }, [customGrounds]);

  const ALL_GROUNDS = useMemo(() => [...GROUNDS, ...customGrounds], [customGrounds]);

  // 7) 큐 정보
  const [level, setLevel] = useState(50);
  const [job, setJob] = useState<Job>("전사");
  const [power, setPower] = useState(12000);

  // Load saved profile (level/job/power/nickname)
  useEffect(() => {
    const saved = safeLocalGet("mlq.profile", null as any);
    if (saved && typeof saved === "object") {
      if (typeof saved.nickname === "string" && saved.nickname.trim()) setNickname(saved.nickname.trim());
      if (typeof saved.level === "number") setLevel(clampInt(String(saved.level), 1, 300));
      if (typeof saved.job === "string") setJob((saved.job as Job) ?? "전사");
      if (typeof saved.power === "number") setPower(clampInt(String(saved.power), 0, 9_999_999));
    }
  }, []);

  // Persist profile locally
  useEffect(() => {
    safeLocalSet("mlq.profile", { nickname, level, job, power });
  }, [nickname, level, job, power]);

  const [blackInput, setBlackInput] = useState("");
  const [blacklist, setBlacklist] = useState<string[]>(["포켓몬성능"]);

  // 매칭 상태
  const [matchState, setMatchState] = useState<MatchState>("idle");
  const [channel, setChannel] = useState<string>("");
  const [isLeader, setIsLeader] = useState(false);
  const [channelReady, setChannelReady] = useState(false);
  const [partyId, setPartyId] = useState<string>("");
  const [party, setParty] = useState<any | null>(null);

  // groundId -> active queue count (searching + matched)
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  // groundId -> EMA average wait time (ms)
  const [avgWaitMs, setAvgWaitMs] = useState<Record<string, number>>({});
  const [myBuffs, setMyBuffs] = useState<{ simbi: number; ppeongbi: number; syapbi: number }>({ simbi: 0, ppeongbi: 0, syapbi: 0 });
  const [channelLetter, setChannelLetter] = useState("A");
  const [channelNum, setChannelNum] = useState("001");
  const [joinCode, setJoinCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createLocked, setCreateLocked] = useState(false);
  const [createPassword, setCreatePassword] = useState("");

  const [partyList, setPartyList] = useState<any[]>([]);

  const normalizeKey = (s: any) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

  const fmtNumber = (n: any) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "-";
    return Math.max(0, Math.floor(v)).toLocaleString();
  };


  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_GROUNDS;
    return ALL_GROUNDS.filter((g) => {
      const blob = `${g.name} ${g.area} ${g.recommendedLevel} ${g.tags.join(" ")} ${g.note}`.toLowerCase();
      return blob.includes(q);
    });
  }, [query, ALL_GROUNDS]);

  const selected = useMemo(
    () => ALL_GROUNDS.find((g) => g.id === selectedId) ?? filtered[0] ?? ALL_GROUNDS[0],
    [selectedId, filtered, ALL_GROUNDS]
  );

  const partiesForSelected = useMemo(() => {
    if (!selected?.name) return partyList;
    // Prefer exact matching by groundId when server provides it; fallback to title includes for older parties.
    return partyList.filter((p) => {
      const pid = String(p?.groundId ?? "");
      if (pid && pid === selectedId) return true;
      const key = normalizeKey(selected.name);
      if (!key) return true;
      return normalizeKey(p?.title).includes(key);
    });
  }, [partyList, selected, selectedId]);

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

  const getSid = () => {
    if (typeof window === "undefined") return "";
    return window.location.hash.startsWith("#sid=") ? decodeURIComponent(window.location.hash.slice("#sid=".length)) : "";
  };

  const emitProfile = (s: Socket | null) => {
    if (!s) return;
    if (!isLoggedIn) return;
    s.emit("queue:updateProfile", {
      displayName: nickname.trim() || discordName,
      level,
      job,
      power,
    });
  };

  // When login state becomes available, push latest profile to server (for party member snapshot)
  useEffect(() => {
    if (!isLoggedIn) return;
    emitProfile(socketRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);
  const [sockConnected, setSockConnected] = useState(false);

  const isCustomSelected = useMemo(() => selectedId.startsWith("c_"), [selectedId]);

  const openNewGround = () => {
    const id = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setGroundDraft({ id, name: "", area: "", recommendedLevel: "", tags: [], note: "" });
    setGroundEditorOpen(true);
  };

  const openEditGround = () => {
    const g = customGrounds.find((x) => x.id === selectedId);
    if (!g) return;
    setGroundDraft({ ...g, tags: [...(g.tags ?? [])] });
    setGroundEditorOpen(true);
  };

  const saveGroundDraft = () => {
    if (!groundDraft) return;
    const name = groundDraft.name.trim();
    if (!name) return;
    const cleaned: HuntingGround = {
      ...groundDraft,
      name,
      area: (groundDraft.area ?? "").trim(),
      recommendedLevel: (groundDraft.recommendedLevel ?? "").trim(),
      tags: (groundDraft.tags ?? []).map((t) => t.trim()).filter(Boolean),
      note: (groundDraft.note ?? "").trim(),
    };
    setCustomGrounds((prev) => {
      const idx = prev.findIndex((x) => x.id === cleaned.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = cleaned;
        return next;
      }
      return [cleaned, ...prev];
    });
    setSelectedId(cleaned.id);
    setGroundEditorOpen(false);
    setGroundDraft(null);
  };

  const deleteSelectedGround = () => {
    if (!isCustomSelected) return;
    setCustomGrounds((prev) => prev.filter((x) => x.id !== selectedId));
    // move selection to first item
    const next = GROUNDS[0]?.id ?? "";
    setSelectedId(next);
  };


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

    sck.on("connect", () => {
      setSockConnected(true);
      emitProfile(sck);
    });
    sck.on("disconnect", () => setSockConnected(false));

    sck.on("queue:status", (p: QueueStatusPayload) => {
      if (!p) return;
      setMatchState(p.state);
      setChannel(p.channel ?? "");
      setIsLeader(!!p.isLeader);
      setChannelReady(!!p.channelReady);
      setPartyId(p.partyId ?? "");
    });

    sck.on("partyUpdated", (payload: any) => {
      if (!payload?.party) return;
      setParty(payload.party);
    });

    sck.on("partiesUpdated", (payload: any) => {
      if (!payload?.parties) return;
      setPartyList(payload.parties);
    });

    sck.on("queue:counts", (payload: any) => {
      const counts = payload?.counts;
      if (!counts || typeof counts !== "object") return;
      setQueueCounts(counts as Record<string, number>);
      const nextAvg = payload?.avgWaitMs;
      if (nextAvg && typeof nextAvg === "object") setAvgWaitMs(nextAvg as Record<string, number>);
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
    // restore last known party (best-effort). This only affects UI; membership is still server-side.
    const saved = safeLocalGet<string>("mlq.partyId", "") as string;
    if (saved && !partyId) setPartyId(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshParties();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sck = socketRef.current;
    if (!sck) return;
    if (!partyId) return;
    safeLocalSet("mlq.partyId", partyId);
    sck.emit("joinPartyRoom", { partyId });
  }, [partyId]);

  useEffect(() => {
    const sck = socketRef.current;
    if (!sck) return;
    if (!sockConnected) return;
    if (!partyId) return;

    // Party heartbeat: keep membership alive across refresh / transient disconnects
    const beat = () => sck.emit("party:heartbeat", { partyId });
    beat();
    const t = setInterval(beat, 25_000);
    return () => clearInterval(t);
  }, [partyId, sockConnected]);

  useEffect(() => {
    // keep my buffs input in sync when party updates
    if (!party || !me) return;
    const my = (party.members ?? []).find((m: any) => m.userId === me.user.id);
    if (!my) return;
    setMyBuffs({
      simbi: Number(my.buffs?.simbi ?? 0),
      ppeongbi: Number(my.buffs?.ppeongbi ?? 0),
      syapbi: Number(my.buffs?.syapbi ?? 0),
    });
  }, [party, me]);

  useEffect(() => {
    // keep server updated when user edits
    const sck = socketRef.current;
    if (!sck) return;
    if (!sockConnected) return;
    sck.emit("queue:updateProfile", { nickname, level, job, power, blacklist });
  }, [nickname, level, job, power, blacklist, sockConnected]);


  const pushMyBuffs = async (next: { simbi: number; ppeongbi: number; syapbi: number }) => {
    if (!partyId) return;
    try {
      const sid = getSid();
      await fetch("/api/party/buffs", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(sid ? { "x-ml-session": sid } : {}),
        },
        body: JSON.stringify({ partyId, buffs: next }),
      });
    } catch {}
  };

  const joinPartyByCode = async () => {
    const code = joinCode.trim();
    if (!code) return;
    try {
      const sid = getSid();
      const res = await fetch("/api/party/join", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(sid ? { "x-ml-session": sid } : {}),
        },
        body: JSON.stringify({ partyId: code, lockPassword: joinPassword.trim() || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const pid = String(data?.party?.id ?? "");
      if (!pid) throw new Error("INVALID_RESPONSE");
      setPartyId(pid);
      safeLocalSet("mlq.partyId", pid);
      setJoinPassword("");
      setJoinCode("");
    } catch (e: any) {
      alert(`파티 입장 실패: ${e?.message ?? e}`);
    }
  };

  const joinPartyDirect = async (partyId: string, lockPassword?: string) => {
    if (!partyId) return;
    try {
      setToast(null);
      const sid = getSid();
      const res = await fetch(`${API}/api/party/join`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(sid ? { "x-ml-session": sid } : {}),
        },
        body: JSON.stringify({ partyId, lockPassword: lockPassword || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "파티 참가 실패");
      const pid = String(data?.party?.id ?? "");
      if (!pid) throw new Error("INVALID_RESPONSE");
      setPartyId(pid);
      safeLocalSet("mlq.partyId", pid);
      setToast({ type: "ok", msg: "파티에 참가했습니다." });
    } catch (e: any) {
      setToast({ type: "err", msg: e?.message || "파티 참가 실패" });
    }
  };

  const joinFromList = async (p: any) => {
    if (!p?.id) return;
    if (p.isLocked) {
      const pw = window.prompt("이 파티는 잠금 상태입니다. 비밀번호를 입력하세요.");
      if (pw === null) return;
      await joinPartyDirect(p.id, pw);
      return;
    }
    await joinPartyDirect(p.id);
  };

  const refreshParties = async () => {
    try {
      const res = await fetch(`${API}/api/parties`);
      const data = await res.json();
      if (data?.parties) setPartyList(data.parties);
    } catch {
      // ignore
    }
  };

  const createPartyManual = async () => {
    try {
      const autoTitle = selected?.name ? `${selected.name} 파티` : "파티";
      const title = (createTitle || autoTitle).trim();
      const pw = createLocked ? createPassword.trim() : "";
      if (createLocked && pw.length < 2) {
        alert("비밀번호는 2글자 이상으로 설정해줘.");
        return;
      }
      const sid = getSid();
      const res = await fetch("/api/party", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(sid ? { "x-ml-session": sid } : {}),
        },
        body: JSON.stringify({ title, lockPassword: createLocked ? pw : undefined, groundId: selectedId || undefined, groundName: selected?.name || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const pid = String(data?.party?.id ?? "");
      if (!pid) throw new Error("INVALID_RESPONSE");
      setPartyId(pid);
      safeLocalSet("mlq.partyId", pid);
      setCreateTitle("");
      setCreatePassword("");
      setCreateLocked(false);
    } catch (e: any) {
      alert(`파티 생성 실패: ${e?.message ?? e}`);
    }
  };
  const joinQueue = () => {
    const sck = socketRef.current;
    if (!sck) return;
    setMatchState("searching");
    setChannel("");
    setIsLeader(false);
    setChannelReady(false);
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
    setIsLeader(false);
    setChannelReady(false);
  };

  function setChannelByLeader() {
    const sck = socketRef.current;
    if (!sck) return;
    if (!isLeader) return;
    if (matchState !== "matched") return;
    sck.emit("queue:setChannel", { letter: channelLetter, num: channelNum });
  }

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

    // 중복 클릭 방지
    if (matchState === "searching") return;

    // 지금은 OAuth 연동 전이므로, 로그인 여부와 무관하게 큐 참여는 가능하게 둠
    joinQueue();
  }

  function rematch() {
    // 한번 빠졌다가 재참가
    leaveQueue();
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

  const chip: React.CSSProperties = {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "rgba(230,232,238,0.92)",
    fontWeight: 800,
    letterSpacing: 0.2,
    display: "inline-flex",
    alignItems: "center",
    lineHeight: 1,
  };

  const input: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.22)",
    color: "rgba(245,246,250,0.95)",
    outline: "none",
    fontSize: 13,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
  };

  const modalOverlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.62)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    zIndex: 50,
  };

  const modalCard: React.CSSProperties = {
    width: "min(720px, 100%)",
    background: "rgba(14,18,30,0.98)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 18,
    boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    padding: 16,
  };

  const modalTitle: React.CSSProperties = {
    fontWeight: 900,
    fontSize: 16,
    marginBottom: 10,
  };

  const formRow: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  };

  const label: React.CSSProperties = { fontSize: 12, color: "rgba(230,232,238,0.75)", marginBottom: 6 };




  const btn: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#e6e8ee",
    padding: "8px 10px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 13,
  };

  const btnSmall: React.CSSProperties = {
    ...btn,
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: 850,
  };

  const btnSm: React.CSSProperties = btnSmall;

  const btnPrimary: React.CSSProperties = {
    ...btn,
    background: "rgba(120,200,255,0.14)",
    borderColor: "rgba(120,200,255,0.35)",
  };

  const listCard: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 14,
    padding: 12,
  };

  const pill: React.CSSProperties = {
    ...chip,
    padding: "3px 8px",
    fontSize: 11,
  };

  const formGrid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginTop: 12,
    marginBottom: 12,
  };
  return (
    <div style={shell}>
      <ToastBanner toast={toast} onClose={() => setToast(null)} />

      {/* 1) 디스코드 */}
      <DiscordAside
        isLoggedIn={isLoggedIn}
        discordName={discordName}
        discordTag={discordTag}
        onLogin={() => (window.location.href = "/auth/discord")}
        onLogout={async () => {
          try {
            await fetch("/api/logout", { method: "POST", credentials: "include" });
          } catch {}
          window.location.reload();
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        muted={muted}
        card={card}
        cardHeader={cardHeader}
      />

      {/* 2) 사냥터 검색 */}
      <SearchHeader
        query={query}
        onChangeQuery={setQuery}
        countText={`${filtered.length}개`}
        muted={muted}
        card={card}
        cardHeader={cardHeader}
      />

      {/* 7) 큐 정보 (우상단) */}
      <section style={{ ...card, gridColumn: "3", gridRow: "1", display: "flex", flexDirection: "column" }}>
        <div style={{ ...cardHeader, alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontWeight: 800 }}>큐 정보</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>레벨/직업/스공/블랙리스트가 매칭 조건에 반영됩니다.</div>
          </div>
          <div style={{ ...muted, marginLeft: "auto" }}>
            {matchState === "idle"
              ? "대기"
              : matchState === "searching"
              ? (() => {
                  const n = queueCounts[selectedId] ?? 0;
                  const eta = avgWaitMs[selectedId];
                  const etaMin = typeof eta === "number" && eta > 0 ? Math.max(1, Math.round(eta / 60000)) : 0;
                  return `매칭중${".".repeat(dotTick)} · 현재 ${n}명${etaMin ? ` · 예상 ${etaMin}분` : ""}`;
                })()
              : `완료 (${channel || "채널 발급"})`}
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
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: "rgba(255,255,255,0.65)",
                      animation: "pulse 1.2s ease-in-out infinite",
                      boxShadow: "0 0 0 1px rgba(255,255,255,0.10)",
                    }}
                  />
                  <div style={{ fontWeight: 850, letterSpacing: 0.2 }}>{`매칭중입니다${".".repeat(dotTick)}`}</div>
                </div>

                {/* 롤처럼 ‘기다리는 느낌’만 주는 인디케이터 */}
                <div
                  style={{
                    height: 8,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.10)",
                    overflow: "hidden",
                    position: "relative",
                    maxWidth: 260,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "45%",
                      borderRadius: 999,
                      background: "rgba(120,200,255,0.20)",
                      borderRight: "1px solid rgba(120,200,255,0.35)",
                      animation: "mlqIndeterminate 1.35s ease-in-out infinite",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background:
                        "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0) 100%)",
                      animation: "mlqSweep 1.8s linear infinite",
                      opacity: 0.6,
                    }}
                  />
                </div>
              </div>
            )}

            {matchState === "matched" && (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>매칭완료!</div>
                {channel ? (
                  <div style={{ ...muted, fontSize: 13 }}>
                    채널은 <span style={{ fontWeight: 900, color: "rgba(255,255,255,0.92)" }}>{channel}</span> 입니다.
                  </div>
                ) : (
                  <div style={{ ...muted, fontSize: 13 }}>채널 설정중… (파티장이 설정하면 바로 표시됩니다)</div>
                )}
                {partyId ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ ...chip, background: "rgba(83, 242, 170, 0.12)", borderColor: "rgba(83, 242, 170, 0.35)" }}>
                      방 코드
                    </div>
                    <div style={{ fontWeight: 900, letterSpacing: 0.6 }}>{partyId}</div>
                    <button
                      onClick={() => {
                        try {
                          navigator.clipboard.writeText(partyId);
                        } catch {}
                      }}
                      style={{
                        border: "1px solid rgba(255,255,255,0.14)",
                        background: "rgba(255,255,255,0.08)",
                        color: "#e6e8ee",
                        padding: "8px 10px",
                        borderRadius: 12,
                        cursor: "pointer",
                        fontWeight: 900,
                      }}
                    >
                      복사
                    </button>
                  </div>
                ) : null}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>파티 코드로 입장 / 생성</div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        style={{ ...input, flex: 1 }}
                        placeholder="파티 코드 입력 (예: ABCD-1234)"
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value)}
                      />
                      <button style={{ ...btnSmall, whiteSpace: "nowrap" }} onClick={joinPartyByCode}>
                        입장
                      </button>
                    </div>
                    <input
                      style={input}
                      placeholder="비밀번호(필요 시)"
                      value={joinPassword}
                      onChange={(e) => setJoinPassword(e.target.value)}
                    />

                    <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

                    <input
                      style={input}
                      placeholder="새 파티 제목 (선택)"
                      value={createTitle}
                      onChange={(e) => setCreateTitle(e.target.value)}
                    />

                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "rgba(230,232,238,0.9)" }}>
                      <input type="checkbox" checked={createLocked} onChange={(e) => setCreateLocked(e.target.checked)} />
                      비공개(비밀번호)
                    </label>

                    {createLocked ? (
                      <input
                        style={input}
                        placeholder="새 파티 비밀번호"
                        value={createPassword}
                        onChange={(e) => setCreatePassword(e.target.value)}
                      />
                    ) : null}

                    <button style={{ ...btn, width: "100%" }} onClick={createPartyManual}>
                      파티 만들기
                    </button>

                    <div style={{ ...muted, marginTop: 4 }}>
                      • 파티장이 비공개로 만든 파티는 비밀번호가 필요해요.
                    </div>
                  </div>
                </div>

                {channelReady ? (
                  <div style={{ fontWeight: 800 }}>채널은 {channel} 입니다.</div>
                ) : isLeader ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ fontWeight: 800 }}>채널 설정</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <select
                        value={channelLetter}
                        onChange={(e) => setChannelLetter(e.target.value)}
                        style={{
                          padding: "10px 10px",
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.16)",
                          background: "rgba(0,0,0,0.28)",
                          color: "#e6e8ee",
                          fontWeight: 900,
                        }}
                      >
                        {Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <select
                        value={channelNum}
                        onChange={(e) => setChannelNum(e.target.value)}
                        style={{
                          padding: "10px 10px",
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.16)",
                          background: "rgba(0,0,0,0.28)",
                          color: "#e6e8ee",
                          fontWeight: 900,
                        }}
                      >
                        {Array.from({ length: 999 }, (_, i) => String(i + 1).padStart(3, "0")).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={setChannelByLeader}
                        style={{
                          border: "1px solid rgba(255,255,255,0.14)",
                          background: "rgba(255,220,120,0.14)",
                          color: "#e6e8ee",
                          padding: "10px 12px",
                          borderRadius: 12,
                          cursor: "pointer",
                          fontWeight: 900,
                        }}
                      >
                        채널 확정
                      </button>
                    </div>
                    <div style={{ ...muted }}>파티장은 게임 내 채널을 선택해 주세요.</div>
                  </div>
                ) : (
                  <div style={{ ...muted, fontWeight: 700 }}>파티장이 채널을 설정중입니다…</div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
              {matchState === "idle" && (
                <button
                  onClick={startMatching}
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
                  큐 참가
                </button>
              )}

              {matchState === "searching" && (
                <button
                  onClick={leaveQueue}
                  style={{
                    flex: 1,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(255,120,120,0.12)",
                    color: "#e6e8ee",
                    padding: "12px 12px",
                    borderRadius: 12,
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                >
                  큐 취소
                </button>
              )}

              {matchState === "matched" && (
                <>
                  <button
                    onClick={rematch}
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
                    다시 매칭
                  </button>
                  <button
                    onClick={leaveQueue}
                    style={{
                      border: "1px solid rgba(255,255,255,0.14)",
                      background: "rgba(255,120,120,0.12)",
                      color: "#e6e8ee",
                      padding: "12px 12px",
                      borderRadius: 12,
                      cursor: "pointer",
                      fontWeight: 900,
                      minWidth: 110,
                    }}
                  >
                    나가기
                  </button>
                </>
              )}
            </div>

            <div style={{ ...muted, marginTop: 8 }}>
              {matchState === "idle" && "큐 참가하면 매칭이 시작됩니다."}
              {matchState === "searching" &&
                (() => {
                  const n = queueCounts[selectedId] ?? 0;
                  const eta = avgWaitMs[selectedId];
                  const etaMin = typeof eta === "number" && eta > 0 ? Math.max(1, Math.round(eta / 60000)) : 0;
                  const etaText = etaMin ? ` · 예상 ${etaMin}분` : "";
                  return n >= 2
                    ? `찾는 중… (현재 ${n}명${etaText}) 마음이 바뀌면 ‘큐 취소’ 가능.`
                    : `대기 인원이 부족합니다. (현재 ${n}명)`;
                })()}
              {matchState === "matched" && "채널 확인 후, 필요하면 ‘다시 매칭’도 가능."}
            </div>

            <style>{`
              @keyframes pulse {
                0%, 100% { transform: scale(1); opacity: .55; }
                50% { transform: scale(1.4); opacity: 1; }
              }

              @keyframes mlqIndeterminate {
                0% { transform: translateX(-110%); }
                50% { transform: translateX(40%); }
                100% { transform: translateX(210%); }
              }

              @keyframes mlqSweep {
                0% { transform: translateX(-30%); }
                100% { transform: translateX(30%); }
              }
            `}</style>
          </div>
        </div>
      </section>

      {/* 3-4) 메인: 사냥터 리스트/상세 */}
      <main style={{ ...card, gridColumn: "2", gridRow: "2", display: "grid", gridTemplateColumns: "420px 1fr" }}>
        {/* 3) 리스트 */}
        <section style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ ...cardHeader, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 800 }}>사냥터</div>
              <div style={muted}>사냥터 카드</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                style={btn}
                onClick={openNewGround}
                title="내 사냥터 추가(로컬 저장)"
              >
                + 추가
              </button>
              {isCustomSelected ? (
                <>
                  <button style={btn} onClick={openEditGround}>
                    수정
                  </button>
                  <button style={{ ...btn, borderColor: "rgba(255, 120, 120, 0.35)", background: "rgba(255, 120, 120, 0.08)" }} onClick={deleteSelectedGround}>
                    삭제
                  </button>
                </>
              ) : null}
            </div>
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
        
        {/* 공개 파티는 중앙 상세 영역에 표시 (사냥터 선택 시 필터링) */}
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
                    <div style={muted}>{(queueCounts[selected?.id ?? ""] ?? 0)}명</div>
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

            <div style={{ ...card, background: "rgba(255,255,255,0.03)" }}>
              <div style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontWeight: 900 }}>공개 파티</div>
                  <button
                    onClick={refreshParties}
                    style={{ ...btnSm, background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.12)" }}
                    title="파티 목록 새로고침"
                  >
                    새로고침
                  </button>
                </div>
                <div style={{ ...muted, marginTop: 6 }}>
                  {selected?.name ? (
                    <>선택한 사냥터(<b>{selected.name}</b>)의 공개 파티만 표시합니다. (제목 기준 필터)</>
                  ) : (
                    <>사냥터를 선택하면 해당 사냥터의 공개 파티가 여기 표시됩니다.</>
                  )}
                </div>

                <div style={{ marginTop: 10, display: "grid", gap: 10, maxHeight: 240, overflow: "auto" }}>
                  {(selected?.name ? partiesForSelected : partyList).length === 0 ? (
                    <div style={muted}>현재 공개된 파티가 없습니다.</div>
                  ) : (
                    (selected?.name ? partiesForSelected : partyList)
                      .slice(0, 12)
                      .map((p: any) => (
                        <div key={p.id} style={{ ...listCard, borderColor: "rgba(255,255,255,0.12)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                            <div style={{ fontWeight: 850, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                              <div
                                style={{
                                  ...pill,
                                  background: p.isLocked ? "rgba(255, 214, 102, 0.14)" : "rgba(83, 242, 170, 0.12)",
                                  borderColor: p.isLocked ? "rgba(255, 214, 102, 0.35)" : "rgba(83, 242, 170, 0.35)",
                                }}
                              >
                                {p.isLocked ? "잠금" : "공개"}
                              </div>
                              <div style={pill}>{p.memberCount}/6</div>
                            </div>
                          </div>

                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginTop: 8 }}>
                            <div style={muted}>방 코드: {String(p.id).slice(0, 8).toUpperCase()}</div>
                            <button onClick={() => joinFromList(p)} style={btnSm}>
                              참가
                            </button>
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ ...card, background: "rgba(255,255,255,0.04)" }}>
                <div style={{ padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>파티 버프</div>
                    {partyId ? <div style={{ ...chip, opacity: 0.9 }}>방장코드: <span style={{ fontWeight: 900, marginLeft: 6 }}>{partyId}</span></div> : <div style={muted}>파티 없음</div>}
                  </div>

                  {party ? (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.7fr 0.7fr 0.7fr", gap: 8, fontSize: 12, color: "rgba(230,232,238,0.7)", marginBottom: 8 }}>
                        <div>멤버</div>
                        <div style={{ textAlign: "center" }}>심비</div>
                        <div style={{ textAlign: "center" }}>뻥비</div>
                        <div style={{ textAlign: "center" }}>샾비</div>
                      </div>

                      {[...(party.members ?? [])].sort((a: any, b: any) => (a.userId === party.ownerId ? -1 : b.userId === party.ownerId ? 1 : 0)).map((m: any) => {
                        const isMe = me && m.userId === me.user.id;
                        return (
                          <div key={m.memberId} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.7fr 0.7fr 0.7fr", gap: 8, alignItems: "center", marginBottom: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 10, height: 10, borderRadius: 999, background: isMe ? "rgba(83, 242, 170, 0.85)" : "rgba(255,255,255,0.25)" }} />
                              <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                  <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.displayName}</div>
                                  {party.ownerId === m.userId ? (
                                    <div style={{ ...chip, padding: "2px 8px", fontSize: 11, opacity: 0.95, display: "flex", alignItems: "center", gap: 4 }}>
                                      <span>👑</span>
                                      <span>방장</span>
                                    </div>
                                  ) : null}
                                  {isMe ? <div style={{ ...chip, padding: "2px 8px", fontSize: 11, opacity: 0.8 }}>나</div> : null}
                                </div>
                                <div style={{ fontSize: 12, color: "rgba(230,232,238,0.72)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  Lv. {m.level ?? "-"} · {m.job ?? "-"} · 스공 {fmtNumber(m.power)}
                                </div>
                              </div>
                            </div>

                            {isMe ? (
                              <>
                                <input
                                  style={{ ...input, textAlign: "center" }}
                                  inputMode="numeric"
                                  value={String(myBuffs.simbi)}
                                  onChange={(e) => {
                                    const v = Math.max(0, Math.min(999, Number(e.target.value.replace(/[^0-9]/g, "")) || 0));
                                    const next = { ...myBuffs, simbi: v };
                                    setMyBuffs(next);
                                    pushMyBuffs(next);
                                  }}
                                />
                                <input
                                  style={{ ...input, textAlign: "center" }}
                                  inputMode="numeric"
                                  value={String(myBuffs.ppeongbi)}
                                  onChange={(e) => {
                                    const v = Math.max(0, Math.min(999, Number(e.target.value.replace(/[^0-9]/g, "")) || 0));
                                    const next = { ...myBuffs, ppeongbi: v };
                                    setMyBuffs(next);
                                    pushMyBuffs(next);
                                  }}
                                />
                                <input
                                  style={{ ...input, textAlign: "center" }}
                                  inputMode="numeric"
                                  value={String(myBuffs.syapbi)}
                                  onChange={(e) => {
                                    const v = Math.max(0, Math.min(999, Number(e.target.value.replace(/[^0-9]/g, "")) || 0));
                                    const next = { ...myBuffs, syapbi: v };
                                    setMyBuffs(next);
                                    pushMyBuffs(next);
                                  }}
                                />
                              </>
                            ) : (
                              <>
                                <div style={{ ...chip, justifyContent: "center" }}>{m.buffs?.simbi ?? 0}</div>
                                <div style={{ ...chip, justifyContent: "center" }}>{m.buffs?.ppeongbi ?? 0}</div>
                                <div style={{ ...chip, justifyContent: "center" }}>{m.buffs?.syapbi ?? 0}</div>
                              </>
                            )}
                          </div>
                        );
                      })}

                      <div style={muted}>내 버프만 수정 가능하며, 변경 즉시 파티에 공유됩니다.</div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, ...muted }}>매칭/파티 참여 후 자동으로 표시됩니다.</div>
                  )}
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

      {/* 사냥터 추가/수정 (커스텀 사냥터 에디터) */}
      {groundEditorOpen && groundDraft ? (
        <div
          style={modalOverlay}
          onClick={() => {
            setGroundEditorOpen(false);
            setGroundDraft(null);
          }}
        >
          <div
            style={modalCard}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div style={modalTitle}>
              <div style={{ fontWeight: 900 }}>
                {groundDraft.id.startsWith("c_") ? "사냥터 편집" : "사냥터"}
              </div>
              <div style={muted}>커스텀 사냥터 정보</div>
            </div>

            <div style={{ padding: 14 }}>
              <div style={formRow}>
                <div style={label}>이름</div>
                <input
                  style={input}
                  value={groundDraft.name}
                  placeholder="예: 와일드보어의 땅"
                  onChange={(e) => setGroundDraft({ ...groundDraft, name: e.target.value })}
                />
              </div>

              <div style={formRow}>
                <div style={label}>지역/맵</div>
                <input
                  style={input}
                  value={groundDraft.area ?? ""}
                  placeholder="예: 페리온"
                  onChange={(e) => setGroundDraft({ ...groundDraft, area: e.target.value })}
                />
              </div>

              <div style={formRow}>
                <div style={label}>권장 레벨</div>
                <input
                  style={input}
                  value={groundDraft.recommendedLevel ?? ""}
                  placeholder="예: 35~45"
                  onChange={(e) => setGroundDraft({ ...groundDraft, recommendedLevel: e.target.value })}
                />
              </div>

              <div style={formRow}>
                <div style={label}>태그 (쉼표로 구분)</div>
                <input
                  style={input}
                  value={(groundDraft.tags ?? []).join(", ")}
                  placeholder="예: 자리좋음, 2층, 리젠좋음"
                  onChange={(e) =>
                    setGroundDraft({
                      ...groundDraft,
                      tags: e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>

              <div style={formRow}>
                <div style={label}>메모</div>
                <textarea
                  style={{ ...input, minHeight: 90, resize: "vertical" as const }}
                  value={groundDraft.note ?? ""}
                  placeholder="추가 메모"
                  onChange={(e) => setGroundDraft({ ...groundDraft, note: e.target.value })}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
                <button
                  style={btn}
                  onClick={() => {
                    setGroundEditorOpen(false);
                    setGroundDraft(null);
                  }}
                >
                  취소
                </button>
                <button style={{ ...btnPrimary, padding: "10px 14px" }} onClick={saveGroundDraft}>
                  저장
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Settings Modal: 레벨/직업/스공 설정 (로그아웃 옆 ⚙) */}
      {settingsOpen ? (
        <div
          onClick={() => setSettingsOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.60)",
            display: "grid",
            placeItems: "center",
            zIndex: 90,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(520px, 96vw)",
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(18,18,22,0.98)",
              boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
              padding: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>프로필 설정</div>
              <div style={{ marginLeft: "auto", ...muted, fontSize: 12 }}>매칭/파티에 반영</div>
            </div>

            <div style={{ ...muted, marginTop: 6, fontSize: 12 }}>
              레벨/직업/스공은 <b>큐 참가</b>와 <b>파티 멤버 정보</b>에 표시돼요.
            </div>

            <div style={formGrid}>
              <div style={formRow}>
                <div style={label}>닉네임</div>
                <input
                  style={input}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder={discordName}
                />
              </div>

              <div style={formRow}>
                <div style={label}>레벨</div>
                <input
                  style={input}
                  value={String(level)}
                  inputMode="numeric"
                  onChange={(e) => setLevel(clampInt(e.target.value, 1, 300))}
                  placeholder="1~300"
                />
              </div>

              <div style={formRow}>
                <div style={label}>직업</div>
                <select style={input} value={job} onChange={(e) => setJob(e.target.value as Job)}>
                  <option value="전사">전사</option>
                  <option value="도적">도적</option>
                  <option value="궁수">궁수</option>
                  <option value="마법사">마법사</option>
                </select>
              </div>

              <div style={formRow}>
                <div style={label}>스공</div>
                <input
                  style={input}
                  value={String(power)}
                  inputMode="numeric"
                  onChange={(e) => setPower(clampInt(e.target.value, 0, 9_999_999))}
                  placeholder="0~9,999,999"
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              <button style={btn} onClick={() => setSettingsOpen(false)}>
                닫기
              </button>
              <button
                style={{ ...btnPrimary, padding: "10px 14px" }}
                onClick={() => {
                  emitProfile(socketRef.current);
                  setToast({ type: "ok", msg: "프로필이 저장되었습니다." });
                  setSettingsOpen(false);
                }}
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
