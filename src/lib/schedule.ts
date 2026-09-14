/**
 * 지원사업 일정 계산 순수 함수 모음.
 * 부수효과 없음. 모든 날짜 계산은 로컬 타임존이 아니라 KST(Asia/Seoul, UTC+9, DST 없음)
 * 자정 기준으로 정규화한다 — 실행 서버/브라우저 타임존에 의존하면 배포 환경마다 D-day가
 * 어긋날 수 있기 때문이다.
 *
 * KST 정규화가 필요한 다른 모듈(documents.ts, eligibility.ts)은 새로 타임존 처리를 짜지 말고
 * 이 파일의 헬퍼를 import해서 쓸 것. 타임존 로직이 두 벌 생기면 반드시 어긋난다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' 문자열이 가리키는 그 날짜의 KST 자정을 UTC epoch ms로 반환한다. */
function dateStrToKstMidnightEpoch(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  // 'YYYY-MM-DD 00:00:00+09:00'을 UTC epoch로 바꾸면 UTC 기준 9시간을 빼야 한다.
  return Date.UTC(year, month - 1, day, 0, 0, 0) - KST_OFFSET_MS;
}

/** 임의의 시각(Date)이 KST 달력으로 몇 년-몇 월-몇 일인지 분해한다. '오늘이 며칠인가'가 필요한 곳에서 쓴다. */
export function kstDateParts(instant: Date = new Date()): { year: number; month: number; day: number } {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 임의의 시각(Date)이 KST 달력으로 속한 날의 자정 epoch ms를 반환한다. */
function instantToKstMidnightEpoch(instant: Date): number {
  const { year, month, day } = kstDateParts(instant);
  return Date.UTC(year, month - 1, day, 0, 0, 0) - KST_OFFSET_MS;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * dateStr('YYYY-MM-DD')이 오늘(today) 기준으로 며칠 후인지 계산한다.
 * KST 자정을 기준으로 날짜 경계를 정규화하므로 로컬 타임존과 무관하게 동일한 결과를 낸다.
 * 반환값이 0이면 오늘, 음수면 이미 지난 날짜.
 */
export function daysUntil(dateStr: string, today: Date = new Date()): number {
  const targetEpoch = dateStrToKstMidnightEpoch(dateStr);
  const todayEpoch = instantToKstMidnightEpoch(today);
  return Math.round((targetEpoch - todayEpoch) / MS_PER_DAY);
}

/**
 * dateStr('YYYY-MM-DD')에서 days일 뒤의 날짜를 'YYYY-MM-DD'로 반환한다.
 * KST에는 DST가 없으므로 자정 epoch에 일수를 더하면 그대로 다음 날 자정이 된다.
 * (서류 유효기한 = 발급일 + 유효일수 계산용)
 */
export function addDays(dateStr: string, days: number): string {
  const epoch = dateStrToKstMidnightEpoch(dateStr) + days * MS_PER_DAY;
  const { year, month, day } = kstDateParts(new Date(epoch));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * dateStr('YYYY-MM-DD')로부터 오늘까지 지난 '만 개월 수'를 반환한다.
 * 일(day)이 아직 도달하지 않았으면 그 달은 세지 않는다. (법인 설립 후 N개월 이내 판정용)
 */
export function monthsSince(dateStr: string, today: Date = new Date()): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  const now = kstDateParts(today);
  const elapsed = (now.year - year) * 12 + (now.month - month);
  return now.day < day ? elapsed - 1 : elapsed;
}

/** deadlineState 계산에 필요한 최소 필드만 담은 타입. content.config.ts의 programs 스키마와 호환된다. */
export interface DeadlineInput {
  applyStart?: string;
  applyEnd: string;
}

export type DeadlineState = 'closed' | 'urgent' | 'soon' | 'open' | 'upcoming';

const URGENT_THRESHOLD_DAYS = 3;
const SOON_THRESHOLD_DAYS = 7;

/**
 * applyEnd(마감일) 기준으로 공고의 접수 상태를 분류한다.
 * - upcoming: applyStart가 미래(아직 접수 시작 전)
 * - closed:   applyEnd가 지남
 * - urgent:   마감까지 3일 이내 (마감 당일 포함)
 * - soon:     마감까지 7일 이내
 * - open:     접수 진행 중, 마감까지 여유 있음
 */
export function deadlineState(program: DeadlineInput, today: Date = new Date()): DeadlineState {
  if (program.applyStart && daysUntil(program.applyStart, today) > 0) {
    return 'upcoming';
  }

  const remaining = daysUntil(program.applyEnd, today);

  if (remaining < 0) return 'closed';
  if (remaining <= URGENT_THRESHOLD_DAYS) return 'urgent';
  if (remaining <= SOON_THRESHOLD_DAYS) return 'soon';
  return 'open';
}
