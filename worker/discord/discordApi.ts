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

/**
 * 다이제스트처럼 Worker가 먼저 말을 거는 경우 쓰는 채널 REST 엔드포인트. 봇 토큰으로 직접 POST한다
 * (웹훅 URL을 따로 관리할 필요가 없다).
 *
 * ⚠️ User-Agent 헤더 없이 호출하면 Cloudflare가 빈 본문 403으로 막는다 — 실제로 겪은 문제라
 * 반드시 붙인다. Discord가 권장하는 `<봇 설명> (<URL>, <버전>)` 형식을 따른다.
 *
 * 실패해도 이 함수는 재시도하지 않고 status만 돌려준다 — 재시도 정책은 호출자(worker/cron/digest.ts)
 * 몫이다. 토큰이나 응답 본문은 절대 로그에 남기지 않는다.
 */
const USER_AGENT = 'DiscordBot (https://github.com/YDINP/grantboard, 1.0)';

export interface ChannelMessageResult {
  ok: boolean;
  status: number;
  /** 생성/편집에 성공했을 때만 채워진다(응답 바디 파싱 실패 시에도 ok/status는 그대로 믿을 수 있다). */
  messageId?: string;
}

/** 성공 응답 바디에서 메시지 id만 조심스럽게 뽑는다. 파싱 실패는 삼키고 messageId 없이 돌려준다. */
async function extractMessageId(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === 'string' ? body.id : undefined;
  } catch {
    return undefined;
  }
}

export async function postChannelMessage(
  channelId: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<ChannelMessageResult> {
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'content-type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, messageId: res.ok ? await extractMessageId(res) : undefined };
}

/**
 * 현황판처럼 "메시지 하나를 계속 갱신"하는 용도로 쓰는 채널 메시지 편집.
 * 사람이 그 메시지를 지웠으면 404가 온다 — 호출자(statusBoard.ts)가 이 status로 재생성 여부를 정한다.
 */
export async function patchChannelMessage(
  channelId: string,
  messageId: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<ChannelMessageResult> {
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'content-type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, messageId: res.ok ? await extractMessageId(res) : undefined };
}
