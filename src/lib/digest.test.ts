import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from './digest.ts';
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
