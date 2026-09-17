import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectDeadlineClosed } from './deadlineClosed.ts';
import type { Program, Application } from './board.ts';
import type { TeamProfile } from './eligibility.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다. deadlineTomorrow.test.ts와 동일한 규칙.
function kst(dateStr: string, time = '09:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

// today = 2026-09-15 KST. applyEnd가 2026-09-14면 closureDate(applyEnd+1) = 2026-09-15 = 오늘.
const TODAY = kst('2026-09-15');

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

describe('selectDeadlineClosed', () => {
  describe('커서 null(최초 실행)', () => {
    test('오늘 막 마감통지일이 된 공고만 고른다', () => {
      const p = program({ id: 'p-today', applyEnd: '2026-09-14' }); // closureDate = 2026-09-15 = 오늘
      const result = selectDeadlineClosed([p], [], [], PROFILE, TODAY, null);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.view.program.id, 'p-today');
    });

    test('과거 이력을 쏟아내지 않는다 — 어제 이전에 마감통지일이 된 공고는 제외', () => {
      const p = program({ id: 'p-old', applyEnd: '2026-09-01' }); // closureDate = 2026-09-02, 한참 지남
      assert.deepEqual(selectDeadlineClosed([p], [], [], PROFILE, TODAY, null), []);
    });

    test('아직 마감 전인 공고는 제외', () => {
      const p = program({ id: 'p-future', applyEnd: '2026-12-31' });
      assert.deepEqual(selectDeadlineClosed([p], [], [], PROFILE, TODAY, null), []);
    });
  });

  describe('커서가 있을 때', () => {
    test('커서 이후 ~ 오늘까지만 고른다(누락된 날 자동 따라잡기)', () => {
      const p1 = program({ id: 'p-1', applyEnd: '2026-09-11' }); // closureDate 09-12
      const p2 = program({ id: 'p-2', applyEnd: '2026-09-12' }); // closureDate 09-13
      const p3 = program({ id: 'p-3', applyEnd: '2026-09-13' }); // closureDate 09-14
      const p4 = program({ id: 'p-4', applyEnd: '2026-09-14' }); // closureDate 09-15(오늘)
      const cursor = '2026-09-11'; // closureDate 09-11까지는 이미 알렸다(마지막으로 반영된 날)
      const result = selectDeadlineClosed([p1, p2, p3, p4], [], [], PROFILE, TODAY, cursor);
      assert.deepEqual(
        result.map((r) => r.view.program.id),
        ['p-1', 'p-2', 'p-3', 'p-4'],
      );
    });

    test('커서와 같은 날짜에 이미 알린 공고는 두 번 알리지 않는다', () => {
      const p = program({ id: 'p-today', applyEnd: '2026-09-14' }); // closureDate = 오늘
      const cursor = '2026-09-15'; // 오늘까지 이미 커서가 전진해 있음
      assert.deepEqual(selectDeadlineClosed([p], [], [], PROFILE, TODAY, cursor), []);
    });
  });

  describe('지원 상태 3분류', () => {
    test('지원건 중 하나라도 제출 이후 상태(제출완료/서류통과/최종선정/탈락)면 submitted', () => {
      for (const status of ['제출완료', '서류통과', '최종선정', '탈락'] as const) {
        const p = program({ id: `p-${status}`, applyEnd: '2026-09-14' });
        const a = application({ id: `a-${status}`, programId: `p-${status}`, status });
        const result = selectDeadlineClosed([p], [a], [], PROFILE, TODAY, null);
        assert.equal(result.length, 1);
        assert.equal(result[0]!.category, 'submitted', `${status}는 submitted여야 한다`);
      }
    });

    test('지원건이 없으면 unapplied', () => {
      const p = program({ id: 'p-none', applyEnd: '2026-09-14' });
      const result = selectDeadlineClosed([p], [], [], PROFILE, TODAY, null);
      assert.equal(result[0]!.category, 'unapplied');
    });

    test("지원건이 '미지원'만 있으면 unapplied", () => {
      const p = program({ id: 'p-unapplied', applyEnd: '2026-09-14' });
      const a = application({ id: 'a-1', programId: 'p-unapplied', status: '미지원' });
      const result = selectDeadlineClosed([p], [a], [], PROFILE, TODAY, null);
      assert.equal(result[0]!.category, 'unapplied');
    });

    test('지원건은 있는데 전부 제출 전 단계(검토중/준비/작성중)면 unsubmitted', () => {
      for (const status of ['검토중', '준비', '작성중'] as const) {
        const p = program({ id: `p-${status}`, applyEnd: '2026-09-14' });
        const a = application({ id: `a-${status}`, programId: `p-${status}`, status });
        const result = selectDeadlineClosed([p], [a], [], PROFILE, TODAY, null);
        assert.equal(result[0]!.category, 'unsubmitted', `${status}는 unsubmitted여야 한다`);
      }
    });

    test('제출완료 지원건이 하나라도 있으면 미지원 지원건이 섞여 있어도 submitted', () => {
      const p = program({ id: 'p-mixed', applyEnd: '2026-09-14' });
      const submitted = application({ id: 'a-1', programId: 'p-mixed', status: '제출완료' });
      const unapplied = application({ id: 'a-2', programId: 'p-mixed', status: '미지원' });
      const result = selectDeadlineClosed([p], [submitted, unapplied], [], PROFILE, TODAY, null);
      assert.equal(result[0]!.category, 'submitted');
    });
  });

  test('데이터가 아예 없으면 빈 배열', () => {
    assert.deepEqual(selectDeadlineClosed([], [], [], PROFILE, TODAY, null), []);
  });
});
