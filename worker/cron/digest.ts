/**
 * CRON_DIGEST(KST 08:30)가 부르는 진입점. 메시지 조립은 순수 함수(src/lib/digest.ts)에 맡기고,
 * 여기서는 D1 읽기 + 디스코드 채널 전송(재시도 포함)만 한다.
 *
 * scripts/notify.mjs(로컬 수동 실행, Slack/Discord 웹훅 대상)와 메시지 조립 로직은 같은
 * buildDigest를 공유한다. 전송 방식만 다르다 — Worker는 봇 토큰으로 채널에 직접 POST한다
 * (웹훅 URL을 따로 관리할 필요가 없다). worker/discord/discordApi.ts의 postChannelMessage를 쓴다.
 */

import { loadAll } from '../db/repo.ts';
import { buildDigest } from '../../src/lib/digest.ts';
import { postChannelMessage } from '../discord/discordApi.ts';

const MAX_RETRIES = 3;
const DISCORD_CONTENT_LIMIT = 2000;

function backoffMs(attempt: number): number {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Discord 메시지는 2000자 제한이 있다. 넘으면 잘라 보낸다(scripts/notify.mjs와 동일한 규칙). */
function truncateForDiscord(message: string): string {
  return message.length > DISCORD_CONTENT_LIMIT
    ? `${message.slice(0, DISCORD_CONTENT_LIMIT - 24)}\n…(길이 제한으로 생략됨)`
    : message;
}

/**
 * 최대 MAX_RETRIES회 지수 백오프로 재시도한다. 최종 실패해도 예외를 던지지 않는다 —
 * 알림 전송 실패는 크론 전체를 죽일 이유가 아니다(다음날 수집/다이제스트는 정상 동작해야 한다).
 * 대신 console.error로 명확히 남긴다 — 알림이 조용히 안 가는 게 제일 나쁘다.
 */
async function sendWithRetry(channelId: string, botToken: string, content: string): Promise<boolean> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await postChannelMessage(channelId, botToken, { content });
    if (result.ok) return true;

    lastStatus = result.status;
    if (attempt < MAX_RETRIES) {
      console.warn(
        `[cron:digest] 디스코드 전송 실패(시도 ${attempt}/${MAX_RETRIES}, status=${result.status}) — ${backoffMs(attempt)}ms 후 재시도합니다.`,
      );
      await sleep(backoffMs(attempt));
    }
  }
  console.error(
    `[cron:digest] 디스코드 전송이 ${MAX_RETRIES}회 재시도 후에도 실패했습니다(마지막 status=${lastStatus}). 알림이 나가지 않았습니다 — 확인이 필요합니다.`,
  );
  return false;
}

export interface SendDigestOptions {
  /** true면 메시지를 조립·로그만 하고 실제 전송은 하지 않는다. 로컬 테스트(`wrangler dev
   *  --test-scheduled`)에서 실제 채널에 글이 가는 걸 막기 위한 것 — 프로덕션에서는 절대 켜지
   *  않는다(env.CRON_DRY_RUN은 .dev.vars 전용, wrangler secret/vars에 넣지 않는다). */
  dryRun?: boolean;
  now?: Date;
}

export interface SendDigestResult {
  /** 실제로 전송했는지. dry-run이거나 보낼 내용이 없거나 전송이 최종 실패하면 false. */
  sent: boolean;
  /** 조립된 메시지. 보낼 게 없으면 null(오늘은 조용한 날). */
  message: string | null;
}

export async function sendDigest(env: Env, options: SendDigestOptions = {}): Promise<SendDigestResult> {
  const { programs, applications, documents, profile } = await loadAll(env.DB);
  const message = buildDigest(programs, applications, documents, profile, options.now ?? new Date());

  if (message === null) {
    console.log('[cron:digest] 오늘 보낼 다이제스트가 없습니다(급한 항목 없음) — 전송하지 않습니다.');
    return { sent: false, message: null };
  }

  if (options.dryRun) {
    console.log('[cron:digest] CRON_DRY_RUN — 조립된 메시지를 전송하지 않고 로그로만 남깁니다.');
    console.log(message);
    return { sent: false, message };
  }

  const sent = await sendWithRetry(env.DISCORD_CHANNEL_ID, env.DISCORD_BOT_TOKEN, truncateForDiscord(message));
  return { sent, message };
}
