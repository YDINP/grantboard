import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthGrid, monthDiff, monthSpan, shiftMonth } from './calendar.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다.
function kst(dateStr: string, time = '12:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

describe('buildMonthGrid', () => {
  test('2026년 9월은 화요일에 시작해 30일까지, 5주 격자', () => {
    const grid = buildMonthGrid(2026, 9, kst('2026-09-15'));
    assert.equal(grid.key, '2026-09');
    assert.equal(grid.label, '2026년 9월');
    assert.equal(grid.weeks.length, 5);
    // 첫 주: 일(8/30) 월(8/31) 화(9/1) …
    const firstWeek = grid.weeks[0];
    assert.deepEqual(
      firstWeek.map((c) => c.date),
      ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'],
    );
    assert.equal(firstWeek[0].inMonth, false);
    assert.equal(firstWeek[2].inMonth, true);
    assert.equal(firstWeek[2].weekday, 2);
    // 마지막 칸은 토요일이고, 9/30 다음은 10월 채움 칸
    const cells = grid.weeks.flat();
    assert.equal(cells.length, 35);
    assert.equal(cells.at(-1)?.weekday, 6);
    assert.equal(cells.at(-1)?.date, '2026-10-03');
    assert.equal(cells.filter((c) => c.inMonth).length, 30);
  });

  test('1일이 일요일이면 앞 채움 칸이 없다 (2026년 11월)', () => {
    const grid = buildMonthGrid(2026, 11, kst('2026-09-15'));
    assert.equal(grid.weeks[0][0].date, '2026-11-01');
    assert.equal(grid.weeks[0][0].inMonth, true);
    assert.equal(grid.weeks.flat().filter((c) => c.inMonth).length, 30);
  });

  test('말일이 토요일이면 뒤 채움 칸이 없다 (2026년 10월 31일 = 토)', () => {
    const grid = buildMonthGrid(2026, 10, kst('2026-09-15'));
    const cells = grid.weeks.flat();
    assert.equal(cells.at(-1)?.date, '2026-10-31');
    assert.equal(cells.at(-1)?.inMonth, true);
  });

  test('윤년 2월은 29칸, 평년 2월은 28칸 (2100년은 100년 규칙으로 평년)', () => {
    const leap = buildMonthGrid(2028, 2, kst('2028-02-01'));
    assert.equal(leap.weeks.flat().filter((c) => c.inMonth).length, 29);
    assert.ok(leap.weeks.flat().some((c) => c.date === '2028-02-29' && c.inMonth));

    const common = buildMonthGrid(2027, 2, kst('2027-02-01'));
    assert.equal(common.weeks.flat().filter((c) => c.inMonth).length, 28);

    const century = buildMonthGrid(2100, 2, kst('2100-02-01'));
    assert.equal(century.weeks.flat().filter((c) => c.inMonth).length, 28);
  });

  test('평년 2월 1일이 일요일이면 정확히 4주 (2026년 2월)', () => {
    const grid = buildMonthGrid(2026, 2, kst('2026-02-10'));
    assert.equal(grid.weeks.length, 4);
    assert.equal(grid.weeks[0][0].date, '2026-02-01');
    assert.equal(grid.weeks[3][6].date, '2026-02-28');
  });

  test('1일이 토요일이고 31일까지면 6주 (2026년 8월)', () => {
    const grid = buildMonthGrid(2026, 8, kst('2026-08-10'));
    assert.equal(grid.weeks.length, 6);
    assert.equal(grid.weeks[0][6].date, '2026-08-01');
  });

  test('연말: 12월 격자의 뒤 채움 칸은 다음 해 1월', () => {
    const grid = buildMonthGrid(2026, 12, kst('2026-12-15'));
    const cells = grid.weeks.flat();
    // 2026-12-31은 목요일 → 금(1/1), 토(1/2) 채움
    assert.deepEqual(
      cells.slice(-2).map((c) => c.date),
      ['2027-01-01', '2027-01-02'],
    );
    assert.equal(cells.at(-1)?.inMonth, false);
  });

  test('연초: 1월 격자의 앞 채움 칸은 전년도 12월', () => {
    const grid = buildMonthGrid(2027, 1, kst('2027-01-05'));
    // 2027-01-01은 금요일 → 일~목은 2026-12-27..31
    assert.equal(grid.weeks[0][0].date, '2026-12-27');
    assert.equal(grid.weeks[0][4].date, '2026-12-31');
    assert.equal(grid.weeks[0][5].date, '2027-01-01');
    assert.equal(grid.weeks[0][5].inMonth, true);
  });

  test('오늘 표시는 KST 달력 기준 — UTC로는 아직 9/30이어도 KST가 10/1이면 10/1이 오늘', () => {
    // UTC 2026-09-30T15:30Z = KST 2026-10-01 00:30
    const today = new Date(Date.UTC(2026, 8, 30, 15, 30, 0));
    const oct = buildMonthGrid(2026, 10, today);
    const todays = oct.weeks.flat().filter((c) => c.isToday);
    assert.deepEqual(
      todays.map((c) => c.date),
      ['2026-10-01'],
    );
    // 9월 격자에서도 10/1 채움 칸이 오늘로 표시된다(같은 날짜니까), 9/30은 아니다.
    const sep = buildMonthGrid(2026, 9, today);
    assert.deepEqual(
      sep.weeks.flat().filter((c) => c.isToday).map((c) => c.date),
      ['2026-10-01'],
    );
  });

  test('KST 자정 직전은 아직 전날', () => {
    // UTC 2026-09-30T14:59:59Z = KST 2026-09-30 23:59:59
    const today = new Date(Date.UTC(2026, 8, 30, 14, 59, 59));
    const sep = buildMonthGrid(2026, 9, today);
    assert.deepEqual(
      sep.weeks.flat().filter((c) => c.isToday).map((c) => c.date),
      ['2026-09-30'],
    );
  });

  test('오늘이 다른 달이면 isToday 칸이 없다', () => {
    const grid = buildMonthGrid(2026, 3, kst('2026-09-15'));
    assert.equal(grid.weeks.flat().some((c) => c.isToday), false);
  });
});

describe('shiftMonth / monthDiff', () => {
  test('연도 넘김 양방향', () => {
    assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
    assert.deepEqual(shiftMonth({ year: 2027, month: 1 }, -1), { year: 2026, month: 12 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 9 }, 15), { year: 2027, month: 12 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 3 }, -27), { year: 2023, month: 12 });
  });

  test('monthDiff는 shiftMonth의 역연산', () => {
    const base = { year: 2026, month: 9 };
    for (const delta of [-25, -1, 0, 1, 4, 30]) {
      assert.equal(monthDiff(shiftMonth(base, delta), base), delta);
    }
  });
});

describe('monthSpan', () => {
  const today = kst('2026-09-15');

  test('이벤트가 없어도 오늘의 앞뒤 한 달은 렌더한다', () => {
    assert.deepEqual(monthSpan([], today), [
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
  });

  test('이벤트가 있는 달까지 연속으로 포함한다', () => {
    const months = monthSpan(['2026-07-15', '2027-01-03'], today);
    assert.deepEqual(months[0], { year: 2026, month: 7 });
    assert.deepEqual(months.at(-1), { year: 2027, month: 1 });
    assert.equal(months.length, 7);
  });

  test('오늘 달이 이벤트 범위 밖이어도 항상 포함된다', () => {
    const months = monthSpan(['2026-11-01'], kst('2026-02-10'));
    assert.ok(months.some((m) => m.year === 2026 && m.month === 2));
    assert.ok(months.some((m) => m.year === 2026 && m.month === 11));
  });

  test('오타 연도(2062년)가 있어도 상한을 넘겨 렌더하지 않는다', () => {
    const months = monthSpan(['2062-01-01', '2010-01-01'], today, { maxBefore: 3, maxAfter: 4 });
    assert.deepEqual(months[0], { year: 2026, month: 6 });
    assert.deepEqual(months.at(-1), { year: 2027, month: 1 });
  });
});
