export const metadata = {
  title: "메랜큐",
  description: "메이플랜드 사냥터 큐/파티 매칭",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Apple SD Gothic Neo, Noto Sans KR, sans-serif",
          background: "#0b0f19",
          color: "#e6e8ee",
        }}
      >
        {children}
      </body>
    </html>
  );
}
