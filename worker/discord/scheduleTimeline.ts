/**
 * /일정 — 날짜순 타임라인. 웹 달력의 "타임라인 보기"와 같은 정보를 디스코드 embed로 압축한다.
 *
 * 이벤트 목록·날짜·D-day·마감 상태 판정은 전부 loadBoard.ts(→ src/lib/board.ts,
 * buildCalendarEvents)가 이미 계산한 board.events를 그대로 쓴다 — 여기서 날짜 판정을
 * 새로 짜지 않는다. 색/이모지도 format.ts의 DEADLINE_TONE·embeds.ts의 TONE_EMOJI/TONE_COLOR를
 * 그대로 쓴다(statusBoard.ts와 같은 원칙).
 */

import { deadlineState, kstDateParts, addDays, daysInMonth, toDateStr, weekdayOf } from '../../src/lib/schedule.ts';
import { formatDday, formatShortDate, monthKey, formatMonth, isLinkable, EVENT_KIND_LABEL, DEADLINE_TONE } from '../../src/lib/format.ts';
import type { CalendarEvent } from '../../src/lib/board.ts';
import { TONE_COLOR, TONE_EMOJI, type DiscordEmbed } from './embeds.ts';
import { CALENDAR_URL } from './statusBoard.ts';

const EMBED_DESCRIPTION_LIMIT = 4096;
/** embed 하나에 보여줄 최대 이벤트 수. 넘으면 잘리고 "외 N건" 안내를 남긴다. */
const MAX_EVENTS = 30;
const MORE_NOTICE_SUFFIX = '/공고 목록으로 전체 보기';

const WEEKDAY_SHORT_KO = ['일', '월', '화', '수', '목', '금', '토'];

export const SCHEDULE_SCOPES = ['이번달', '다음달까지', '전체'] as const;
export type ScheduleScope = (typeof SCHEDULE_SCOPES)[number];
export const DEFAULT_SCHEDULE_SCOPE: ScheduleScope = '이번달';

/** 'YYYY-MM-DD' → 'M/D (요일)'. format.ts의 formatShortDate + schedule.ts의 weekdayOf만 조합한다. */
function formatShortDateWithWeekday(dateStr: string): string {
  return `${formatShortDate(dateStr)} (${WEEKDAY_SHORT_KO[weekdayOf(dateStr)]})`;
}

function currentMonthKey(today: Date): string {
  const { year, month } = kstDateParts(today);
  return monthKey(toDateStr(year, month, 1));
}

/** daysInMonth+addDays로 이번 달 말일 다음 날(=다음 달 1일)을 구한다 — 월 롤오버를 직접 계산하지 않는다. */
function nextMonthKey(today: Date): string {
  const { year, month } = kstDateParts(today);
  const firstOfThisMonth = toDateStr(year, month, 1);
  const firstOfNextMonth = addDays(firstOfThisMonth, daysInMonth(year, month));
  return monthKey(firstOfNextMonth);
}

/**
 * 이벤트의 담당자. target(내부 마감) 이벤트는 그 지원건의 owner를 바로 쓰고, 나머지 종류는
 * 같은 공고에 연결된 지원건이 있으면 그 owner를 보여준다(지원건이 없으면 표시하지 않는다).
 */
function ownerOf(event: CalendarEvent): string | undefined {
  if (event.application) return event.application.application.owner;
  return event.program.applications[0]?.application.owner;
}

/**
 * 이벤트 하나의 색조. 접수 마감/내부 마감은 "그 날짜까지 며칠 남았나"로 긴급도를 매긴다 —
 * schedule.ts의 deadlineState를 이벤트 날짜에 그대로 적용해 재사용한다(새 임계값을 만들지 않음).
 * 발표 예정/접수 시작은 급함을 다투는 마감이 아니라 "예정된 일정" 정보라서 DEADLINE_TONE의
 * upcoming(파랑)을 그대로 쓴다.
 */
function toneForEvent(event: CalendarEvent, today: Date) {
  if (event.kind === 'announce' || event.kind === 'apply-start') {
    return DEADLINE_TONE.upcoming;
  }
  return DEADLINE_TONE[deadlineState({ applyEnd: event.date }, today)];
}

function eventLine(event: CalendarEvent, today: Date): string {
  const emoji = TONE_EMOJI[toneForEvent(event, today)];
  const dateLabel = formatShortDateWithWeekday(event.date);
  const dday = formatDday(event.daysLeft);
  const kindLabel = EVENT_KIND_LABEL[event.kind];
  const owner = ownerOf(event);
  const ownerSuffix = owner ? ` · ${owner}` : '';
  const link = isLinkable(event.program.program.sourceUrl) ? `\n   ${event.program.program.sourceUrl}` : '';

  // 지원 불가 판정이어도 빼지 않는다 — 판정이 틀릴 수 있어서다. 취소선 + 사유로 흐리게만 표시한다.
  const title =
    event.program.eligibility.verdict === 'ineligible'
      ? `~~${event.program.program.title}~~ _(지원 불가 판정)_`
      : `**${event.program.program.title}**`;

  return `${emoji} ${dateLabel}  ${title} — ${kindLabel} ${dday}${ownerSuffix}${link}`;
}

function groupByMonth(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = monthKey(event.date);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(event);
    else grouped.set(key, [event]);
  }
  return grouped;
}

/**
 * 범위(scope)·담당(owner) 필터를 적용한다. "마감된 항목"은 board.ts가 이미 계산해 둔
 * event.stale(마감된 공고 + 지난 날짜)을 그대로 쓴다 — 기본은 빼고, "전체"에서만 포함한다.
 */
export function filterEventsForSchedule(
  events: readonly CalendarEvent[],
  scope: ScheduleScope,
  owner: string | undefined,
  today: Date,
): CalendarEvent[] {
  const curKey = currentMonthKey(today);
  const nextKey = nextMonthKey(today);
  const normalizedOwner = owner?.trim().toLowerCase();

  return events.filter((event) => {
    if (scope !== '전체' && event.stale) return false;
    if (scope === '이번달' && monthKey(event.date) !== curKey) return false;
    if (scope === '다음달까지' && monthKey(event.date) !== curKey && monthKey(event.date) !== nextKey) return false;
    if (normalizedOwner && ownerOf(event)?.toLowerCase() !== normalizedOwner) return false;
    return true;
  });
}

/**
 * 타임라인 description을 조립한다. **filteredEvents가 비어 있지 않다고 가정한다** —
 * 빈 상태 문구는 커맨드가 "필터 때문인지 데이터가 아예 없는지"를 구분해서 직접 만든다
 * (여기서는 일반적인 문구를 대신 넣지 않는다).
 */
export function buildTimelineDescription(filteredEvents: readonly CalendarEvent[], today: Date): string {
  const totalCount = filteredEvents.length;
  const shown = filteredEvents.slice(0, MAX_EVENTS);
  const truncatedCount = totalCount - shown.length;

  const sections: string[] = [];
  for (const [key, monthEvents] of groupByMonth(shown)) {
    const header = `📅 ${formatMonth(key)}`;
    sections.push(`${header}\n${monthEvents.map((e) => eventLine(e, today)).join('\n')}`);
  }

  let body = sections.join('\n\n');
  if (truncatedCount > 0) {
    body += `\n\n…외 ${truncatedCount}건 — ${MORE_NOTICE_SUFFIX}`;
  }

  // 달력 링크는 절대 잘리면 안 된다 — 예산을 먼저 떼어 두고, 본문이 넘치면 안내와 함께 잘라낸다
  // (statusBoard.ts와 같은 방식).
  const trailer = `\n\n📅 격자로 한눈에 보려면: [달력 보기](${CALENDAR_URL})`;
  const budget = EMBED_DESCRIPTION_LIMIT - trailer.length;
  if (body.length > budget) {
    const notice = `\n\n…(내용이 많아 일부 생략됨) — ${MORE_NOTICE_SUFFIX}`;
    body = body.slice(0, Math.max(0, budget - notice.length)) + notice;
  }
  return body + trailer;
}

export function buildTimelineEmbed(filteredEvents: readonly CalendarEvent[], today: Date = new Date()): DiscordEmbed {
  return {
    title: '📅 일정 타임라인',
    description: buildTimelineDescription(filteredEvents, today),
    color: TONE_COLOR.blue,
  };
}
