import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, type Application, type Program } from './board.ts';
import {
  collectFacets,
  countSelections,
  DEFAULT_FILTER,
  eventFilterAttrs,
  isFilterActive,
  matchesFilter,
  NO_APPLICATION,
  parseFilterState,
  programFilterAttrs,
  readAttrs,
  serializeAttrs,
  type FilterAttrs,
  type FilterState,
} from './filters.ts';

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
    eligibility: { businessRegistration: '무관' },
    ...overrides,
  };
}

function application(overrides: Partial<Application> & Pick<Application, 'id' | 'programId'>): Application {
  return { status: '검토중', owner: 'K', priority: 'mid', documentIds: [], ...overrides };
}

const profile = { hasBusinessRegistration: false, region: '서울' };

const board = buildBoard({
  programs: [
    program({ id: 'open-a', applyEnd: '2026-10-20', category: '정부지원사업', applyStart: '2026-09-01' }),
    program({ id: 'closed-b', applyEnd: '2026-08-31', category: '교육프로그램', announceDate: '2026-12-01' }),
    program({
      id: 'inelig-c',
      applyEnd: '2026-11-05',
      category: '공모전',
      eligibility: { regions: ['경기'] },
    }),
  ],
  applications: [
    application({ id: 'a1', programId: 'open-a', status: '작성중', owner: 'K', targetSubmitDate: '2026-10-18' }),
    application({ id: 'a2', programId: 'open-a', status: '검토중', owner: 'J' }),
    application({ id: 'b1', programId: 'closed-b', status: '제출완료', owner: 'J', targetSubmitDate: '2026-08-29' }),
  ],
  documents: [],
  profile,
  today,
});

const byId = (id: string) => board.programs.find((v) => v.program.id === id)!;

describe('collectFacets', () => {
  test('데이터에 실제로 있는 값만, 스키마 순서로', () => {
    const facets = collectFacets(board.programs);
    assert.deepEqual(facets.categories, ['정부지원사업', '공모전', '교육프로그램']);
    assert.deepEqual(facets.statuses, ['검토중', '작성중', '제출완료', NO_APPLICATION]);
    assert.deepEqual(facets.owners, ['J', 'K']);
    assert.deepEqual(facets.verdicts, ['eligible', 'ineligible']);
    assert.equal(facets.hasClosed, true);
  });

  test('빈 데이터면 선택지도 비어 있다', () => {
    const facets = collectFacets([]);
    assert.deepEqual(facets, { categories: [], statuses: [], owners: [], verdicts: [], hasClosed: false });
  });

  test('지원건 없는 공고가 없으면 NO_APPLICATION 선택지를 만들지 않는다', () => {
    const facets = collectFacets(board.programs.filter((v) => v.applications.length > 0));
    assert.ok(!facets.statuses.includes(NO_APPLICATION));
  });
});

describe('programFilterAttrs / eventFilterAttrs', () => {
  test('공고 속성은 모든 지원건의 상태·담당자를 합친다', () => {
    assert.deepEqual(programFilterAttrs(byId('open-a')), {
      category: '정부지원사업',
      statuses: ['작성중', '검토중'],
      owners: ['K', 'J'],
      verdict: 'eligible',
      closed: false,
    });
  });

  test('지원건 없는 공고는 NO_APPLICATION 상태를 가진다', () => {
    const attrs = programFilterAttrs(byId('inelig-c'));
    assert.deepEqual(attrs.statuses, [NO_APPLICATION]);
    assert.deepEqual(attrs.owners, []);
    assert.equal(attrs.verdict, 'ineligible');
  });

  test('내부 마감 이벤트는 그 지원건의 상태·담당자만 쓴다', () => {
    const target = board.events.find((e) => e.kind === 'target' && e.application?.application.id === 'a1')!;
    const attrs = eventFilterAttrs(target);
    assert.deepEqual(attrs.statuses, ['작성중']);
    assert.deepEqual(attrs.owners, ['K']);
  });

  test('마감된 공고의 지난 이벤트는 closed, 아직 남은 발표 예정일은 closed가 아니다', () => {
    const applyEnd = board.events.find((e) => e.kind === 'apply-end' && e.program.program.id === 'closed-b')!;
    const announce = board.events.find((e) => e.kind === 'announce' && e.program.program.id === 'closed-b')!;
    assert.equal(eventFilterAttrs(applyEnd).closed, true);
    assert.equal(eventFilterAttrs(announce).closed, false);
  });
});

describe('matchesFilter', () => {
  const attrs: FilterAttrs = {
    category: '공모전',
    statuses: ['작성중', '검토중'],
    owners: ['K', 'J'],
    verdict: 'eligible',
    closed: false,
  };
  const withState = (partial: Partial<FilterState>): FilterState => ({ ...DEFAULT_FILTER, ...partial });

  test('기본 상태는 마감 안 된 항목을 모두 통과시킨다', () => {
    assert.equal(matchesFilter(attrs, DEFAULT_FILTER), true);
  });

  test('같은 항목 안의 다중 선택은 OR', () => {
    assert.equal(matchesFilter(attrs, withState({ category: ['정부지원사업', '공모전'] })), true);
    assert.equal(matchesFilter(attrs, withState({ category: ['정부지원사업'] })), false);
    assert.equal(matchesFilter(attrs, withState({ owner: ['J'] })), true);
    assert.equal(matchesFilter(attrs, withState({ owner: ['P'] })), false);
  });

  test('항목 간에는 AND', () => {
    assert.equal(matchesFilter(attrs, withState({ category: ['공모전'], verdict: ['ineligible'] })), false);
    assert.equal(matchesFilter(attrs, withState({ category: ['공모전'], verdict: ['eligible'] })), true);
  });

  test('마감 숨기기가 켜지면 closed 항목은 다른 조건과 무관하게 빠진다', () => {
    const closed = { ...attrs, closed: true };
    assert.equal(matchesFilter(closed, DEFAULT_FILTER), false);
    assert.equal(matchesFilter(closed, withState({ hideClosed: false })), true);
  });

  test('NO_APPLICATION 선택은 지원건 없는 공고만 통과시킨다', () => {
    const none = { ...attrs, statuses: [NO_APPLICATION], owners: [] };
    assert.equal(matchesFilter(none, withState({ status: [NO_APPLICATION] })), true);
    assert.equal(matchesFilter(attrs, withState({ status: [NO_APPLICATION] })), false);
  });
});

describe('isFilterActive / countSelections', () => {
  test('기본 상태는 비활성, 0개', () => {
    assert.equal(isFilterActive(DEFAULT_FILTER), false);
    assert.equal(countSelections(DEFAULT_FILTER), 0);
  });

  test('마감 숨기기를 끈 것도 하나의 선택으로 센다', () => {
    const state = { ...DEFAULT_FILTER, hideClosed: false, owner: ['K', 'J'] };
    assert.equal(isFilterActive(state), true);
    assert.equal(countSelections(state), 3);
  });
});

describe('parseFilterState', () => {
  const facets = collectFacets(board.programs);

  test('깨진 값·모르는 값은 버리고 기본값으로 메운다', () => {
    assert.deepEqual(parseFilterState(null, facets), DEFAULT_FILTER);
    assert.deepEqual(parseFilterState('garbage', facets), DEFAULT_FILTER);
    assert.deepEqual(
      parseFilterState({ category: ['공모전', '없는값', 3], owner: 'K', hideClosed: 'yes' }, facets),
      { ...DEFAULT_FILTER, category: ['공모전'] },
    );
  });

  test('유효한 값은 그대로 복원한다', () => {
    const saved = { category: ['교육프로그램'], status: [NO_APPLICATION], owner: ['J'], verdict: ['ineligible'], hideClosed: false };
    assert.deepEqual(parseFilterState(saved, facets), saved);
  });
});

describe('serializeAttrs / readAttrs 왕복', () => {
  test('data-f-* 속성으로 갔다 와도 같은 값', () => {
    const attrs = programFilterAttrs(byId('open-a'));
    const serialized = serializeAttrs(attrs);
    assert.equal(serialized['data-f-status'], '작성중|검토중');
    // 브라우저의 dataset은 data-f-status → fStatus로 카멜케이스화된다. 그 형태를 흉내 낸다.
    const dataset = {
      fCategory: serialized['data-f-category'],
      fStatus: serialized['data-f-status'],
      fOwner: serialized['data-f-owner'],
      fVerdict: serialized['data-f-verdict'],
      fClosed: serialized['data-f-closed'],
    };
    assert.deepEqual(readAttrs(dataset), attrs);
  });

  test('빈 담당자 목록은 빈 문자열이 되고 다시 빈 배열로 읽힌다', () => {
    const attrs = programFilterAttrs(byId('inelig-c'));
    const serialized = serializeAttrs(attrs);
    assert.equal(serialized['data-f-owner'], '');
    assert.deepEqual(readAttrs({ fOwner: '', fStatus: serialized['data-f-status'] }).owners, []);
  });
});
