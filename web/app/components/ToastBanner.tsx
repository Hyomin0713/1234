"use client";

import React from "react";

type Toast = { type: "ok" | "err" | "info"; msg: string };

type Props = {
  toast: Toast | null;
  onClose: () => void;
};

export function ToastBanner({ toast, onClose }: Props) {
  if (!toast) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
        padding: "10px 12px",
        borderRadius: 14,
        maxWidth: "min(520px, calc(100vw - 28px))",
        background:
          toast.type === "ok"
            ? "rgba(83, 242, 170, 0.14)"
            : toast.type === "err"
            ? "rgba(255, 120, 120, 0.14)"
            : "rgba(255, 255, 255, 0.10)",
        border:
          toast.type === "ok"
            ? "1px solid rgba(83, 242, 170, 0.35)"
            : toast.type === "err"
            ? "1px solid rgba(255, 120, 120, 0.35)"
            : "1px solid rgba(255,255,255,0.16)",
        color: "rgba(245,246,250,0.95)",
        boxShadow: "0 16px 40px rgba(0,0,0,0.35)",
        cursor: "pointer",
        userSelect: "none",
        fontWeight: 800,
        letterSpacing: 0.2,
      }}
      title="클릭하면 닫힘"
    >
      {toast.msg}
    </div>
  );
}
