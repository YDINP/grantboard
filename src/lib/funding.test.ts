import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { netAmountKrw, summarizeFunding, reachableViews, formatKrw, type Funding } from './funding.ts';
import type { Program, ProgramView } from './board.ts';
import type { DeadlineState } from './schedule.ts';
import type { EligibilityVerdict } from './eligibility.ts';

/**
 * ProgramView를 손으로 만든다. funding.ts는 날짜·자격을 스스로 판정하지 않으므로
 * deadline.state와 eligibility.verdict를 테스트가 직접 꽂아주는 게 정확한 단위 테스트다
 * (여기서 실제 날짜를 쓰면 schedule.ts를 다시 테스트하는 셈이 된다).
 */
function view(
  id: string,
  funding: Funding | undefined,
  opts: { state?: DeadlineState; verdict?: EligibilityVerdict } = {},
): ProgramView {
  const program = {
    id,
    title: id,
    organizer: '테스트기관',
    sourceUrl: 'https://example.com',
    category: '공모전',
    applyEnd: '2026-12-31',
    tags: [],
    source: 'manual',
    aliasTitles: [],
    funding,
  } as unknown as Program;

  return {
    program,
    deadline: { daysLeft: 10, state: opts.state ?? 'open' },
    startsIn: null,
    eligibility: { verdict: opts.verdict ?? 'eligible', reasons: [] },
    applications: [],
  };
}

describe('netAmountKrw - 자기부담금 차감', () => {
  test('자기부담금이 없으면 금액 그대로', () => {
    assert.equal(netAmountKrw({ type: '상금', amountKrw: 3_000_000 }), 3_000_000);
  });

  test('자기부담금 비율만큼 깎는다', () => {
    assert.equal(netAmountKrw({ type: '사업화자금', amountKrw: 10_000_000, selfBurdenPct: 30 }), 7_000_000);
  });

  test('금액이 비어 있으면 null — 0이 아니다', () => {
    assert.equal(netAmountKrw({ type: '지분투자' }), null);
  });

  test('funding 자체가 없으면 null', () => {
    assert.equal(netAmountKrw(undefined), null);
  });

  test('자기부담 100%면 0 (금액 미기입과 구분된다)', () => {
    assert.equal(netAmountKrw({ type: '융자', amountKrw: 5_000_000, selfBurdenPct: 100 }), 0);
  });
});

describe('reachableViews - 집계 대상 선별', () => {
  test('마감된 공고는 뺀다', () => {
    const views = [
      view('open', { type: '상금', amountKrw: 1_000_000 }),
      view('closed', { type: '상금', amountKrw: 9_000_000 }, { state: 'closed' }),
    ];
    assert.deepEqual(
      reachableViews(views).map((v) => v.program.id),
      ['open'],
    );
  });

  test('명백한 부적격(ineligible)은 뺀다 — 없는 돈을 세지 않는다', () => {
    const views = [view('no', { type: '상금', amountKrw: 1_000_000 }, { verdict: 'ineligible' })];
    assert.deepEqual(reachableViews(views), []);
  });

  test("needs-check는 남긴다 — 사람이 판단할 몫이고, 빼면 합계가 실제보다 작아진다", () => {
    const views = [view('maybe', { type: '상금', amountKrw: 1_000_000 }, { verdict: 'needs-check' })];
    assert.deepEqual(
      reachableViews(views).map((v) => v.program.id),
      ['maybe'],
    );
  });

  test('접수예정(upcoming)도 남긴다 — 아직 노릴 수 있는 돈이다', () => {
    const views = [view('soon', { type: '상금', amountKrw: 1_000_000 }, { state: 'upcoming' })];
    assert.equal(reachableViews(views).length, 1);
  });
});

describe('summarizeFunding - 성격별 집계', () => {
  test('성격별로 묶고 실수령으로 더한다', () => {
    const result = summarizeFunding([
      view('a', { type: '상금', amountKrw: 3_000_000 }),
      view('b', { type: '상금', amountKrw: 2_000_000 }),
      view('c', { type: '사업화자금', amountKrw: 10_000_000, selfBurdenPct: 30 }),
    ]);

    assert.equal(result.netKrw, 12_000_000);
    assert.deepEqual(result.buckets, [
      { type: '상금', count: 2, countedCount: 2, netKrw: 5_000_000 },
      { type: '사업화자금', count: 1, countedCount: 1, netKrw: 7_000_000 },
    ]);
  });

  test('버킷 순서는 TYPE_ORDER를 따른다 — 입력 순서와 무관하다', () => {
    const result = summarizeFunding([
      view('a', { type: '융자', amountKrw: 1 }),
      view('b', { type: '상금', amountKrw: 1 }),
      view('c', { type: '크레딧', amountKrw: 1 }),
    ]);
    assert.deepEqual(
      result.buckets.map((b) => b.type),
      ['상금', '크레딧', '융자'],
    );
  });

  test('금액 미기입은 합계에서 빠지고 건수로 따로 보고된다', () => {
    const result = summarizeFunding([
      view('a', { type: '지분투자', amountKrw: 50_000_000 }),
      view('b', { type: '지분투자' }),
    ]);

    assert.equal(result.netKrw, 50_000_000);
    assert.equal(result.unknownAmountCount, 1);
    // count는 2, 합계에 들어간 건 1 — 이 차이가 보여야 합계를 과소평가로 읽지 않는다.
    assert.deepEqual(result.buckets, [
      { type: '지분투자', count: 2, countedCount: 1, netKrw: 50_000_000 },
    ]);
  });

  test('funding이 없는 공고는 미분류로 센다 — 버킷에 끼지 않는다', () => {
    const result = summarizeFunding([view('a', undefined), view('b', { type: '상금', amountKrw: 1_000_000 })]);

    assert.equal(result.unclassifiedCount, 1);
    assert.equal(result.unknownAmountCount, 0);
    assert.equal(result.buckets.length, 1);
  });

  test('빈 입력은 0원 + 빈 버킷', () => {
    assert.deepEqual(summarizeFunding([]), {
      buckets: [],
      netKrw: 0,
      unknownAmountCount: 0,
      unclassifiedCount: 0,
    });
  });
});

describe('formatKrw - 만원 단위 표기', () => {
  test('만원 단위', () => {
    assert.equal(formatKrw(3_000_000), '300만원');
  });

  test('천 단위 구분', () => {
    assert.equal(formatKrw(70_000_000), '7,000만원');
  });

  test('1억 이상은 억으로 끊는다', () => {
    assert.equal(formatKrw(100_000_000), '1억원');
    assert.equal(formatKrw(150_000_000), '1억 5,000만원');
  });

  test('0은 0원', () => {
    assert.equal(formatKrw(0), '0원');
  });

  test('만원 미만은 원 단위로 남긴다', () => {
    assert.equal(formatKrw(5_000), '5,000원');
  });
});
