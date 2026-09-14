import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { documentExpiry } from './documents.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다.
function kst(dateStr: string, time = '12:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

const TODAY = kst('2026-09-14');

describe('documentExpiry - 기한 산출', () => {
  test('validUntil이 있으면 그대로 쓴다', () => {
    const result = documentExpiry({ validUntil: '2026-12-31' }, TODAY);
    assert.equal(result.validUntil, '2026-12-31');
    assert.equal(result.daysLeft, 108);
  });

  test('validUntil이 없으면 issuedAt + validityDays로 계산한다', () => {
    const result = documentExpiry({ issuedAt: '2026-06-20', validityDays: 90 }, TODAY);
    assert.equal(result.validUntil, '2026-09-18');
    assert.equal(result.daysLeft, 4);
  });

  test('둘 다 있으면 validUntil이 이긴다', () => {
    const result = documentExpiry(
      { issuedAt: '2026-01-01', validityDays: 30, validUntil: '2027-03-31' },
      TODAY,
    );
    assert.equal(result.validUntil, '2027-03-31');
    assert.equal(result.state, 'valid');
  });

  test('둘 다 없으면 unknown, 날짜 필드는 null', () => {
    const result = documentExpiry({}, TODAY);
    assert.deepEqual(result, { validUntil: null, daysLeft: null, state: 'unknown' });
  });

  test('issuedAt만 있고 validityDays가 없으면 unknown', () => {
    assert.equal(documentExpiry({ issuedAt: '2026-06-20' }, TODAY).state, 'unknown');
  });

  test('validityDays만 있고 issuedAt이 없으면 unknown', () => {
    assert.equal(documentExpiry({ validityDays: 90 }, TODAY).state, 'unknown');
  });

  test('연말을 넘는 발급일+유효일수도 정상 계산', () => {
    const result = documentExpiry({ issuedAt: '2026-12-20', validityDays: 30 }, TODAY);
    assert.equal(result.validUntil, '2027-01-19');
  });
});

describe('documentExpiry - 상태 분류', () => {
  test('만료 당일(D-0)은 그날까지 유효하므로 expired가 아니라 expiring', () => {
    const result = documentExpiry({ validUntil: '2026-09-14' }, TODAY);
    assert.equal(result.daysLeft, 0);
    assert.equal(result.state, 'expiring');
  });

  test('하루 지나면 expired', () => {
    const result = documentExpiry({ validUntil: '2026-09-13' }, TODAY);
    assert.equal(result.daysLeft, -1);
    assert.equal(result.state, 'expired');
  });

  test('14일 이내 만료는 expiring', () => {
    assert.equal(documentExpiry({ validUntil: '2026-09-28' }, TODAY).state, 'expiring');
  });

  test('15일 이상 남으면 valid', () => {
    assert.equal(documentExpiry({ validUntil: '2026-09-29' }, TODAY).state, 'valid');
  });

  test('issuedAt+validityDays로 계산한 기한이 이미 지났으면 expired', () => {
    const result = documentExpiry({ issuedAt: '2026-05-01', validityDays: 90 }, TODAY);
    assert.equal(result.validUntil, '2026-07-30');
    assert.equal(result.state, 'expired');
  });
});
