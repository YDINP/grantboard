import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAnnouncement, mergePrograms, type ProgramRecord } from './collect.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/kstartup-sample.json', import.meta.url), 'utf-8'),
) as { response: { body: { items: { item: unknown[] } } } };
const fixtureItems = fixture.response.body.items.item;

const bizinfoFixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/bizinfo-sample.json', import.meta.url), 'utf-8'),
) as { jsonArray: unknown[] };
const bizinfoItems = bizinfoFixture.jsonArray;

function manualProgram(overrides: Partial<ProgramRecord> = {}): ProgramRecord {
  return {
    id: 'pre-startup-2026',
    title: '예비창업패키지',
    organizer: '중소벤처기업부',
    sourceUrl: '#',
    category: '정부지원사업',
    applyEnd: '2026-10-20',
    tags: [],
    source: 'manual',
    ...overrides,
  };
}

function autoProgram(overrides: Partial<ProgramRecord> = {}): ProgramRecord {
  return {
    id: 'k-startup-abc123',
    title: '창업도약패키지',
    organizer: '창업진흥원',
    sourceUrl: 'https://www.k-startup.go.kr/1',
    category: '정부지원사업',
    applyEnd: '2026-10-15',
    tags: [],
    source: 'k-startup',
    collectedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeAnnouncement', () => {
  test('camelCase 후보 키로 온 항목을 정상 변환한다', () => {
    const { program, reason } = normalizeAnnouncement(fixtureItems[0], {
      now: new Date('2026-09-14T00:00:00.000Z'),
    });
    assert.equal(reason, undefined);
    assert.ok(program);
    assert.equal(program!.title, '2026년 예비창업패키지 청년창업사관학교 모집공고');
    assert.equal(program!.organizer, '중소벤처기업부');
    assert.equal(program!.sourceUrl, 'https://www.k-startup.go.kr/homepage/announcement/174821');
    assert.equal(program!.applyStart, '2026-09-01');
    assert.equal(program!.applyEnd, '2026-10-20');
    assert.equal(program!.applyEndTime, '16:00');
    assert.equal(program!.announceDate, '2026-08-15');
    assert.equal(program!.category, '정부지원사업');
    assert.equal(program!.source, 'k-startup');
    assert.equal(program!.id, 'k-startup-174821');
  });

  test('snake_case 후보 키 + 점(.) 구분 날짜도 정상 변환한다', () => {
    const { program } = normalizeAnnouncement(fixtureItems[1]);
    assert.ok(program);
    assert.equal(program!.title, '2026 창업도약패키지 2차 모집');
    assert.equal(program!.organizer, '창업진흥원');
    assert.equal(program!.applyStart, '2026-09-10');
    assert.equal(program!.applyEnd, '2026-10-15');
    // applyEndTime 후보 키가 원본에 없으면 undefined여야 한다 (거짓 값으로 채우지 않음)
    assert.equal(program!.applyEndTime, undefined);
  });

  test('원본에 안정적 ID가 없으면 title+applyEnd로 결정적 id를 만든다 (같은 입력 -> 같은 id)', () => {
    const raw = { title: '테스트 공고', pbancRcptEndDt: '20261231' };
    const r1 = normalizeAnnouncement(raw);
    const r2 = normalizeAnnouncement(raw);
    assert.ok(r1.program && r2.program);
    assert.equal(r1.program!.id, r2.program!.id);
    assert.match(r1.program!.id, /^k-startup-[0-9a-f]{10}$/);
  });

  test('공고명 필드가 없는 항목은 null + 사유를 반환하며 버려진다', () => {
    const { program, reason } = normalizeAnnouncement(fixtureItems[2]);
    assert.equal(program, null);
    assert.ok(reason && reason.includes('공고명'));
  });

  test('마감일 필드가 없거나 형식을 인식할 수 없으면 버려진다', () => {
    const noDeadline = normalizeAnnouncement({ title: '마감일 없는 공고' });
    assert.equal(noDeadline.program, null);
    assert.match(noDeadline.reason ?? '', /마감일/);

    const badDeadline = normalizeAnnouncement({ title: '마감일 형식 이상', pbancRcptEndDt: '내일까지' });
    assert.equal(badDeadline.program, null);
  });

  test('객체가 아닌 원본은 안전하게 버려진다', () => {
    assert.equal(normalizeAnnouncement(null).program, null);
    assert.equal(normalizeAnnouncement('문자열').program, null);
    assert.equal(normalizeAnnouncement(undefined).program, null);
  });
});

describe('normalizeAnnouncement - bizinfo', () => {
  test('discrete 시작/종료일 키로 온 항목을 정상 변환한다', () => {
    const { program, reason } = normalizeAnnouncement(bizinfoItems[0], {
      source: 'bizinfo',
      now: new Date('2026-09-14T00:00:00.000Z'),
    });
    assert.equal(reason, undefined);
    assert.ok(program);
    assert.equal(program!.title, '2026년 청년창업 지원사업');
    assert.equal(program!.organizer, '서울특별시');
    assert.equal(
      program!.sourceUrl,
      'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=B0001',
    );
    assert.equal(program!.applyStart, '2026-09-01');
    assert.equal(program!.applyEnd, '2026-10-15');
    assert.equal(program!.applyEndTime, '18:00');
    assert.equal(program!.announceDate, '2026-08-15');
    assert.equal(program!.supportAmount, '최대 3000만원');
    assert.equal(program!.source, 'bizinfo');
    assert.equal(program!.id, 'bizinfo-B0001');
  });

  test('"YYYY-MM-DD ~ YYYY-MM-DD" 범위 문자열 한 필드로 온 신청기간을 시작/종료로 분리한다', () => {
    const { program, reason } = normalizeAnnouncement(bizinfoItems[1], { source: 'bizinfo' });
    assert.equal(reason, undefined);
    assert.ok(program);
    assert.equal(program!.title, '지역특화 창업지원 프로그램');
    assert.equal(program!.organizer, '경기도');
    assert.equal(program!.applyStart, '2026-09-10');
    assert.equal(program!.applyEnd, '2026-10-20');
  });

  test('신청기간 범위 문자열의 형식을 인식할 수 없으면 마감일을 추정하지 않고 조용히 버린다', () => {
    const { program, reason } = normalizeAnnouncement(bizinfoItems[2], { source: 'bizinfo' });
    assert.equal(program, null);
    assert.ok(reason && reason.includes('신청기간'));
  });

  test('공고명 필드가 없는 항목은 null + 사유를 반환하며 버려진다', () => {
    const { program, reason } = normalizeAnnouncement(bizinfoItems[3], { source: 'bizinfo' });
    assert.equal(program, null);
    assert.ok(reason && reason.includes('공고명'));
  });

  test('원본에 안정적 ID가 없으면 title+applyEnd로 결정적 id를 만든다 (bizinfo 접두사)', () => {
    const raw = { pblancNm: '테스트 공고', reqstEndDe: '20261231' };
    const { program } = normalizeAnnouncement(raw, { source: 'bizinfo' });
    assert.ok(program);
    assert.match(program!.id, /^bizinfo-[0-9a-f]{10}$/);
  });
});

describe('mergePrograms', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');

  test('manual 항목은 공고명+마감일이 완전히 같은 자동수집 항목이 와도 보존된다', () => {
    const manual = manualProgram();
    const incoming = autoProgram({
      id: 'k-startup-999',
      title: manual.title,
      applyEnd: manual.applyEnd,
      sourceUrl: 'https://k-startup.go.kr/changed',
    });

    const result = mergePrograms([manual], [incoming], { now });

    assert.equal(result.merged.length, 1);
    assert.deepEqual(result.merged[0], manual);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
  });

  test('manual 항목은 제목만 같은(마감일 다른) 자동수집 항목으로도 갱신되지 않는다', () => {
    const manual = manualProgram();
    const incoming = autoProgram({
      title: manual.title,
      applyEnd: '2026-11-30', // 마감일이 달라 title-only 매칭 후보가 됨
    });

    const result = mergePrograms([manual], [incoming], { now });

    // manual과 제목이 겹치지만, title-only 매칭은 source !== 'manual'인 항목만 대상이므로
    // manual은 후보에서 애초에 제외되고 incoming은 신규 추가된다.
    assert.equal(result.added, 1);
    assert.deepEqual(
      result.merged.find((p) => p.id === manual.id),
      manual,
    );
  });

  test('같은 공고가 k-startup/bizinfo 두 소스에서 와도 공고명+마감일이 같으면 1건으로 유지된다', () => {
    const existing = autoProgram({ source: 'k-startup' });
    const incoming = autoProgram({
      id: 'bizinfo-1',
      source: 'bizinfo',
      sourceUrl: 'https://bizinfo.go.kr/duplicate',
    });

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.merged.length, 1);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.merged[0].sourceUrl, 'https://bizinfo.go.kr/duplicate');
    assert.equal(result.merged[0].collectedAt, now.toISOString());
    // id/title/source는 병합 로직이 덮어쓰지 않는다 (최초 수집 항목 기준 유지)
    assert.equal(result.merged[0].id, existing.id);
    assert.equal(result.merged[0].source, 'k-startup');
  });

  test('마감일만 바뀐 동일 공고는 중복 추가되지 않고 기존 항목이 갱신된다', () => {
    const existing = autoProgram({ applyEnd: '2026-10-15' });
    const incoming = autoProgram({ id: 'k-startup-new-id', applyEnd: '2026-10-31' });

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.merged.length, 1);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.merged[0].applyEnd, '2026-10-31');
    assert.equal(result.merged[0].collectedAt, now.toISOString());
  });

  test('완전히 새 공고는 추가된다', () => {
    const existing = autoProgram();
    const incoming = autoProgram({ id: 'k-startup-new', title: '전혀 다른 공고', applyEnd: '2027-01-01' });

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.merged.length, 2);
    assert.equal(result.added, 1);
    assert.equal(result.updated, 0);
  });

  test('변경 사항이 전혀 없는 재수집은 skipped로 카운트되고 collectedAt도 바뀌지 않는다', () => {
    const existing = autoProgram();
    const incoming = { ...existing }; // 완전히 동일한 내용의 재수집

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.merged[0].collectedAt, existing.collectedAt);
  });

  test('빈 응답(incoming=[])이 와도 기존 데이터는 그대로 유지된다', () => {
    const existing = [manualProgram(), autoProgram()];

    const result = mergePrograms(existing, [], { now });

    assert.deepEqual(result.merged, existing);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 0);
  });

  test('incoming 배치 내부에 같은 공고가 중복으로 들어와도 1건만 유지된다', () => {
    const dup = autoProgram({ id: 'k-startup-dup' });

    const result = mergePrograms([], [dup, { ...dup }], { now });

    assert.equal(result.merged.length, 1);
    assert.equal(result.added, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
  });

  test('사람이 자동수집 행의 category/tags를 고치면 같은 공고가 재수집돼도 유지된다', () => {
    const existing = autoProgram({ category: '경진대회', tags: ['데모데이'] });
    // incoming은 normalizeAnnouncement처럼 항상 기본값(category/tags)을 들고 온다.
    const incoming = autoProgram({ sourceUrl: 'https://k-startup.go.kr/updated' });

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.merged[0].category, '경진대회');
    assert.deepEqual(result.merged[0].tags, ['데모데이']);
    // category/tags는 갱신 대상에서 빠졌지만 sourceUrl 등 다른 필드는 여전히 갱신된다.
    assert.equal(result.merged[0].sourceUrl, 'https://k-startup.go.kr/updated');
    assert.equal(result.updated, 1);
  });

  test('manual 행의 aliasTitles와 제목이 일치하는 자동수집 항목은 중복 추가되지 않고 manual이 유지된다', () => {
    const manual = manualProgram({ aliasTitles: ['2026년 예비창업패키지 예비창업자 모집 공고'] });
    const incoming = autoProgram({
      title: '2026년 예비창업패키지 예비창업자 모집 공고',
      applyEnd: '2026-11-30', // manual과 마감일이 달라도 alias면 매칭된다
    });

    const result = mergePrograms([manual], [incoming], { now });

    assert.equal(result.merged.length, 1);
    assert.deepEqual(result.merged[0], manual);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.aliasSkips.length, 1);
    assert.equal(result.aliasSkips[0].manualTitle, manual.title);
    assert.equal(result.aliasSkips[0].incomingTitle, incoming.title);
  });

  test('aliasTitles가 없는 manual 행은 alias 매칭 대상이 되지 않는다', () => {
    const manual = manualProgram();
    const incoming = autoProgram({ title: '전혀 다른 이름의 공고', applyEnd: '2026-12-01' });

    const result = mergePrograms([manual], [incoming], { now });

    assert.equal(result.merged.length, 2);
    assert.equal(result.added, 1);
    assert.equal(result.aliasSkips.length, 0);
  });
});

describe('mergePrograms - 소스 간 제목 표기 차이(퍼지 매칭)', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');

  test('선행 연도 표기만 다른 같은 공고는 k-startup/bizinfo 소스가 달라도 1건으로 합쳐진다', () => {
    const existing = autoProgram({
      source: 'k-startup',
      title: '2026년 창업도약패키지 2차 모집',
      applyEnd: '2026-10-15',
    });
    const incoming = autoProgram({
      id: 'bizinfo-1',
      source: 'bizinfo',
      title: '창업도약패키지 2차 모집', // 선행 연도만 빠짐
      applyEnd: '2026-10-20', // 마감일 연장
      sourceUrl: 'https://bizinfo.go.kr/1',
    });

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.merged.length, 1);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 1);
    // 제목/출처는 최초 수집 항목(k-startup) 기준을 유지하고, 마감일 등 갱신 대상 필드만 바뀐다.
    assert.equal(result.merged[0].title, existing.title);
    assert.equal(result.merged[0].source, 'k-startup');
    assert.equal(result.merged[0].applyEnd, '2026-10-20');
    assert.equal(result.merged[0].sourceUrl, 'https://bizinfo.go.kr/1');
  });

  test('제목이 비슷해도 괄호 안 지역 표기가 다르면 서로 다른 공고로 보고 합치지 않는다', () => {
    const existing = autoProgram({
      source: 'k-startup',
      title: '2026년 소상공인 지원사업(서울)',
      applyEnd: '2026-10-15',
    });
    const incoming = autoProgram({
      id: 'bizinfo-2',
      source: 'bizinfo',
      title: '소상공인 지원사업(경기)', // 지역만 다른 별개 공고
      applyEnd: '2026-10-20',
    });

    const result = mergePrograms([existing], [incoming], { now });

    assert.equal(result.merged.length, 2);
    assert.equal(result.added, 1);
    assert.equal(result.updated, 0);
  });

  test('정규화된 제목이 이미 2건 이상과 겹쳐 모호하면 퍼지 매칭을 건너뛰고 신규로 추가한다', () => {
    const existing = [
      autoProgram({ id: 'k-startup-a', source: 'k-startup', title: '구직자 취업지원 프로그램', applyEnd: '2026-10-01' }),
      autoProgram({ id: 'bizinfo-a', source: 'bizinfo', title: '구직자 취업지원 프로그램', applyEnd: '2026-11-01' }),
    ];
    const incoming = autoProgram({
      id: 'k-startup-b',
      source: 'k-startup',
      title: '2026년 구직자 취업지원 프로그램',
      applyEnd: '2026-12-01',
    });

    const result = mergePrograms(existing, [incoming], { now });

    assert.equal(result.merged.length, 3);
    assert.equal(result.added, 1);
    assert.equal(result.updated, 0);
  });

  test('manual 행은 별칭(aliasTitles) 미지정 시 정규화된 제목이 같아도 퍼지 매칭되지 않고 신규 추가된다', () => {
    const manual = manualProgram(); // title: '예비창업패키지'
    const incoming = autoProgram({
      id: 'bizinfo-x',
      source: 'bizinfo',
      title: '2026년 예비창업패키지', // 정규화하면 manual과 같은 제목이지만 alias가 없음
      applyEnd: '2026-11-01',
    });

    const result = mergePrograms([manual], [incoming], { now });

    assert.equal(result.merged.length, 2);
    assert.equal(result.added, 1);
    assert.deepEqual(
      result.merged.find((p) => p.id === manual.id),
      manual,
    );
  });
});
