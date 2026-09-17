/**
 * CRON_DIGEST(KST 08:30)가 부르는 진입점. 무엇을 담을지(selectDigestSections)와 긴급도/멘션
 * 판단(digestUrgency, shouldMentionHere)은 순수 함수(src/lib/digest.ts)에 맡기고, 여기서는
 * Discord embed 조립 + D1 읽기 + 채널 전송(재시도 포함) + 스레드 생성만 한다.
 *
 * scripts/notify.mjs(로컬 수동 실행, Slack/Discord 웹훅 대상 plain text)와는 "무엇을 담을지"만
 * 공유하고(selectDigestSections), 표시 형식은 다르다 — Worker는 봇 토큰으로 채널에 embed를 직접
 * 올린다(웹훅 URL을 따로 관리할 필요가 없고, embed 색상/멘션 같은 봇 전용 기능을 쓸 수 있다).
 */

import { loadAll } from '../db/repo.ts';
import {
  selectDigestSections,
  digestUrgency,
  shouldMentionHere,
  type DigestSections,
} from '../../src/lib/digest.ts';
import { kstDateParts } from '../../src/lib/schedule.ts';
import { formatDday, isLinkable, DEADLINE_TONE, DOC_STATE_TONE } from '../../src/lib/format.ts';
import { isActiveStatus, type ProgramView, type ApplicationView, type DocumentView } from '../../src/lib/board.ts';
import { postChannelMessage, createMessageThread } from '../discord/discordApi.ts';
import { TONE_EMOJI, TONE_COLOR, overdueApplicationLine, announceOverdueLine, type DiscordEmbed } from '../discord/embeds.ts';
import { CALENDAR_URL } from '../discord/statusBoard.ts';

const MAX_RETRIES = 3;
/** Discord embed description 상한(4096자). worker/discord/statusBoard.ts와 같은 값 — 플랫폼 제약이지
 *  둘이 같은 의미를 공유하는 상수는 아니라서(둘 다 "Discord embed 제한"이라는 사실만 같음) 따로 둔다. */
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

// ---------------------------------------------------------------------------
// 항목 한 줄 포맷
//
// overdueApplicationLine/announceOverdueLine(worker/discord/embeds.ts)은 이미 이 다이제스트가
// 필요로 하는 형태(담당자 표시 + 링크)와 정확히 같아서 그대로 가져다 쓴다. 아래 둘은 이 다이제스트
// 전용이다 — 재사용하는 embeds.ts의 programLine/documentLine은 각각 organizer만 보여주거나(담당자
// 없음) 링크가 없어서(서류 자체엔 URL이 없다), 다이제스트가 요구하는 "담당자 + 원문 링크"를 못 채운다.
// ---------------------------------------------------------------------------

function deadlineSoonLine(v: ProgramView): string {
  const emoji = TONE_EMOJI[DEADLINE_TONE[v.deadline.state]];
  const owners = ownersOf(v.applications);
  const link = isLinkable(v.program.sourceUrl) ? `\n   ${v.program.sourceUrl}` : '';
  return `${emoji} **${v.program.title}** · ${formatDday(v.deadline.daysLeft)} · 담당 ${owners}${link}`;
}

/** 서류 만료 알림 한 줄. 진행 중인 지원건에서 쓰는 것만 보여준다(selectDigestSections가 이미 그렇게 걸러왔다). */
function docAlertLine(v: DocumentView): string {
  const emoji = TONE_EMOJI[DOC_STATE_TONE[v.expiry.state]];
  const activeUsages = v.usedBy.filter((u) => isActiveStatus(u.application.status));
  const programTitles =
    [...new Set(activeUsages.map((u) => u.program?.title ?? '(공고 정보 없음)'))].join(', ') || '연결된 지원건 없음';
  const owners = ownersOf(activeUsages);
  const linkedProgram = activeUsages.find((u) => u.program && isLinkable(u.program.sourceUrl))?.program;
  const link = linkedProgram ? `\n   ${linkedProgram.sourceUrl}` : '';
  const dday = v.expiry.daysLeft !== null ? formatDday(v.expiry.daysLeft) : '기한 미확인';
  return `${emoji} **${v.document.name}** (${programTitles}) · ${dday} · 담당 ${owners}${link}`;
}

/** MM/DD 형식 — 임베드 제목과 스레드 이름이 공유한다. */
function kstShortDate(today: Date): { label: string; monthDay: string } {
  const { year, month, day } = kstDateParts(today);
  return { label: `${year}-${pad2(month)}-${pad2(day)}`, monthDay: `${month}/${day}` };
}

/**
 * 다이제스트 embed를 조립한다. 색상은 긴급도(digestUrgency)를 그대로 쓴다 — 'red'|'orange'|'green'이
 * TONE_COLOR의 키와 일치하도록 src/lib/digest.ts에서 이미 맞춰뒀다.
 * 달력 링크는 항상 하단에 붙는다("바로 행동할 수 있어야 한다" — 어디로 가야 할지 다시 찾게 하지 않는다).
 */
export function buildDigestEmbed(sections: DigestSections, today: Date): DiscordEmbed {
  const blocks: string[] = [];
  if (sections.deadlineSoon.length > 0) {
    blocks.push(['🚨 **오늘/3일 이내 마감**', ...sections.deadlineSoon.map(deadlineSoonLine)].join('\n'));
  }
  if (sections.overdueUnsubmitted.length > 0) {
    blocks.push(['⚠️ **내부 마감 초과 미제출**', ...sections.overdueUnsubmitted.map(overdueApplicationLine)].join('\n'));
  }
  if (sections.docAlerts.length > 0) {
    blocks.push(['📄 **서류 만료/만료 임박**', ...sections.docAlerts.map(docAlertLine)].join('\n'));
  }
  if (sections.announceOverdue.length > 0) {
    blocks.push(['🔔 **발표일 경과, 결과 확인 필요**', ...sections.announceOverdue.map(announceOverdueLine)].join('\n'));
  }

  const trailer = `\n\n📅 [달력에서 전체 보기](${CALENDAR_URL})`;
  const budget = EMBED_DESCRIPTION_LIMIT - trailer.length;
  let body = blocks.join('\n\n');
  if (body.length > budget) {
    const notice = '\n\n…(내용이 많아 일부 생략됨)';
    body = body.slice(0, Math.max(0, budget - notice.length)) + notice;
  }

  return {
    title: `📋 GrantBoard D-day 다이제스트 (${kstShortDate(today).label})`,
    description: body + trailer,
    color: TONE_COLOR[digestUrgency(sections)],
  };
}

/**
 * 최대 MAX_RETRIES회 지수 백오프로 재시도한다. 최종 실패해도 예외를 던지지 않는다 —
 * 알림 전송 실패는 크론 전체를 죽일 이유가 아니다(다음날 수집/다이제스트는 정상 동작해야 한다).
 * 대신 console.error로 명확히 남긴다 — 알림이 조용히 안 가는 게 제일 나쁘다.
 */
async function sendWithRetry(
  channelId: string,
  botToken: string,
  payload: Record<string, unknown>,
): Promise<{ sent: boolean; messageId?: string }> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await postChannelMessage(channelId, botToken, payload);
    if (result.ok) return { sent: true, messageId: result.messageId };

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
  return { sent: false };
}

export interface SendDigestOptions {
  /** true면 embed를 조립·로그만 하고 실제 전송(과 스레드 생성)은 하지 않는다. 로컬 테스트
   *  (`wrangler dev --test-scheduled`)에서 실제 채널에 글이 가는 걸 막기 위한 것 — 프로덕션에서는
   *  절대 켜지 않는다(env.CRON_DRY_RUN은 .dev.vars 전용, wrangler secret/vars에 넣지 않는다). */
  dryRun?: boolean;
  now?: Date;
}

export interface SendDigestResult {
  /** 실제로 전송했는지. dry-run이거나 보낼 내용이 없거나 전송이 최종 실패하면 false. */
  sent: boolean;
  /** 조립된 embed의 본문(description). 보낼 게 없으면 null(오늘은 조용한 날). */
  message: string | null;
}

export async function sendDigest(env: Env, options: SendDigestOptions = {}): Promise<SendDigestResult> {
  const today = options.now ?? new Date();
  const { programs, applications, documents, profile } = await loadAll(env.DB);
  const sections = selectDigestSections(programs, applications, documents, profile, today);

  if (!sections) {
    console.log('[cron:digest] 오늘 보낼 다이제스트가 없습니다(급한 항목 없음) — 전송하지 않습니다.');
    return { sent: false, message: null };
  }

  const embed = buildDigestEmbed(sections, today);
  const mentionHere = shouldMentionHere(sections);

  if (options.dryRun) {
    console.log(
      `[cron:digest] CRON_DRY_RUN — urgency=${digestUrgency(sections)} mentionHere=${mentionHere}. 조립된 embed를 전송하지 않고 로그로만 남깁니다.`,
    );
    console.log(JSON.stringify(embed));
    return { sent: false, message: embed.description ?? null };
  }

  // @here는 "오늘이 마감(D-day)일 때만". D-1은 KST 12:00 전용 알림이 전담하므로 여기서 울리지
  // 않는다 — 같은 건으로 하루 두 번 멘션하지 않기 위해서다. @everyone은 이 코드 경로에 아예
  // 없다(오프라인 멤버까지 깨우는 건 팀이 원하지 않는다). allowed_mentions로 그 사실을 강제한다.
  const payload: Record<string, unknown> = {
    embeds: [embed],
    allowed_mentions: { parse: mentionHere ? ['everyone'] : [] },
  };
  if (mentionHere) payload.content = '@here';

  const { sent, messageId } = await sendWithRetry(env.DISCORD_CHANNEL_ID, env.DISCORD_BOT_TOKEN, payload);

  // 스레드는 부가 기능이다 — 실패해도 다이제스트 발송(본질) 자체는 이미 끝났다. 로그만 남긴다.
  if (sent && messageId) {
    const threadName = `${kstShortDate(today).monthDay} 논의`;
    const threadResult = await createMessageThread(env.DISCORD_CHANNEL_ID, messageId, env.DISCORD_BOT_TOKEN, threadName);
    if (!threadResult.ok) {
      console.error(
        `[cron:digest] 다이제스트 스레드 생성 실패(status=${threadResult.status}) — 다이제스트 발송 자체는 성공했다.`,
      );
    }
  }

  return { sent, message: embed.description ?? null };
}
