/**
 * 디스코드 REST API 호출 — 지연 응답(defer) 후 원본 메시지를 편집할 때만 쓴다.
 * 인터랙션 토큰(interaction.token)은 그 인터랙션에 한정된 15분짜리 임시 토큰이라
 * 봇 토큰과 달리 이 URL에 넣어 호출해도 별도 Authorization 헤더가 필요 없다.
 *
 * ⚠️ 이 레포는 public이고 에러 로그가 GitHub Actions/Workers 로그로 남을 수 있다.
 * 아래 함수들은 실패 시에도 URL이나 토큰을 절대 로그에 남기지 않는다 — status 코드만 남긴다.
 */

const API_BASE = 'https://discord.com/api/v10';

/** 지연 응답(DEFERRED_*) 이후 "생각 중..." placeholder 메시지를 실제 내용으로 덮어쓴다. */
export async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`디스코드 원본 응답 편집 실패: status=${res.status}`);
  }
}
