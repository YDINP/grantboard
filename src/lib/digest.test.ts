import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, selectDigestSections, digestUrgency, shouldMentionHere } from './digest.ts';
import type { Program, Application, Document } from './board.ts';
import type { TeamProfile } from './eligibility.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다. schedule.test.ts와 동일한 규칙.
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

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: 'd-1',
    name: '테스트 서류',
    kind: '증빙',
    reusable: true,
    ready: true,
    ...overrides,
  };
}

describe('buildDigest - 조용한 날', () => {
  test('네 범주 모두 비어 있으면 null을 반환한다 (알림을 보내지 않는다)', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-12-31' }); // 마감 여유 있음
    const a = application({
      id: 'a-1',
      programId: 'p-1',
      status: '제출완료',
      targetSubmitDate: '2026-09-01', // 지났지만 이미 제출완료라 overdue 아님
      submittedAt: '2026-08-30',
    });
    const doc = document({ id: 'd-1', validUntil: '2027-01-01' }); // 만료 임박 아님

    const result = buildDigest([p], [a], [doc], PROFILE, TODAY);
    assert.equal(result, null);
  });

  test('데이터가 아예 없어도 null', () => {
    assert.equal(buildDigest([], [], [], PROFILE, TODAY), null);
  });
});

describe('buildDigest - 오늘/3일 이내 마감', () => {
  test('urgent 상태(마감 3일 이내) 공고를 포함하고, 지원건의 담당자를 함께 보여준다', () => {
    const p = program({ id: 'p-urgent', title: '마감임박공고', applyEnd: '2026-09-16', sourceUrl: 'https://example.com/urgent' });
    const a = application({ id: 'a-urgent', programId: 'p-urgent', owner: 'K', status: '작성중' });

    const result = buildDigest([p], [a], [], PROFILE, TODAY);
    assert.ok(result);
    assert.match(result!, /오늘\/3일 이내 마감/);
    assert.match(result!, /마감임박공고 — D-2 · 담당 K · https:\/\/example\.com\/urgent/);
  });

  test('마감 당일은 D-day로 표기한다', () => {
    const p = program({ id: 'p-today', title: '오늘마감공고', applyEnd: '2026-09-14' });
    const result = buildDigest([p], [], [], PROFILE, TODAY);
    assert.match(result!, /오늘마감공고 — D-day/);
  });

  test('지원건이 없는 공고는 담당자 미지정으로 표시한다', () => {
    const p = program({ id: 'p-urgent', title: '무주공고', applyEnd: '2026-09-15' });
    const result = buildDigest([p], [], [], PROFILE, TODAY);
    assert.match(result!, /무주공고 — D-1 · 담당 담당자 미지정/);
  });

  test('마감이 4일 이상 남은 공고(soon/open)는 포함하지 않는다', () => {
    const p = program({ id: 'p-soon', applyEnd: '2026-09-20' }); // remaining=6, soon
    const result = buildDigest([p], [], [], PROFILE, TODAY);
    assert.equal(result, null);
  });

  // 실전 사고: 제출완료/서류통과/최종선정/탈락인데 마감이 임박했다는 이유만으로 계속 뜨면
  // "할 일이 없는 건"으로 @here까지 울리게 된다(shouldMentionHere가 이 배열만 본다).
  test('제출완료면 더 할 일이 없으므로 마감이 임박해도 제외한다', () => {
    const p = program({ id: 'p-1', title: '제출완료공고', applyEnd: '2026-09-15' }); // D-1
    const a = application({ id: 'a-1', programId: 'p-1', status: '제출완료' });
    assert.equal(buildDigest([p], [a], [], PROFILE, TODAY), null);
  });

  test('서류통과여도 마감 임박 목록에서 제외한다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-09-14' }); // D-day
    const a = application({ id: 'a-1', programId: 'p-1', status: '서류통과' });
    assert.equal(buildDigest([p], [a], [], PROFILE, TODAY), null);
  });

  test('최종선정·탈락이어도 제외한다', () => {
    const p1 = program({ id: 'p-1', applyEnd: '2026-09-14' });
    const a1 = application({ id: 'a-1', programId: 'p-1', status: '최종선정' });
    const p2 = program({ id: 'p-2', applyEnd: '2026-09-14' });
    const a2 = application({ id: 'a-2', programId: 'p-2', status: '탈락' });
    assert.equal(buildDigest([p1, p2], [a1, a2], [], PROFILE, TODAY), null);
  });

  test('제출 전 단계(검토중/준비/작성중)는 그대로 포함한다', () => {
    for (const status of ['검토중', '준비', '작성중'] as const) {
      const p = program({ id: `p-${status}`, title: `${status}공고`, applyEnd: '2026-09-15' });
      const a = application({ id: `a-${status}`, programId: `p-${status}`, status });
      const result = buildDigest([p], [a], [], PROFILE, TODAY);
      assert.ok(result, `${status} 상태는 포함되어야 한다`);
      assert.match(result!, new RegExp(`${status}공고`));
    }
  });

  test('지원건이 아예 없는 공고는 포함한다 — 지원할지 결정하는 것 자체가 마감 전 할 일이다', () => {
    const p = program({ id: 'p-1', title: '미지원결정필요공고', applyEnd: '2026-09-15' });
    const result = buildDigest([p], [], [], PROFILE, TODAY);
    assert.ok(result);
    assert.match(result!, /미지원결정필요공고/);
  });

  test('지원건이 여럿이면 하나라도 제출 전 단계면 포함한다', () => {
    const p = program({ id: 'p-1', title: '복수지원건공고', applyEnd: '2026-09-15' });
    const done = application({ id: 'a-done', programId: 'p-1', status: '제출완료' });
    const inProgress = application({ id: 'a-progress', programId: 'p-1', status: '작성중' });
    const result = buildDigest([p], [done, inProgress], [], PROFILE, TODAY);
    assert.ok(result);
    assert.match(result!, /복수지원건공고/);
  });

  test('지원건이 여럿이고 전부 제출완료/서류통과면 제외한다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-09-15' });
    const a1 = application({ id: 'a-1', programId: 'p-1', status: '제출완료' });
    const a2 = application({ id: 'a-2', programId: 'p-1', status: '서류통과' });
    assert.equal(buildDigest([p], [a1, a2], [], PROFILE, TODAY), null);
  });
});

describe('selectDigestSections/shouldMentionHere - 실전 회귀: 제출완료 건이 @here를 울리면 안 된다', () => {
  test('제출완료인데 D-1/D-day인 공고만 있으면 deadlineSoon이 비고 @here도 안 울린다', () => {
    const submitted1 = program({ id: 'p-1', title: '모두의 창업 2차', applyEnd: '2026-09-15' }); // D-1
    const a1 = application({ id: 'a-1', programId: 'p-1', status: '제출완료' });
    const submitted2 = program({ id: 'p-2', title: '원티드 AI 챔피언십', applyEnd: '2026-09-16' }); // D-2
    const a2 = application({ id: 'a-2', programId: 'p-2', status: '제출완료' });

    const sections = selectDigestSections([submitted1, submitted2], [a1, a2], [], PROFILE, TODAY);
    assert.equal(sections, null, '할 일이 남은 게 없으니 다이제스트 자체가 조용해야 한다');
  });

  test('제출완료 건과 별개로 작성중인 D-day 공고가 있으면 그것만 뜨고 그 공고로 인해 @here가 울린다', () => {
    const submitted = program({ id: 'p-done', title: '제출완료건', applyEnd: '2026-09-14' }); // D-day
    const aDone = application({ id: 'a-done', programId: 'p-done', status: '제출완료' });
    const inProgress = program({ id: 'p-progress', title: '작성중건', applyEnd: '2026-09-14' }); // D-day
    const aProgress = application({ id: 'a-progress', programId: 'p-progress', status: '작성중' });

    const sections = selectDigestSections([submitted, inProgress], [aDone, aProgress], [], PROFILE, TODAY)!;
    assert.ok(sections);
    assert.equal(sections.deadlineSoon.length, 1);
    assert.equal(sections.deadlineSoon[0]!.program.title, '작성중건');
    assert.equal(shouldMentionHere(sections), true);
  });
});

describe('buildDigest - 내부 마감 초과 미제출', () => {
  test('targetSubmitDate가 지났고 미제출 + 제출전 단계면 경고에 포함한다', () => {
    const p = program({ id: 'p-1', title: '내부마감초과공고', applyEnd: '2026-12-31', sourceUrl: 'https://example.com/over' });
    const a = application({
      id: 'a-1',
      programId: 'p-1',
      owner: 'J',
      status: '작성중',
      targetSubmitDate: '2026-09-10', // 4일 지남
    });

    const result = buildDigest([p], [a], [], PROFILE, TODAY);
    assert.ok(result);
    assert.match(result!, /내부 마감 초과 미제출/);
    assert.match(result!, /내부마감초과공고 — 내부마감 D\+4 · 담당 J · https:\/\/example\.com\/over/);
  });

  test('이미 제출됐으면(submittedAt 존재) 내부 마감이 지나도 경고하지 않는다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-12-31' });
    const a = application({
      id: 'a-1',
      programId: 'p-1',
      status: '제출완료',
      targetSubmitDate: '2026-09-10',
      submittedAt: '2026-09-09',
    });
    assert.equal(buildDigest([p], [a], [], PROFILE, TODAY), null);
  });
});

describe('buildDigest - 서류 만료/만료 임박', () => {
  test('진행 중 지원건에 물려 있는 만료 임박 서류만 포함한다', () => {
    const p = program({ id: 'p-1', title: '서류연결공고' });
    const a = application({ id: 'a-1', programId: 'p-1', owner: 'M', status: '검토중', documentIds: ['d-expiring'] });
    const d = document({ id: 'd-expiring', name: '만료임박서류', validUntil: '2026-09-20' }); // 6일 남음 -> expiring

    const result = buildDigest([p], [a], [d], PROFILE, TODAY);
    assert.ok(result);
    assert.match(result!, /서류 만료\/만료 임박/);
    assert.match(result!, /만료임박서류 \(서류연결공고\) — D-6 · 담당 M/);
  });

  test('만료됐지만 진행 중인 지원건에 안 쓰이면(사용처 없음) 포함하지 않는다', () => {
    const d = document({ id: 'd-unused', validUntil: '2026-01-01' }); // 만료됨, 아무 지원건도 참조 안 함
    assert.equal(buildDigest([], [], [d], PROFILE, TODAY), null);
  });

  test('만료됐지만 결과 계열(탈락 등) 지원건에만 쓰이면 포함하지 않는다', () => {
    const p = program({ id: 'p-1' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '탈락', documentIds: ['d-1'] });
    const d = document({ id: 'd-1', validUntil: '2026-01-01' }); // 만료됨
    assert.equal(buildDigest([p], [a], [d], PROFILE, TODAY), null);
  });

  test('유효기한이 14일보다 많이 남은 서류는 포함하지 않는다', () => {
    const p = program({ id: 'p-1' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '검토중', documentIds: ['d-1'] });
    const d = document({ id: 'd-1', validUntil: '2026-10-31' });
    assert.equal(buildDigest([p], [a], [d], PROFILE, TODAY), null);
  });
});

describe('buildDigest - 발표일 경과', () => {
  test('발표 예정일이 지났는데 결과 계열이 아니면 포함한다', () => {
    const p = program({ id: 'p-1', title: '발표경과공고', announceDate: '2026-09-10', sourceUrl: 'https://example.com/ann' });
    const a = application({ id: 'a-1', programId: 'p-1', owner: 'K', status: '서류통과' });

    const result = buildDigest([p], [a], [], PROFILE, TODAY);
    assert.ok(result);
    assert.match(result!, /발표일 경과, 결과 확인 필요/);
    assert.match(result!, /발표경과공고 — 발표 D\+4 · 담당 K · https:\/\/example\.com\/ann/);
  });

  test('결과가 이미 나왔으면(최종선정/탈락) 경고하지 않는다', () => {
    const p = program({ id: 'p-1', announceDate: '2026-09-10' });
    const a1 = application({ id: 'a-1', programId: 'p-1', status: '최종선정' });
    const p2 = program({ id: 'p-2', announceDate: '2026-09-10' });
    const a2 = application({ id: 'a-2', programId: 'p-2', status: '탈락' });
    assert.equal(buildDigest([p, p2], [a1, a2], [], PROFILE, TODAY), null);
  });
});

describe('buildDigest - 종합', () => {
  test('여러 범주가 동시에 있으면 마감임박 -> 내부마감초과 -> 서류만료 -> 발표경과 순으로 묶는다', () => {
    const pUrgent = program({ id: 'p-urgent', title: '마감임박', applyEnd: '2026-09-15' });
    const pOverdue = program({ id: 'p-overdue', title: '내부마감초과', applyEnd: '2026-12-31' });
    const aOverdue = application({
      id: 'a-overdue',
      programId: 'p-overdue',
      status: '작성중',
      targetSubmitDate: '2026-09-01',
    });
    const pDoc = program({ id: 'p-doc', title: '서류연결' });
    const aDoc = application({ id: 'a-doc', programId: 'p-doc', status: '준비', documentIds: ['d-1'] });
    const d = document({ id: 'd-1', name: '만료서류', validUntil: '2026-09-10' }); // 이미 만료
    const pAnn = program({ id: 'p-ann', title: '발표경과', announceDate: '2026-09-01' });
    const aAnn = application({ id: 'a-ann', programId: 'p-ann', status: '검토중' });

    const result = buildDigest(
      [pUrgent, pOverdue, pDoc, pAnn],
      [aOverdue, aDoc, aAnn],
      [d],
      PROFILE,
      TODAY,
    );
    assert.ok(result);

    const order = ['오늘/3일 이내 마감', '내부 마감 초과 미제출', '서류 만료/만료 임박', '발표일 경과'].map((label) =>
      result!.indexOf(label),
    );
    assert.ok(order.every((idx) => idx !== -1), '네 섹션이 모두 존재해야 한다');
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      '섹션이 마감임박 -> 내부마감초과 -> 서류만료 -> 발표경과 순서여야 한다',
    );
  });

  test('메시지는 헤더로 시작하고 오늘 날짜(KST)를 담는다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-09-15' });
    const result = buildDigest([p], [], [], PROFILE, TODAY);
    assert.match(result!, /^📋 GrantBoard D-day 다이제스트 \(2026-09-14\)/);
  });
});

describe('digestUrgency', () => {
  test('D-day 마감이 있으면 red', () => {
    const p = program({ id: 'p-today', applyEnd: '2026-09-14' }); // TODAY 기준 D-day
    const sections = selectDigestSections([p], [], [], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'red');
  });

  test('D-1~D-3 마감만 있으면 orange', () => {
    const p = program({ id: 'p-soon', applyEnd: '2026-09-16' }); // D-2
    const sections = selectDigestSections([p], [], [], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'orange');
  });

  test('내부 마감 초과만 있어도(실제 접수마감은 여유) red — "이미 지남" 자체가 신호다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-12-31' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '작성중', targetSubmitDate: '2026-09-01' });
    const sections = selectDigestSections([p], [a], [], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'red');
  });

  test('발표일 경과만 있어도 red', () => {
    const p = program({ id: 'p-1', announceDate: '2026-09-01' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '검토중' });
    const sections = selectDigestSections([p], [a], [], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'red');
  });

  test('서류가 실제로 만료됐으면(expired) red', () => {
    const p = program({ id: 'p-1' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '검토중', documentIds: ['d-1'] });
    const d = document({ id: 'd-1', validUntil: '2026-09-01' }); // 이미 만료
    const sections = selectDigestSections([p], [a], [d], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'red');
  });

  test('만료 임박 서류가 4일 이상 남았을 뿐이면(급한 마감 없이) green', () => {
    const p = program({ id: 'p-1' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '검토중', documentIds: ['d-1'] });
    const d = document({ id: 'd-1', validUntil: '2026-09-25' }); // 11일 남음 -> expiring, but green 범위
    const sections = selectDigestSections([p], [a], [d], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'green');
  });

  test('만료 임박 서류가 3일 이내면 orange', () => {
    const p = program({ id: 'p-1' });
    const a = application({ id: 'a-1', programId: 'p-1', status: '검토중', documentIds: ['d-1'] });
    const d = document({ id: 'd-1', validUntil: '2026-09-16' }); // 2일 남음
    const sections = selectDigestSections([p], [a], [d], PROFILE, TODAY)!;
    assert.equal(digestUrgency(sections), 'orange');
  });
});

describe('shouldMentionHere', () => {
  test('D-day 마감이 있으면 @here 대상이다', () => {
    const p = program({ id: 'p-today', applyEnd: '2026-09-14' });
    const sections = selectDigestSections([p], [], [], PROFILE, TODAY)!;
    assert.equal(shouldMentionHere(sections), true);
  });

  test('D-1 마감이 있으면 @here 대상이다', () => {
    const p = program({ id: 'p-d1', applyEnd: '2026-09-15' });
    const sections = selectDigestSections([p], [], [], PROFILE, TODAY)!;
    assert.equal(shouldMentionHere(sections), true);
  });

  test('D-2~D-3 마감만 있으면 @here 대상이 아니다 — 조용히 게시만 한다', () => {
    const p = program({ id: 'p-d2', applyEnd: '2026-09-16' });
    const sections = selectDigestSections([p], [], [], PROFILE, TODAY)!;
    assert.equal(shouldMentionHere(sections), false);
  });

  test('실제 마감 없이 내부마감초과/발표경과/서류만료만 있으면 @here 대상이 아니다', () => {
    const p = program({ id: 'p-1', applyEnd: '2026-12-31', announceDate: '2026-09-01' });
    const a = application({
      id: 'a-1',
      programId: 'p-1',
      status: '작성중',
      targetSubmitDate: '2026-09-01',
      documentIds: ['d-1'],
    });
    const d = document({ id: 'd-1', validUntil: '2026-09-01' });
    const sections = selectDigestSections([p], [a], [d], PROFILE, TODAY)!;
    assert.equal(shouldMentionHere(sections), false);
  });
});
