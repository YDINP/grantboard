/**
 * 제출서류 유효기한 계산 순수 함수. 부수효과 없음.
 * 날짜 계산은 전부 schedule.ts의 KST 헬퍼를 재사용한다 — 타임존 처리를 여기서 다시 짜지 말 것.
 */

import { addDays, daysUntil } from './schedule.ts';

/** documentExpiry가 필요로 하는 서류 필드만 담은 타입. content.config.ts의 documents 스키마와 호환된다. */
export interface DocumentExpiryInput {
  issuedAt?: string;
  validityDays?: number;
  /** issuedAt+validityDays보다 우선하는 명시적 override. */
  validUntil?: string;
}

export type DocumentExpiryState = 'expired' | 'expiring' | 'valid' | 'unknown';

export interface DocumentExpiry {
  /** 실제로 적용되는 유효기한('YYYY-MM-DD'). 계산할 근거가 없으면 null. */
  validUntil: string | null;
  /** 유효기한까지 남은 일수. 0이면 만료 당일, 음수면 이미 만료. 근거가 없으면 null. */
  daysLeft: number | null;
  state: DocumentExpiryState;
}

/** 만료 임박 기준. 재발급에 며칠 걸리는 서류가 있어 2주 전부터 경고한다. */
const EXPIRING_THRESHOLD_DAYS = 14;

/**
 * 서류의 유효기한과 상태를 계산한다.
 * 기한은 validUntil이 최우선이고, 없으면 issuedAt + validityDays로 계산한다. 둘 다 없으면 'unknown'.
 * 만료 당일(D-0)은 그날까지 유효한 것으로 보아 'expired'가 아니라 'expiring'이다
 * (schedule.ts의 마감 당일=urgent 규칙과 같은 기준).
 */
export function documentExpiry(doc: DocumentExpiryInput, today: Date = new Date()): DocumentExpiry {
  const effectiveUntil =
    doc.validUntil ??
    (doc.issuedAt && doc.validityDays !== undefined ? addDays(doc.issuedAt, doc.validityDays) : null);

  if (!effectiveUntil) {
    return { validUntil: null, daysLeft: null, state: 'unknown' };
  }

  const daysLeft = daysUntil(effectiveUntil, today);
  const state: DocumentExpiryState =
    daysLeft < 0 ? 'expired' : daysLeft <= EXPIRING_THRESHOLD_DAYS ? 'expiring' : 'valid';

  return { validUntil: effectiveUntil, daysLeft, state };
}
