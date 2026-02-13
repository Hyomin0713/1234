import type { ReactNode } from "react";

export const metadata = {
  title: "메랜큐",
  description: "메이플랜드 파티 공유/매칭"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Noto Sans KR, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
