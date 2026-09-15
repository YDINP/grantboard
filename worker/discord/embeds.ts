/**
 * 디스코드 Embed 조립 헬퍼. 상태 판정은 전부 src/lib/board.ts가 이미 끝낸 값(ProgramView 등)을
 * 받아 문자열/색으로 바꾸기만 한다 — format.ts와 같은 원칙이다.
 *
 * 모바일에서 3열 inline 필드가 줄바꿈으로 깨지는 문제를 피하기 위해 inline 필드를 쓰지 않고,
 * description 텍스트 블록에 줄 단위로 나열한다.
 */

import { formatDday, isLinkable, DEADLINE_TONE, DOC_STATE_LABEL, DOC_STATE_TONE, type Tone } from '../../src/lib/format.ts';
import type { ProgramView, ApplicationView, DocumentView } from '../../src/lib/board.ts';

/** 상태 색(Tone)을 이모지로. 빨강=차단/위험, 주황=임박, 노랑=확인 필요, 초록=정상, 파랑=예정. */
export const TONE_EMOJI: Record<Tone, string> = {
  neutral: '⚪',
  gray: '⚪',
  green: '🟢',
  blue: '🔵',
  amber: '🟡',
  orange: '🟠',
  red: '🔴',
  quiet: '⚪',
};

/** 상태 색(Tone)을 Embed color(정수)로. */
export const TONE_COLOR: Record<Tone, number> = {
  neutral: 0x99a1af,
  gray: 0x99a1af,
  green: 0x22c55e,
  blue: 0x3b82f6,
  amber: 0xeab308,
  orange: 0xf97316,
  red: 0xef4444,
  quiet: 0x99a1af,
};

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
}

export function buildEmbed(title: string, description: string, tone: Tone, footer?: string): DiscordEmbed {
  const embed: DiscordEmbed = { title, description: description || '(내용 없음)', color: TONE_COLOR[tone] };
  if (footer) embed.footer = { text: footer };
  return embed;
}

/** 공고 한 줄 요약. /임박, /공고 목록에서 공통으로 쓴다. */
export function programLine(view: ProgramView): string {
  const emoji = TONE_EMOJI[DEADLINE_TONE[view.deadline.state]];
  const dday = formatDday(view.deadline.daysLeft);
  const link = isLinkable(view.program.sourceUrl) ? `\n   ${view.program.sourceUrl}` : '';
  return `${emoji} **${view.program.title}** · ${dday} · ${view.program.organizer}${link}`;
}

/** 내부 마감 초과 미제출 지원건 한 줄. */
export function overdueApplicationLine(view: ApplicationView): string {
  const title = view.program?.title ?? '(공고 정보 없음)';
  const link = view.program && isLinkable(view.program.sourceUrl) ? `\n   ${view.program.sourceUrl}` : '';
  const dday = view.targetDaysLeft !== null ? formatDday(view.targetDaysLeft) : '미확인';
  return `🔴 **${title}** · 내부마감 ${dday} · 담당 ${view.application.owner}${link}`;
}

/** 발표일 경과, 결과 확인 필요한 지원건 한 줄. */
export function announceOverdueLine(view: ApplicationView): string {
  const title = view.program?.title ?? '(공고 정보 없음)';
  const link = view.program && isLinkable(view.program.sourceUrl) ? `\n   ${view.program.sourceUrl}` : '';
  return `🔔 **${title}** · 담당 ${view.application.owner}${link}`;
}

/** 서류 한 줄. /서류에서 쓴다. */
export function documentLine(view: DocumentView): string {
  const emoji = TONE_EMOJI[DOC_STATE_TONE[view.expiry.state]];
  const label = DOC_STATE_LABEL[view.expiry.state];
  const dday = view.expiry.daysLeft !== null ? ` (${formatDday(view.expiry.daysLeft)})` : '';
  const usedByPrograms = [...new Set(view.usedBy.map((u) => u.program?.title ?? '(연결된 공고 없음)'))];
  const usage = usedByPrograms.length > 0 ? `\n   사용처: ${usedByPrograms.join(', ')}` : '';
  return `${emoji} **${view.document.name}** · ${label}${dday}${usage}`;
}

/** /내마감에서 쓰는 지원건 한 줄. 상태와 마감(공고/내부) D-day를 함께 보여준다. */
export function myApplicationLine(view: ApplicationView): string {
  const title = view.program?.title ?? '(공고 정보 없음)';
  const link = view.program && isLinkable(view.program.sourceUrl) ? `\n   ${view.program.sourceUrl}` : '';
  const emoji = view.deadline ? TONE_EMOJI[DEADLINE_TONE[view.deadline.state]] : '⚪';
  const dday = view.deadline ? formatDday(view.deadline.daysLeft) : '마감 미확인';
  const target = view.targetDaysLeft !== null ? ` · 내부마감 ${formatDday(view.targetDaysLeft)}` : '';
  return `${emoji} **${title}** · ${view.application.status} · ${dday}${target}${link}`;
}

/** 응답 내용이 비었을 때 공통으로 쓰는 문구. */
export function emptyStateLine(message: string): string {
  return `🟢 ${message}`;
}
