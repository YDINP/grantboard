/**
 * 사람이 손으로 입력하는 'YYYY-MM-DD' 날짜 문자열 검증.
 * 정규식만으로는 2026-02-30 같은 존재하지 않는 날짜를 걸러낼 수 없어서, 실제 그 달의
 * 일수(daysInMonth)까지 확인한다. 윤년 계산은 schedule.ts가 이미 하고 있으므로 새로 짜지 않는다.
 */

import { parseDateStr, daysInMonth } from '../../src/lib/schedule.ts';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DateValidationResult {
  ok: boolean;
  /** ok가 false일 때 사용자에게 그대로 보여줄 수 있는 한국어 사유. */
  reason?: string;
}

/** 형식(YYYY-MM-DD)과 실제 존재하는 날짜인지(월별 일수, 윤년 포함)를 함께 검증한다. */
export function validateDateStr(value: string): DateValidationResult {
  if (!DATE_PATTERN.test(value)) {
    return { ok: false, reason: `형식이 올바르지 않습니다. YYYY-MM-DD로 입력해 주세요 (입력값: ${value || '(빈 값)'}).` };
  }
  const { year, month, day } = parseDateStr(value);
  if (month < 1 || month > 12) {
    return { ok: false, reason: `월(MM)은 01~12여야 합니다 (입력값: ${value}).` };
  }
  const lastDay = daysInMonth(year, month);
  if (day < 1 || day > lastDay) {
    return { ok: false, reason: `${year}년 ${month}월은 ${lastDay}일까지만 있습니다 (입력값: ${value}).` };
  }
  return { ok: true };
}
