import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, buildCalendarEvents, groupEventsByDate, type Application, type Program } from './board.ts';

function kst(dateStr: string, time = '12:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

const today = kst('2026-09-15');

function program(overrides: Partial<Program> & Pick<Program, 'id' | 'applyEnd'>): Program {
  return {
    title: overrides.id,
    organizer: '기관',
    sourceUrl: '#',
    category: '공모전',
    tags: [],
    source: 'manual',
    aliasTitles: [],
    ...overrides,
  };
}

function application(overrides: Partial<Application> & Pick<Application, 'id' | 'programId'>): Application {
  return { status: '검토중', owner: 'K', priority: 'mid', documentIds: [], ...overrides };
}

const profile = { hasBusinessRegistration: false, region: '서울' };

describe('buildCalendarEvents', () => {
  const board = buildBoard({
    programs: [
      program({
        id: 'p1',
        title: '나 공고',
        applyStart: '2026-09-01',
        applyEnd: '2026-10-20',
        announceDate: '2026-11-30',
      }),
      program({ id: 'p2', title: '가 공고', applyEnd: '2026-10-20' }),
      program({ id: 'closed', title: '지난 공고', applyEnd: '2026-08-31', announceDate: '2026-09-10' }),
      program({ id: 'closed-pending', title: '결과 대기', applyEnd: '2026-09-01', announceDate: '2026-10-01' }),
    ],
    applications: [
      application({ id: 'a1', programId: 'p1', targetSubmitDate: '2026-10-18' }),
      application({ id: 'a2', programId: 'p1', owner: 'J' }), // 내부 마감 없음 → 이벤트 없음
      application({ id: 'a3', programId: 'closed', targetSubmitDate: '2026-08-29' }),
    ],
    documents: [],
    profile,
    today,
  });

  test('날짜가 있는 필드마다 이벤트 하나, 없는 필드는 만들지 않는다', () => {
    const keys = board.events.map((e) => e.key);
    assert.deepEqual(keys, [
      'target:a3',
      'apply-end:closed',
      // 9/1: 마감(closed-pending)이 접수 시작(p1)보다 먼저 — 같은 날은 종류 중요도순
      'apply-end:closed-pending',
      'apply-start:p1',
      'announce:closed',
      'announce:closed-pending',
      'target:a1',
      'apply-end:p2',
      'apply-end:p1',
      'announce:p1',
    ]);
  });

  test('같은 날은 종류 중요도 → 제목 순 (마감이 먼저, 그다음 가나다)', () => {
    const sameDay = board.events.filter((e) => e.date === '2026-10-20');
    assert.deepEqual(
      sameDay.map((e) => e.program.program.title),
      ['가 공고', '나 공고'],
    );
  });

  test('daysLeft는 오늘 기준', () => {
    const applyEnd = board.events.find((e) => e.key === 'apply-end:p1')!;
    assert.equal(applyEnd.daysLeft, 35);
    const past = board.events.find((e) => e.key === 'apply-end:closed')!;
    assert.equal(past.daysLeft, -15);
  });

  test('stale: 마감된 공고의 지난 이벤트만. 아직 남은 발표일은 살아 있다', () => {
    const stale = board.events.filter((e) => e.stale).map((e) => e.key);
    assert.deepEqual(stale, ['target:a3', 'apply-end:closed', 'apply-end:closed-pending', 'announce:closed']);
    assert.equal(board.events.find((e) => e.key === 'announce:closed-pending')!.stale, false);
  });

  test('내부 마감 이벤트는 해당 지원건을 가리킨다', () => {
    const target = board.events.find((e) => e.key === 'target:a1')!;
    assert.equal(target.application?.application.id, 'a1');
    assert.equal(target.program.program.id, 'p1');
  });

  test('빈 입력이면 빈 배열', () => {
    assert.deepEqual(buildCalendarEvents([], today), []);
  });
});

describe('groupEventsByDate', () => {
  test('날짜별 묶음, 입력 순서 보존', () => {
    const board = buildBoard({
      programs: [
        program({ id: 'p1', applyEnd: '2026-10-20', applyStart: '2026-10-01' }),
        program({ id: 'p2', applyEnd: '2026-10-20' }),
      ],
      applications: [],
      documents: [],
      profile,
      today,
    });
    const byDate = groupEventsByDate(board.events);
    assert.deepEqual([...byDate.keys()], ['2026-10-01', '2026-10-20']);
    assert.deepEqual(
      byDate.get('2026-10-20')!.map((e) => e.key),
      ['apply-end:p1', 'apply-end:p2'],
    );
  });
});
