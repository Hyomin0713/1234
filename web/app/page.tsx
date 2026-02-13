export default function Page() {
  return (
    <main style={{ padding: 24 }}>
      <h1>메랜큐 (Railway 단일 도메인)</h1>
      <p>서버가 정적 파일을 서빙합니다. OAuth/파티 기능은 서버에서 제공합니다.</p>
      <p>
        <a href="/auth/discord">디스코드로 로그인</a>
      </p>
    </main>
  );
}
