import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil } from '../../src/lib/schedule.ts';
import { filterEventsForSchedule, buildTimelineDescription, buildTimelineEmbed } from './scheduleTimeline.ts';
import type { CalendarEvent, ProgramView, ApplicationView, Program, Application } from '../../src/lib/board.ts';

const TODAY = new Date('2026-09-15T03:00:00Z'); // KST 정오 — daysUntil 등 기존 테스트와 같은 관례.

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'prog-1',
    title: '테스트공고',
    organizer: '테스트기관',
    sourceUrl: 'https://example.com',
    category: '공모전',
    applyEnd: '2026-09-17',
    tags: [],
    source: 'manual',
    aliasTitles: [],
    ...overrides,
  };
}

function makeProgramView(overrides: Partial<ProgramView> = {}, programOverrides: Partial<Program> = {}): ProgramView {
  return {
    program: makeProgram(programOverrides),
    deadline: { daysLeft: 2, state: 'urgent' },
    startsIn: null,
    eligibility: { verdict: 'eligible', reasons: [] },
    applications: [],
    ...overrides,
  };
}

function makeApplication(overrides: Partial<Application> = {}): Application {
  return { id: 'app-1', programId: 'prog-1', status: '작성중', owner: 'AB', priority: 'mid', documentIds: [], ...overrides };
}

function makeApplicationView(overrides: Partial<ApplicationView> = {}, appOverrides: Partial<Application> = {}): ApplicationView {
  return {
    application: makeApplication(appOverrides),
    program: makeProgram(),
    deadline: { daysLeft: 2, state: 'urgent' },
    targetDaysLeft: null,
    overdueUnsubmitted: false,
    announceOverdue: false,
    docs: { total: 0, ready: 0 },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}, programOverrides: Partial<Program> = {}): CalendarEvent {
  const date = overrides.date ?? '2026-09-17';
  const program = overrides.program ?? makeProgramView({}, { title: programOverrides.title ?? '테스트공고', ...programOverrides });
  return {
    key: `${overrides.kind ?? 'apply-end'}:${program.program.id}`,
    kind: 'apply-end',
    date,
    program,
    application: null,
    daysLeft: daysUntil(date, TODAY),
    stale: false,
    ...overrides,
  };
}

describe('buildTimelineDescription', () => {
  test('이벤트 4종이 전부 라벨과 함께 나온다', () => {
    const events: CalendarEvent[] = [
      makeEvent({ kind: 'apply-end', date: '2026-09-17' }, { title: '마감이벤트' }),
      makeEvent({ kind: 'apply-start', date: '2026-09-16' }, { title: '시작이벤트' }),
      makeEvent({ kind: 'announce', date: '2026-09-20' }, { title: '발표이벤트' }),
      makeEvent(
        {
          kind: 'target',
          date: '2026-09-16',
          application: makeApplicationView({}, { owner: 'CD' }),
        },
        { title: '내부마감이벤트' },
      ),
    ];
    const description = buildTimelineDescription(events, TODAY);
    assert.match(description, /접수 마감/);
    assert.match(description, /접수 시작/);
    assert.match(description, /발표 예정/);
    assert.match(description, /내부 마감/);
    assert.match(description, /· CD/, 'target 이벤트는 지원건 owner를 바로 보여줘야 한다');
  });

  test('마감까지 3일 이내는 🔴, 7일 이내는 🟠다(schedule.ts의 deadlineState 임계값 재사용)', () => {
    const urgent = makeEvent({ kind: 'apply-end', date: '2026-09-17' }); // 2일 후
    const soon = makeEvent({ kind: 'apply-end', date: '2026-09-22' }); // 7일 후
    const urgentDesc = buildTimelineDescription([urgent], TODAY);
    const soonDesc = buildTimelineDescription([soon], TODAY);
    assert.match(urgentDesc, /🔴/);
    assert.match(soonDesc, /🟠/);
  });

  test('발표 예정·접수 시작은 며칠 남았든 항상 🔵(파랑=예정 정보)다', () => {
    const farAnnounce = makeEvent({ kind: 'announce', date: '2026-10-07' }); // 22일 후 — urgent 기준으론 멀지만
    const description = buildTimelineDescription([farAnnounce], TODAY);
    assert.match(description, /🔵/);
  });

  test('지원 불가 판정 공고는 빠지지 않고 취소선으로 흐리게 표시된다', () => {
    const view = makeProgramView({ eligibility: { verdict: 'ineligible', reasons: ['지역 제한'] } }, { title: '못지원공고' });
    const event = makeEvent({ program: view });
    const description = buildTimelineDescription([event], TODAY);
    assert.match(description, /~~못지원공고~~ _\(지원 불가 판정\)_/);
  });

  test('월이 다르면 월 구분 헤더로 나뉜다', () => {
    const sep = makeEvent({ date: '2026-09-17' }, { title: '9월공고' });
    const oct = makeEvent({ date: '2026-10-07' }, { title: '10월공고' });
    const description = buildTimelineDescription([sep, oct], TODAY);
    assert.match(description, /📅 2026년 9월/);
    assert.match(description, /📅 2026년 10월/);
    // 9월 헤더가 10월 헤더보다 먼저 나와야 한다(시간 흐름 순).
    assert.ok(description.indexOf('2026년 9월') < description.indexOf('2026년 10월'));
  });

  test('30건을 넘으면 잘리고 "외 N건" 안내가 남으며 달력 링크는 항상 유지된다', () => {
    const events = Array.from({ length: 35 }, (_, i) => makeEvent({ date: '2026-09-17', key: `e-${i}` }, { id: `p-${i}`, title: `공고${i}` }));
    const description = buildTimelineDescription(events, TODAY);
    assert.match(description, /…외 5건 — \/공고 목록으로 전체 보기/);
    assert.match(description, /\[달력 보기\]/);
  });

  test('극단적으로 긴 데이터에서도 description은 4096자를 넘지 않고 달력 링크가 남는다', () => {
    const longTitle = 'X'.repeat(400);
    const events = Array.from({ length: 30 }, (_, i) => makeEvent({ date: '2026-09-17', key: `e-${i}` }, { id: `p-${i}`, title: longTitle }));
    const description = buildTimelineDescription(events, TODAY);
    assert.ok(description.length <= 4096, `4096자를 넘었다: ${description.length}`);
    assert.match(description, /\[달력 보기\]/);
  });
});

describe('filterEventsForSchedule', () => {
  const thisMonthUrgent = makeEvent({ date: '2026-09-17' }, { title: '이번달' });
  const nextMonth = makeEvent({ date: '2026-10-05' }, { title: '다음달' });
  const farFuture = makeEvent({ date: '2026-12-01' }, { title: '먼미래' });
  const staleEvent = makeEvent({ date: '2026-08-01', stale: true }, { title: '지난것' });
  const events = [thisMonthUrgent, nextMonth, farFuture, staleEvent];

  test('기본(이번달)은 이번 달 이벤트만, 마감 지난 건 뺀다', () => {
    const filtered = filterEventsForSchedule(events, '이번달', undefined, TODAY);
    assert.deepEqual(
      filtered.map((e) => e.program.program.title),
      ['이번달'],
    );
  });

  test('다음달까지는 이번 달 + 다음 달만 포함한다', () => {
    const filtered = filterEventsForSchedule(events, '다음달까지', undefined, TODAY);
    assert.deepEqual(
      filtered.map((e) => e.program.program.title).sort(),
      ['다음달', '이번달'],
    );
  });

  test('전체는 월 제한이 없고, 마감 지난 것도 포함한다', () => {
    const filtered = filterEventsForSchedule(events, '전체', undefined, TODAY);
    assert.deepEqual(
      filtered.map((e) => e.program.program.title).sort(),
      ['다음달', '먼미래', '이번달', '지난것'],
    );
  });

  test('담당 필터는 대소문자 무시하고 정확히 일치하는 것만 남긴다', () => {
    const withOwner = makeEvent(
      { date: '2026-09-18', application: makeApplicationView({}, { owner: 'AB' }) },
      { title: '내담당' },
    );
    const withOtherOwner = makeEvent(
      { date: '2026-09-19', application: makeApplicationView({}, { owner: 'CD' }) },
      { title: '남담당' },
    );
    const filtered = filterEventsForSchedule([withOwner, withOtherOwner], '이번달', 'ab', TODAY);
    assert.deepEqual(
      filtered.map((e) => e.program.program.title),
      ['내담당'],
    );
  });
});

describe('buildTimelineEmbed', () => {
  test('title과 color를 채워서 반환한다', () => {
    const embed = buildTimelineEmbed([makeEvent()], TODAY);
    assert.equal(embed.title, '📅 일정 타임라인');
    assert.ok(embed.color);
    assert.ok(embed.description && embed.description.length > 0);
  });
});
