/**
 * 월 달력 격자 조립 순수 함수. 부수효과 없음.
 * "1일이 무슨 요일인가", "이 달이 며칠까지인가", "오늘이 며칠인가" 같은 날짜 판단은 전부
 * schedule.ts의 KST 헬퍼를 호출한다 — 여기서 Date.getMonth() 같은 로컬 타임존 API를 쓰지 말 것.
 * 월 단위 덧셈(9월 + 2 = 11월)만 타임존과 무관한 정수 연산이라 이 파일에서 직접 한다.
 */

import { addDays, daysInMonth, kstDateParts, parseDateStr, toDateStr, weekdayOf } from './schedule.ts';

export interface YearMonth {
  year: number;
  /** 1-12 */
  month: number;
}

export interface CalendarCell {
  /** 'YYYY-MM-DD' */
  date: string;
  day: number;
  /** 0=일 … 6=토 */
  weekday: number;
  /** false면 앞뒤 달에서 넘어온 채움 칸. */
  inMonth: boolean;
  isToday: boolean;
}

export interface MonthGrid extends YearMonth {
  /** 'YYYY-MM' */
  key: string;
  /** 'YYYY년 M월' */
  label: string;
  /** 일요일 시작 7칸짜리 주 배열. 달의 길이와 1일 요일에 따라 4~6주. */
  weeks: CalendarCell[][];
}

export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

export function monthKeyOf({ year, month }: YearMonth): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthLabelOf({ year, month }: YearMonth): string {
  return `${year}년 ${month}월`;
}

/** 연/월에 delta개월을 더한다. 연도 넘김은 정수 나눗셈으로 처리한다(타임존 무관). */
export function shiftMonth({ year, month }: YearMonth, delta: number): YearMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** a가 b보다 몇 개월 뒤인지. 음수면 앞. */
export function monthDiff(a: YearMonth, b: YearMonth): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/**
 * year년 month월의 달력 격자를 만든다. 일요일 시작, 마지막 주가 토요일에서 끝나도록
 * 앞뒤 달의 날짜로 채운다. '오늘' 판정은 KST 달력 기준(kstDateParts)이다.
 */
export function buildMonthGrid(year: number, month: number, today: Date): MonthGrid {
  const now = kstDateParts(today);
  const todayStr = toDateStr(now.year, now.month, now.day);

  const first = toDateStr(year, month, 1);
  const leading = weekdayOf(first);
  const length = daysInMonth(year, month);
  const totalCells = Math.ceil((leading + length) / 7) * 7;

  const cells: CalendarCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const date = addDays(first, i - leading);
    const parts = parseDateStr(date);
    cells.push({
      date,
      day: parts.day,
      weekday: i % 7,
      inMonth: parts.year === year && parts.month === month,
      isToday: date === todayStr,
    });
  }

  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return { year, month, key: monthKeyOf({ year, month }), label: monthLabelOf({ year, month }), weeks };
}

export interface MonthSpanOptions {
  /** 오늘 기준 과거로 최대 몇 개월까지 렌더할지. 잘못된 연도 데이터가 격자를 수백 개 만들지 못하게 한다. */
  maxBefore?: number;
  maxAfter?: number;
}

/**
 * 정적 빌드에서 미리 렌더해 둘 달 목록. 이벤트가 있는 달을 모두 포함하되 오늘의 앞뒤 한 달은
 * 데이터가 없어도 넣어서 '이전/다음' 버튼이 최소 한 번은 눌리게 한다. 오늘 달은 항상 포함된다.
 */
export function monthSpan(
  eventDates: readonly string[],
  today: Date,
  { maxBefore = 12, maxAfter = 18 }: MonthSpanOptions = {},
): YearMonth[] {
  const now = kstDateParts(today);
  const current: YearMonth = { year: now.year, month: now.month };

  let earliest = -1;
  let latest = 1;
  for (const date of eventDates) {
    const { year, month } = parseDateStr(date);
    const offset = monthDiff({ year, month }, current);
    if (offset < earliest) earliest = offset;
    if (offset > latest) latest = offset;
  }
  earliest = Math.max(earliest, -maxBefore);
  latest = Math.min(latest, maxAfter);

  const months: YearMonth[] = [];
  for (let offset = earliest; offset <= latest; offset++) {
    months.push(shiftMonth(current, offset));
  }
  return months;
}
