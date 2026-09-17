import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectDeadlineTomorrow } from './deadlineTomorrow.ts';
import type { Program, Application } from './board.ts';
import type { TeamProfile } from './eligibility.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다. digest.test.ts와 동일한 규칙.
function kst(dateStr: string, time = '12:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

const TODAY = kst('2026-09-14');

const PROFILE: TeamProfile = { hasBusinessRegistration: false, region: '서울' };

function program(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    title: '테스트 공고',
    organizer: '테스트기관',
    sourceUrl: 'https://example.com/p-1',
    category: '정부지원사업',
    applyEnd: '2026-12-31',
    tags: [],
    source: 'manual',
    aliasTitles: [],
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'a-1',
    programId: 'p-1',
    status: '작성중',
    owner: 'K',
    priority: 'mid',
    documentIds: [],
    ...overrides,
  };
}

describe('selectDeadlineTomorrow', () => {
  test('내일(D-1) 마감이면서 지원건이 없는 공고를 포함한다', () => {
    const p = program({ id: 'p-1', title: '무주공고', applyEnd: '2026-09-15' }); // D-1
    const result = selectDeadlineTomorrow([p], [], [], PROFILE, TODAY);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.program.title, '무주공고');
  });

  test('내일(D-1) 마감이면서 제출 전 단계(검토중/준비/작성중) 지원건이 있으면 포함한다', () => {
    for (const status of ['검토중', '준비', '작성중'] as const) {
      const p = program({ id: `p-${status}`, applyEnd: '2026-09-15' });
      const a = application({ id: `a-${status}`, programId: `p-${status}`, status });
      const result = selectDeadlineTomorrow([p], [a], [], PROFILE, TODAY);
      assert.equal(result.length, 1, `${status} 상태는 포함되어야 한다`);
    }
  });

  test('내일(D-1) 마감이어도 제출완료면 할 일이 없으므로 제외한다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-09-15' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '제출완료' });
    assert.deepEqual(selectDeadlineTomorrow([p], [a], [], PROFILE, TODAY), []);
  });

  test('내일(D-1) 마감이어도 서류통과/최종선정/탈락이면 제외한다', () => {
    for (const status of ['서류통과', '최종선정', '탈락'] as const) {
      const p = program({ id: `p-${status}`, applyEnd: '2026-09-15' });
      const a = application({ id: `a-${status}`, programId: `p-${status}`, status });
      assert.deepEqual(selectDeadlineTomorrow([p], [a], [], PROFILE, TODAY), [], `${status}는 제외되어야 한다`);
    }
  });

  test('지원건이 여럿이면 하나라도 제출 전 단계면 포함한다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-09-15' });
    const done = application({ id: 'a-done', programId: 'p-1', status: '제출완료' });
    const inProgress = application({ id: 'a-progress', programId: 'p-1', status: '작성중' });
    const result = selectDeadlineTomorrow([p], [done, inProgress], [], PROFILE, TODAY);
    assert.equal(result.length, 1);
  });

  test('오늘(D-day) 마감은 포함하지 않는다 — 그건 08:30 다이제스트 몫이다', () => {
    const p = program({ id: 'p-today', applyEnd: '2026-09-14' });
    assert.deepEqual(selectDeadlineTomorrow([p], [], [], PROFILE, TODAY), []);
  });

  test('모레(D-2) 마감은 포함하지 않는다', () => {
    const p = program({ id: 'p-d2', applyEnd: '2026-09-16' });
    assert.deepEqual(selectDeadlineTomorrow([p], [], [], PROFILE, TODAY), []);
  });

  test('데이터가 아예 없으면 빈 배열', () => {
    assert.deepEqual(selectDeadlineTomorrow([], [], [], PROFILE, TODAY), []);
  });
});
