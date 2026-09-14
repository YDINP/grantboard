import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, deadlineState } from './schedule.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다.
function kst(dateStr: string, time = '12:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  // KST = UTC+9이므로 UTC로 변환하려면 9시간을 뺀다.
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

describe('daysUntil', () => {
  test('오늘 날짜는 0', () => {
    assert.equal(daysUntil('2026-09-14', kst('2026-09-14')), 0);
  });

  test('내일은 1, 어제는 -1', () => {
    const today = kst('2026-09-14');
    assert.equal(daysUntil('2026-09-15', today), 1);
    assert.equal(daysUntil('2026-09-13', today), -1);
  });

  test('연말 -> 연초 경계 (12/31 기준 1/1은 +1)', () => {
    assert.equal(daysUntil('2027-01-01', kst('2026-12-31')), 1);
  });

  test('연초 -> 연말 경계 (1/1 기준 작년 12/31은 -1)', () => {
    assert.equal(daysUntil('2026-12-31', kst('2027-01-01')), -1);
  });

  test('연도가 다른 2월 29일(윤년) 경계도 정상 계산', () => {
    // 2028년은 윤년. 2028-02-28 기준 2028-02-29는 +1, 2028-03-01은 +2.
    assert.equal(daysUntil('2028-02-29', kst('2028-02-28')), 1);
    assert.equal(daysUntil('2028-03-01', kst('2028-02-28')), 2);
  });

  test('KST 자정 경계 - UTC로는 전날이지만 KST로는 당일인 시각도 올바르게 0을 반환', () => {
    // UTC 2026-09-13T16:00:00Z = KST 2026-09-14T01:00:00 (KST로는 이미 9/14)
    const today = new Date(Date.UTC(2026, 8, 13, 16, 0, 0));
    assert.equal(daysUntil('2026-09-14', today), 0);
    assert.equal(daysUntil('2026-09-13', today), -1);
  });

  test('KST 자정 직전 - UTC로는 당일이지만 KST로는 다음날 새벽이 되기 전 경계', () => {
    // UTC 2026-09-13T14:59:59Z = KST 2026-09-13T23:59:59 (아직 9/13)
    const today = new Date(Date.UTC(2026, 8, 13, 14, 59, 59));
    assert.equal(daysUntil('2026-09-13', today), 0);
    assert.equal(daysUntil('2026-09-14', today), 1);
  });
});

describe('deadlineState', () => {
  const today = kst('2026-09-14');

  test('마감일이 지났으면 closed', () => {
    assert.equal(deadlineState({ applyEnd: '2026-09-13' }, today), 'closed');
  });

  test('마감 당일(D-0)은 urgent', () => {
    assert.equal(deadlineState({ applyEnd: '2026-09-14' }, today), 'urgent');
  });

  test('마감 3일 전까지는 urgent', () => {
    assert.equal(deadlineState({ applyEnd: '2026-09-17' }, today), 'urgent');
  });

  test('마감 4~7일 전은 soon', () => {
    assert.equal(deadlineState({ applyEnd: '2026-09-18' }, today), 'soon');
    assert.equal(deadlineState({ applyEnd: '2026-09-21' }, today), 'soon');
  });

  test('마감 8일 이상 남으면 open', () => {
    assert.equal(deadlineState({ applyEnd: '2026-09-22' }, today), 'open');
  });

  test('접수 시작일이 아직 오지 않았으면 upcoming (마감일과 무관)', () => {
    assert.equal(
      deadlineState({ applyStart: '2026-09-20', applyEnd: '2026-09-25' }, today),
      'upcoming',
    );
  });

  test('접수 시작일이 오늘이면 upcoming이 아니라 applyEnd 기준으로 판정', () => {
    assert.equal(
      deadlineState({ applyStart: '2026-09-14', applyEnd: '2026-09-14' }, today),
      'urgent',
    );
  });

  test('연말/연초 경계를 넘나드는 마감일도 올바르게 분류', () => {
    // 오늘 2026-12-30 기준 마감 2027-01-01 -> D-2 -> urgent
    assert.equal(
      deadlineState({ applyEnd: '2027-01-01' }, kst('2026-12-30')),
      'urgent',
    );
  });
});
