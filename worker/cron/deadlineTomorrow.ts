/**
 * CRON_DEADLINE_TOMORROW(KST 12:00)가 부르는 진입점. "내일(D-1) 마감인데 아직 할 일이 남은 공고"만
 * 골라 @here로 알린다. 08:30 다이제스트(worker/cron/digest.ts)와 역할을 분리한다 —
 * 08:30은 D-day(오늘 마감)에만 @here를 울리고(src/lib/digest.ts의 shouldMentionHere), D-1은 이
 * 알림이 전담한다. 같은 건으로 하루 두 번 멘션하면 알림 피로로 채널을 음소거하게 된다.
 *
 * 무엇을 담을지(selectDeadlineTomorrow)는 순수 함수(src/lib/deadlineTomorrow.ts)에 맡기고,
 * 여기서는 Discord embed 조립 + D1 읽기 + 채널 전송(재시도 포함)만 한다 — worker/cron/digest.ts와
 * 구조를 맞춘다(스레드 생성은 하지 않는다 — 이 알림은 08:30 다이제스트만큼 토론거리가 되지 않는다).
 */

import { loadAll } from '../db/repo.ts';
import { selectDeadlineTomorrow } from '../../src/lib/deadlineTomorrow.ts';
import { isLinkable } from '../../src/lib/format.ts';
import { addDays, kstDateParts } from '../../src/lib/schedule.ts';
import type { ProgramView } from '../../src/lib/board.ts';
import { postChannelMessage } from '../discord/discordApi.ts';
import { TONE_COLOR, type DiscordEmbed } from '../discord/embeds.ts';
import { CALENDAR_URL } from '../discord/statusBoard.ts';

const MAX_RETRIES = 3;
/** Discord embed description 상한(4096자). worker/cron/digest.ts와 같은 값 — 플랫폼 제약이지
 *  둘이 같은 의미를 공유하는 상수는 아니라서 따로 둔다. */
const EMBED_DESCRIPTION_LIMIT = 4096;

function backoffMs(attempt: number): number {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** owner 필드를 가진 항목 목록에서 중복 없는 담당자 표시 문자열을 만든다. 비어 있으면 '담당자 미지정'. */
function ownersOf(items: { application: { owner: string } }[]): string {
  if (items.length === 0) return '담당자 미지정';
  return [...new Set(items.map((i) => i.application.owner))].join(', ');
}

/**
 * 마감 시각 표시. 정부 공고는 16시 마감이 흔한데 시각을 자정으로 착각해 하루를 통째로 날리는
 * 사고가 이 알림이 막으려는 것이라 applyEndTime이 없으면 눈에 띄게 "미확인"이라 표시한다.
 */
function deadlineTimeLabel(v: ProgramView): string {
  return v.program.applyEndTime ? `내일 ${v.program.applyEndTime} 마감` : '⚠️ 마감 시각 미확인';
}

function deadlineTomorrowLine(v: ProgramView): string {
  const owners = ownersOf(v.applications);
  const link = isLinkable(v.program.sourceUrl) ? `\n   ${v.program.sourceUrl}` : '';
  return `🔴 **${v.program.title}** · ${deadlineTimeLabel(v)} · 담당 ${owners}${link}`;
}

/** 'YYYY-MM-DD' → 'M/D'. 제목에 내일 날짜를 보여줄 때 쓴다. */
function shortDate(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/**
 * 내일 마감 알림 embed를 조립한다. 색은 항상 빨강(TONE_COLOR.red) — 다이제스트처럼 긴급도에 따라
 * 달라지지 않는다(이 알림 자체가 "내일 마감"이라는, 발생 자체가 이미 급한 신호이기 때문이다).
 * 달력 링크는 다이제스트와 마찬가지로 항상 하단에 붙인다.
 */
export function buildDeadlineTomorrowEmbed(items: ProgramView[], today: Date): DiscordEmbed {
  const { year, month, day } = kstDateParts(today);
  const todayStr = `${year}-${pad2(month)}-${pad2(day)}`;
  const tomorrowStr = addDays(todayStr, 1);

  const body = items.map(deadlineTomorrowLine).join('\n\n');
  const trailer = `\n\n📅 [달력에서 전체 보기](${CALENDAR_URL})`;
  const budget = EMBED_DESCRIPTION_LIMIT - trailer.length;
  const truncated =
    body.length > budget ? body.slice(0, Math.max(0, budget - '\n\n…(내용이 많아 일부 생략됨)'.length)) + '\n\n…(내용이 많아 일부 생략됨)' : body;

  return {
    title: `🚨 내일(${shortDate(tomorrowStr)}) 마감 — ${items.length}건`,
    description: truncated + trailer,
    color: TONE_COLOR.red,
  };
}

/**
 * 최대 MAX_RETRIES회 지수 백오프로 재시도한다. 최종 실패해도 예외를 던지지 않는다 —
 * 알림 전송 실패는 크론 전체를 죽일 이유가 아니다. 대신 console.error로 명확히 남긴다.
 */
async function sendWithRetry(
  channelId: string,
  botToken: string,
  payload: Record<string, unknown>,
): Promise<{ sent: boolean }> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await postChannelMessage(channelId, botToken, payload);
    if (result.ok) return { sent: true };

    lastStatus = result.status;
    if (attempt < MAX_RETRIES) {
      console.warn(
        `[cron:deadlineTomorrow] 디스코드 전송 실패(시도 ${attempt}/${MAX_RETRIES}, status=${result.status}) — ${backoffMs(attempt)}ms 후 재시도합니다.`,
      );
      await sleep(backoffMs(attempt));
    }
  }
  console.error(
    `[cron:deadlineTomorrow] 디스코드 전송이 ${MAX_RETRIES}회 재시도 후에도 실패했습니다(마지막 status=${lastStatus}). 알림이 나가지 않았습니다 — 확인이 필요합니다.`,
  );
  return { sent: false };
}

export interface SendDeadlineTomorrowOptions {
  /** true면 embed를 조립·로그만 하고 실제 전송은 하지 않는다. worker/cron/digest.ts의
   *  CRON_DRY_RUN과 같은 스위치를 공유한다(.dev.vars 전용, wrangler secret/vars에 넣지 않는다). */
  dryRun?: boolean;
  now?: Date;
}

export interface SendDeadlineTomorrowResult {
  /** 실제로 전송했는지. dry-run이거나 내일 마감 대상이 없거나 전송이 최종 실패하면 false. */
  sent: boolean;
  /** 조립된 embed의 본문(description). 보낼 게 없으면 null(내일 마감인 건이 없는 조용한 날). */
  message: string | null;
}

export async function sendDeadlineTomorrow(env: Env, options: SendDeadlineTomorrowOptions = {}): Promise<SendDeadlineTomorrowResult> {
  const today = options.now ?? new Date();
  const { programs, applications, documents, profile } = await loadAll(env.DB);
  const items = selectDeadlineTomorrow(programs, applications, documents, profile, today);

  if (items.length === 0) {
    console.log('[cron:deadlineTomorrow] 내일 마감인 건이 없습니다 — 전송하지 않습니다.');
    return { sent: false, message: null };
  }

  const embed = buildDeadlineTomorrowEmbed(items, today);

  if (options.dryRun) {
    console.log(`[cron:deadlineTomorrow] CRON_DRY_RUN — 대상 ${items.length}건. 조립된 embed를 전송하지 않고 로그로만 남깁니다.`);
    console.log(JSON.stringify(embed));
    return { sent: false, message: embed.description ?? null };
  }

  // 대상이 있으면(items.length > 0) 항상 @here — D-1 마감은 08:30 다이제스트가 더 이상 멘션하지
  // 않으므로 이 알림이 유일한 알림 경로다. @everyone은 이 코드 경로에 아예 없다.
  const payload: Record<string, unknown> = {
    content: '@here',
    embeds: [embed],
    allowed_mentions: { parse: ['everyone'] },
  };

  const { sent } = await sendWithRetry(env.DISCORD_CHANNEL_ID, env.DISCORD_BOT_TOKEN, payload);
  return { sent, message: embed.description ?? null };
}
