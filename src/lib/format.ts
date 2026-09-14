/**
 * 화면 표시용 문자열·색상 톤 매핑. 날짜 계산은 하지 않는다 — 계산은 schedule.ts / documents.ts /
 * eligibility.ts가 하고, 여기서는 그 결과(일수, 'YYYY-MM-DD', 상태 enum)를 사람이 읽는 형태로
 * 바꾸기만 한다.
 */

import type { DeadlineState } from './schedule.ts';
import type { EligibilityVerdict } from './eligibility.ts';
import type { DocumentExpiryState } from './documents.ts';

/**
 * 배지·숫자에 쓰는 색상 톤. 색은 상태를 나타낼 때만 쓴다.
 * red=차단/위험, orange=임박, amber=사람 확인 필요, green=정상, blue=예정/정보, gray=비활성.
 */
export type Tone = 'neutral' | 'gray' | 'green' | 'blue' | 'amber' | 'orange' | 'red';

/** 남은 일수를 'D-n' / 'D-Day' / 'D+n'으로. */
export function formatDday(days: number): string {
  if (days === 0) return 'D-Day';
  return days > 0 ? `D-${days}` : `D+${-days}`;
}

/** 'YYYY-MM-DD' → 'M/D'. 월 헤더로 연도가 이미 보이는 자리에서 쓴다. */
export function formatShortDate(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** 'YYYY-MM-DD' → 'YYYY-MM' (월 구분 키). */
export function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** 'YYYY-MM' → 'YYYY년 M월'. */
export function formatMonth(key: string): string {
  const [year, month] = key.split('-');
  return `${year}년 ${Number(month)}월`;
}

export const VERDICT_LABEL: Record<EligibilityVerdict, string> = {
  eligible: '지원 가능',
  ineligible: '지원 불가',
  'needs-check': '확인 필요',
};

export const VERDICT_TONE: Record<EligibilityVerdict, Tone> = {
  eligible: 'green',
  ineligible: 'red',
  'needs-check': 'amber',
};

export const DOC_STATE_LABEL: Record<DocumentExpiryState, string> = {
  valid: '유효',
  expiring: '만료 임박',
  expired: '만료됨',
  unknown: '기한 미확인',
};

export const DOC_STATE_TONE: Record<DocumentExpiryState, Tone> = {
  valid: 'green',
  expiring: 'orange',
  expired: 'red',
  unknown: 'gray',
};

export const DEADLINE_TONE: Record<DeadlineState, Tone> = {
  closed: 'gray',
  urgent: 'red',
  soon: 'orange',
  open: 'neutral',
  upcoming: 'blue',
};
