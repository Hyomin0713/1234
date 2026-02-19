
"use client";

import { useEffect, useState } from "react";
import io from "socket.io-client";

type Me = {
  discordId: string;
  username: string;
  nickname?: string;
};

const socket = io();

export default function Page() {
  const [me, setMe] = useState<Me | null>(null);
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    fetch("/api/me")
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setMe(data);
          setNickname(data.nickname ?? "");
        }
      });
  }, []);

  const saveNickname = () => {
    socket.emit("queue:updateProfile", { nickname });
  };

  const joinQueue = () => {
    socket.emit("queue:join");
    setStatus("searching");
  };

  const leaveQueue = () => {
    socket.emit("queue:leave");
    setStatus("idle");
  };

  if (!me) {
    return (
      <div style={{ padding: 40 }}>
        <a href="/auth/discord">Login with Discord</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 40 }}>
      <div>
        <input
          value={nickname}
          onChange={e => setNickname(e.target.value)}
          placeholder="Nickname"
        />
        <button onClick={saveNickname}>Save</button>
      </div>

      <div style={{ marginTop: 20 }}>
        {status === "idle" && (
          <button onClick={joinQueue}>Start Matching</button>
        )}
        {status === "searching" && (
          <button onClick={leaveQueue}>Cancel</button>
        )}
      </div>

      <div style={{ marginTop: 20 }}>
        <button onClick={() => fetch("/api/logout", { method: "POST" }).then(() => location.reload())}>
          Logout
        </button>
      </div>
    </div>
  );
}
