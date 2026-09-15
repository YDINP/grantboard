/**
 * 달력 페이지 렌더러. src/components/*.astro 를 문자열 템플릿 함수로 옮긴 것이다.
 * 각 함수는 원본 컴포넌트와 1:1로 대응한다 — 마크업·클래스·data 속성(클라이언트 스크립트가 읽는
 * 계약)을 그대로 유지했으므로, 화면을 고칠 때는 원본 Astro 컴포넌트의 주석도 같이 참고할 것.
 *
 * 날짜·자격·만료 계산은 전부 src/lib 순수 함수를 호출만 한다. 여기서 새로 짜지 말 것.
 * 데이터에서 온 값은 예외 없이 esc()/attr()로 넣는다 — html.ts 상단 주석 참고.
 */

import {
  ACTIVE_STATUSES,
  RESULT_STATUSES,
  buildBoard,
  groupEventsByDate,
  isActiveStatus,
  type Application,
  type ApplicationStatus,
  type ApplicationView,
  type BoardInput,
  type BoardModel,
  type BoardSummary,
  type CalendarEvent,
  type Document,
  type DocumentView,
  type Program,
  type ProgramView,
} from '../../src/lib/board.ts';
import { WEEKDAY_LABELS, buildMonthGrid, monthKeyOf, monthSpan, type MonthGrid } from '../../src/lib/calendar.ts';
import {
  NO_APPLICATION,
  NO_APPLICATION_LABEL,
  collectFacets,
  eventFilterAttrs,
  programFilterAttrs,
  serializeAttrs,
  type FilterFacets,
} from '../../src/lib/filters.ts';
import {
  DEADLINE_TONE,
  DOC_STATE_LABEL,
  DOC_STATE_TONE,
  EVENT_KIND_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
  formatDayHeading,
  formatDday,
  formatMonth,
  formatShortDate,
  isLinkable,
  monthKey,
  type Tone,
} from '../../src/lib/format.ts';
import { kstDateParts, toDateStr, weekdayOf } from '../../src/lib/schedule.ts';
import type { TeamProfile } from '../../src/lib/eligibility.ts';
import { attr, attrs, cls, each, esc, safeHref, when } from './html.ts';
import { CLIENT_BUNDLE } from './clientBundle.generated.ts';
import { STYLES } from './styles.ts';
import {
  COMMAND_NAMES,
  DOCUMENT_SUBCOMMANDS,
  ME_OWNER_OPTION,
  PROGRAM_SUBCOMMANDS,
  STATUS_SUBCOMMANDS,
} from '../discord/commands.ts';

/**
 * 안내 문구에 적는 디스코드 슬래시 명령. 이제 데이터 입력·수정은 전부 디스코드에서 한다.
 * 이름은 worker/discord/commands.ts의 상수에서 조립한다 — 봇 쪽에서 이름을 바꾸면 여기도 자동으로 따라간다.
 */
export const DISCORD_COMMANDS = {
  /** 공고 등록 모달 */
  addProgram: `/${COMMAND_NAMES.PROGRAM} ${PROGRAM_SUBCOMMANDS.ADD}`,
  /** 공고를 골라 지원 상태 변경 */
  changeStatus: `/${COMMAND_NAMES.STATUS} ${STATUS_SUBCOMMANDS.CHANGE}`,
  /** 서류 등록 모달 */
  addDocument: `/${COMMAND_NAMES.DOCUMENTS} ${DOCUMENT_SUBCOMMANDS.ADD}`,
  /** 서류 준비 완료 토글 */
  completeDocument: `/${COMMAND_NAMES.DOCUMENTS} ${DOCUMENT_SUBCOMMANDS.COMPLETE}`,
  /** 서류 ↔ 지원건 연결/해제 */
  linkDocument: `/${COMMAND_NAMES.DOCUMENTS} ${DOCUMENT_SUBCOMMANDS.LINK}`,
  /** 서류 준비 현황 조회. `/서류` 단독 호출은 없다(서브커맨드 필수). */
  listDocuments: `/${COMMAND_NAMES.DOCUMENTS} ${DOCUMENT_SUBCOMMANDS.LIST}`,
  /** 내 디스코드 계정 ↔ 담당자 이니셜 등록. 안 하면 /내마감이 근사 매칭으로 조용히 틀린다. */
  me: `/${COMMAND_NAMES.ME} ${ME_OWNER_OPTION}:`,
  /** 내 담당 마감만 보기 */
  myDeadlines: `/${COMMAND_NAMES.MY_DEADLINES}`,
  /** 이 페이지 링크 */
  calendar: `/${COMMAND_NAMES.CALENDAR}`,
} as const;

export interface PageInput {
  programs: Program[];
  applications: Application[];
  documents: Document[];
  profile: TeamProfile;
  /** 요청 처리 시각. 모든 D-day·오늘 표시가 이 값을 따른다 — 정적 빌드와 달리 열 때마다 새로 계산된다. */
  today: Date;
}

/** 넓은 화면에서 한 칸에 바로 보이는 칩 수. 넘치면 "+N". 스크립트도 같은 값을 쓴다(data-max-visible). */
const MAX_VISIBLE_CHIPS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Badge
// ─────────────────────────────────────────────────────────────────────────────

/** 채운 배경(strong)은 지원 불가·만료처럼 반드시 눈에 띄어야 하는 상태에만 쓴다. */
function badge(text: string, tone: Tone = 'neutral', strong = false): string {
  return `<span${cls('badge', `tone-${tone}`, { strong })}>${esc(text)}</span>`;
}

/** 공고 제목. 열 수 있는 URL이면 새 탭 링크, 아니면 일반 텍스트(클릭해도 빈 탭이 뜨지 않게). */
function titleLink(program: Program, extraClass = ''): string {
  const href = isLinkable(program.sourceUrl) ? safeHref(program.sourceUrl) : null;
  return href
    ? `<a${cls('title', extraClass)} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(program.title)}</a>`
    : `<span${cls('title', 'no-link', extraClass)}>${esc(program.title)}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SummaryBar
// ─────────────────────────────────────────────────────────────────────────────

function renderSummary(summary: BoardSummary): string {
  const { nearest, activeCount, docAlertCount, overdueCount } = summary;
  // 0이면 조용히(회색), 0이 아니면 해당 상태색. 가장 임박한 마감은 deadlineState 색을 그대로 따른다.
  const nearestTone: Tone = nearest ? DEADLINE_TONE[nearest.deadline.state] : 'quiet';
  const stat = (tone: string, label: string, value: string, hint: string) =>
    `<div${cls('stat', tone)}><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span><span class="hint">${esc(hint)}</span></div>`;

  return `<section class="summary" aria-label="오늘 요약">
<!-- 일정 탭 필터가 걸려도 이 수치는 전체 기준이다 — 필터로 경고가 줄어 보이면 위험을 놓친다. -->
<p class="filter-note" data-filter-note hidden>일정 탭에 필터가 걸려 있습니다 — 이 요약은 <strong>전체</strong> 기준입니다.</p>
${stat(`tone-${nearestTone}`, '가장 임박한 마감', nearest ? formatDday(nearest.deadline.daysLeft) : '—', nearest ? nearest.program.title : '접수 중인 공고 없음')}
${stat(activeCount > 0 ? 'tone-blue' : 'tone-quiet', '진행 중 지원건', String(activeCount), '검토중 ~ 서류통과')}
${stat(docAlertCount > 0 ? 'tone-orange' : 'tone-quiet', '만료·임박 서류', String(docAlertCount), docAlertCount > 0 ? '서류 탭에서 확인' : '이상 없음')}
${stat(overdueCount > 0 ? 'tone-red' : 'tone-quiet', '내부 마감 초과 미제출', String(overdueCount), overdueCount > 0 ? '즉시 확인' : '없음')}
</section>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FilterBar
// ─────────────────────────────────────────────────────────────────────────────

function renderFilterBar(facets: FilterFacets, total: number): string {
  interface Group {
    name: 'category' | 'status' | 'owner' | 'verdict';
    legend: string;
    options: { value: string; label: string }[];
  }
  // 값이 하나도 없는 항목은 그리지 않는다 — 빈 선택지는 사용자를 헷갈리게만 한다.
  const groups: Group[] = [
    { name: 'category', legend: '카테고리', options: facets.categories.map((v) => ({ value: v, label: v })) },
    {
      name: 'status',
      legend: '진행 상태',
      options: facets.statuses.map((v) => ({ value: v, label: v === NO_APPLICATION ? NO_APPLICATION_LABEL : v })),
    },
    { name: 'owner', legend: '담당자', options: facets.owners.map((v) => ({ value: v, label: v })) },
    { name: 'verdict', legend: '자격 판정', options: facets.verdicts.map((v) => ({ value: v, label: VERDICT_LABEL[v] })) },
  ].filter((g) => g.options.length > 0) as Group[];

  return `<div class="filter" data-filter-bar${attr('data-total', total)}>
<div class="bar">
<details class="panel" data-filter-panel>
<summary><span class="sum-label">필터</span><span class="sum-badge" data-filter-badge hidden>0</span><span class="sum-status" data-filter-status aria-live="polite">전체 ${total}건 표시 중</span></summary>
<form class="groups" data-filter-form>
${each(
  groups,
  (group) => `<fieldset><legend>${esc(group.legend)}</legend><div class="options">${each(
    group.options,
    (option) =>
      `<label class="opt"><input type="checkbox" name="${group.name}"${attr('value', option.value)} /><span>${esc(option.label)}</span></label>`,
  )}</div></fieldset>`,
)}
${when(
  facets.hasClosed,
  () =>
    `<fieldset class="toggle-set"><legend>표시</legend><label class="opt toggle"><input type="checkbox" name="hideClosed" checked /><span>마감된 공고 숨기기</span></label></fieldset>`,
)}
</form>
</details>
<button type="button" class="clear" data-filter-clear hidden>필터 해제</button>
</div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EventChip
// ─────────────────────────────────────────────────────────────────────────────

// 종류별 색. 마감 칩만 deadlineState 색을 그대로 따르고, 나머지는 종류를 구분하는 고정 톤이다.
function chipTone(event: CalendarEvent): Tone {
  switch (event.kind) {
    case 'apply-end':
      return DEADLINE_TONE[event.program.deadline.state];
    case 'target':
      if (event.stale) return 'gray';
      return event.application?.overdueUnsubmitted ? 'red' : 'neutral';
    case 'announce':
      return event.daysLeft < 0 ? 'gray' : 'blue';
    case 'apply-start':
      return 'quiet';
  }
}

/** 넓은 화면에서는 텍스트 칩, 좁은 화면(≤640px)에서는 CSS만으로 점(dot)이 된다. */
function renderChip(event: CalendarEvent): string {
  const { kind, program, application } = event;
  const title = program.program.title;
  const owner = application ? ` (${application.application.owner})` : '';
  const label = `${EVENT_KIND_LABEL[kind]}${owner} · ${title} · ${formatDday(event.daysLeft)}`;
  return `<button type="button"${attrs(serializeAttrs(eventFilterAttrs(event)))}${attr('data-event', event.key)}${attr('data-date', event.date)}${cls(
    'chip',
    `kind-${kind}`,
    `tone-${chipTone(event)}`,
    { past: event.daysLeft < 0, dim: program.eligibility.verdict === 'ineligible', stale: event.stale },
  )}${attr('title', label)}${attr('aria-label', label)}><span class="text" aria-hidden="true">${esc(title)}</span></button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DayDetail
// ─────────────────────────────────────────────────────────────────────────────

function ddayTone(event: CalendarEvent): Tone {
  if (event.kind === 'apply-end') return DEADLINE_TONE[event.program.deadline.state];
  if (event.kind === 'target' && event.application?.overdueUnsubmitted) return 'red';
  if (event.daysLeft < 0) return 'gray';
  return event.kind === 'announce' ? 'blue' : 'neutral';
}

function renderApplicationLine(
  { application, targetDaysLeft, overdueUnsubmitted }: ApplicationView,
  current: boolean,
): string {
  return `<li${cls({ current })}><span class="status">${esc(application.status)}</span><span>· 담당 ${esc(application.owner)}</span>${when(
    application.targetSubmitDate,
    () =>
      `<span${cls('internal', { overdue: overdueUnsubmitted })}>· 내부 마감 ${esc(application.targetSubmitDate)}${
        targetDaysLeft !== null ? ` (${formatDday(targetDaysLeft)})` : ''
      }${overdueUnsubmitted ? ' — 지났는데 미제출' : ''}</span>`,
  )}${when(application.submittedAt, () => `<span>· 제출 ${esc(application.submittedAt)}</span>`)}</li>`;
}

function renderDayEntry(event: CalendarEvent): string {
  const { program, deadline, eligibility, applications } = event.program;
  const app = event.application;
  return `<li${attrs(serializeAttrs(eventFilterAttrs(event)))}${attr('data-event', event.key)}${cls('entry', `kind-${event.kind}`, {
    dim: eligibility.verdict === 'ineligible',
  })}>
<div class="entry-head"><span${cls('kind', `kind-${event.kind}`)}>${esc(EVENT_KIND_LABEL[event.kind])}${
    app ? esc(` · ${app.application.owner}`) : ''
  }</span><span${cls('dday', `tone-${ddayTone(event)}`)}>${esc(formatDday(event.daysLeft))}</span>${badge(program.category)}</div>
<p class="title-row">${titleLink(program)}<span class="org">${esc(program.organizer)}</span>${when(
    program.supportAmount,
    () => `<span class="amount">${esc(program.supportAmount)}</span>`,
  )}</p>
<dl class="facts">
<dt>접수 마감</dt>
<dd><strong${cls({ closed: deadline.state === 'closed' })}>${esc(program.applyEnd)}</strong>${
    program.applyEndTime ? `<strong>${esc(program.applyEndTime)}</strong>` : badge('마감 시각 미확인', 'orange', true)
  }<span class="muted">(${deadline.state === 'closed' ? '마감됨' : esc(formatDday(deadline.daysLeft))})</span></dd>
${when(
  event.kind === 'announce' && program.announceDate,
  () =>
    `<dt>발표</dt><dd><strong>${esc(program.announceDate)}</strong>${when(
      applications.some((a) => a.announceOverdue),
      () => badge('발표 예정일 경과', 'amber', true),
    )}</dd>`,
)}
<dt>자격</dt>
<dd>${badge(VERDICT_LABEL[eligibility.verdict], VERDICT_TONE[eligibility.verdict], eligibility.verdict === 'ineligible')}${when(
    eligibility.verdict !== 'eligible',
    () => `<ul class="reasons">${each(eligibility.reasons, (reason) => `<li>${esc(reason)}</li>`)}</ul>`,
  )}</dd>
<dt>지원건</dt>
<dd>${
    applications.length === 0
      ? '<span class="muted">없음</span>'
      : `<ul class="apps">${each(applications, (a) => renderApplicationLine(a, app?.application.id === a.application.id))}</ul>`
  }</dd>
</dl>
</li>`;
}

/** 이벤트가 있는 날짜마다 하나씩 렌더해 두고(hidden), 스크립트가 클릭한 날짜의 것만 연다. 모달이 아니라 달력 아래 패널. */
function renderDayDetail(date: string, events: CalendarEvent[]): string {
  const heading = formatDayHeading(date, weekdayOf(date));
  return `<section class="dd"${attr('data-day', date)}${attr('aria-label', `${heading} 일정`)} hidden>
<header class="dd-head"><h4>${esc(heading)}<span class="n"><span data-visible-count>${events.length}</span>건</span></h4><button type="button" class="close" data-day-close aria-label="상세 닫기">닫기</button></header>
<p class="filtered" data-day-filtered hidden>이 날짜의 일정 <span data-day-hidden-count>0</span>건이 필터로 가려져 있습니다.</p>
<ul class="entries">${each(events, renderDayEntry)}</ul>
</section>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CalendarView
// ─────────────────────────────────────────────────────────────────────────────

function renderCell(cell: MonthGrid['weeks'][number][number], eventsByDate: Map<string, CalendarEvent[]>): string {
  // 앞뒤 달 채움 칸에는 칩을 올리지 않는다 — 같은 이벤트가 두 달에 겹쳐 보이고 집계도 꼬인다.
  const events = cell.inMonth ? (eventsByDate.get(cell.date) ?? []) : [];
  const label = `${cell.date}${cell.isToday ? ' 오늘' : ''}${events.length ? ` 일정 ${events.length}건` : ''}`;
  return `<div role="gridcell"${cls('cell', { out: !cell.inMonth, today: cell.isToday, sun: cell.weekday === 0, sat: cell.weekday === 6 })}${attr(
    'data-cell',
    cell.inMonth ? cell.date : null,
  )}><button type="button" class="day"${attr('data-date', cell.date)} data-day-button${attr('aria-label', label)}${attr(
    'aria-current',
    cell.isToday ? 'date' : null,
  )}${attr('tabindex', cell.inMonth ? 0 : -1)}>${cell.day}</button>${when(
    events.length > 0,
    () => `<div class="chips">${each(events, renderChip)}</div>`,
  )}<button type="button" class="more"${attr('data-date', cell.date)} data-day-button hidden>+0</button></div>`;
}

function renderMonth(grid: MonthGrid, eventsByDate: Map<string, CalendarEvent[]>, initialKey: string): string {
  return `<section class="month"${attr('data-month', grid.key)}${attr('data-label', grid.label)}${attr('aria-label', grid.label)}${attr(
    'hidden',
    grid.key !== initialKey,
  )}><div class="grid" role="grid"${attr('aria-label', grid.label)}>${each(
    grid.weeks,
    (week) => `<div class="week" role="row">${each(week, (cell) => renderCell(cell, eventsByDate))}</div>`,
  )}</div></section>`;
}

/**
 * 월 캘린더. 필요한 달을 전부 렌더해 두고(hidden) 스크립트는 보여줄 달만 고른다 —
 * 브라우저에서 날짜 계산을 한 줄도 하지 않기 위해서다(KST 단일 소스 원칙).
 * 오늘 표시는 요청 시각 기준이다. 정적 빌드 시절의 재빌드 크론은 더 이상 필요 없다.
 */
function renderCalendar(
  months: MonthGrid[],
  eventsByDate: Map<string, CalendarEvent[]>,
  todayKey: string,
  totalPrograms: number,
): string {
  const initial = months.find((m) => m.key === todayKey) ?? months[0];
  const eventDates = [...eventsByDate.keys()].sort();

  return `<div class="calendar" data-calendar${attr('data-today-month', todayKey)}${attr('data-max-visible', MAX_VISIBLE_CHIPS)}>
<div class="cal-nav">
<button type="button" class="nav-btn" data-cal-prev aria-label="이전 달">‹</button>
<h3 class="cal-title" aria-live="polite"><span data-cal-label>${esc(initial.label)}</span> <span class="cal-count" data-cal-count></span></h3>
<button type="button" class="nav-btn" data-cal-next aria-label="다음 달">›</button>
<button type="button" class="today-btn" data-cal-today>오늘로</button>
</div>
<ul class="legend" aria-label="이벤트 종류">
<li><span class="swatch end"></span>접수 마감</li>
<li><span class="swatch target"></span>내부 마감</li>
<li><span class="swatch announce"></span>발표 예정</li>
<li><span class="swatch start"></span>접수 시작</li>
</ul>
${when(
  totalPrograms === 0,
  () =>
    `<p class="empty">등록된 공고가 없습니다. 디스코드에서 <code>${esc(DISCORD_COMMANDS.addProgram)}</code>로 공고를 등록하면 마감·발표 일정이 달력에 올라옵니다.</p>`,
)}
<p class="empty" data-filter-empty hidden>필터에 걸리는 일정이 없습니다 (전체 ${totalPrograms}건). 위의 <strong>필터 해제</strong>를 누르면 모두 보입니다.</p>
<div class="weekdays" aria-hidden="true">${each(WEEKDAY_LABELS, (label, i) => `<span${cls('wd', { sun: i === 0, sat: i === 6 })}>${label}</span>`)}</div>
${each(months, (grid) => renderMonth(grid, eventsByDate, initial.key))}
<div class="details" data-day-details>
${each(eventDates, (date) => renderDayDetail(date, eventsByDate.get(date) ?? []))}
<section class="day-empty" data-day-empty hidden><p><strong data-day-empty-date></strong> — 이 날짜에는 일정이 없습니다.</p><button type="button" class="close" data-day-close>닫기</button></section>
</div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TimelineTab / TimelineItem
// ─────────────────────────────────────────────────────────────────────────────

function renderTimelineItem(view: ProgramView): string {
  const { program, deadline, startsIn, eligibility, applications } = view;
  // 접수 전(upcoming)이면 큰 숫자는 '접수 시작까지', 그 외에는 '마감까지'.
  const headline =
    deadline.state === 'upcoming' && startsIn !== null && program.applyStart
      ? {
          dday: formatDday(startsIn),
          caption: `${formatShortDate(program.applyStart)} 접수 시작`,
          sr: `접수 ${formatDday(startsIn)} 시작`,
        }
      : {
          dday: formatDday(deadline.daysLeft),
          caption: `${formatShortDate(program.applyEnd)} ${deadline.state === 'closed' ? '마감됨' : '마감'}`,
          sr: deadline.state === 'closed' ? '마감됨' : `마감 ${formatDday(deadline.daysLeft)}`,
        };

  return `<li${attrs(serializeAttrs(programFilterAttrs(view)))} data-role="program"${cls('item', `state-${deadline.state}`, {
    dim: eligibility.verdict === 'ineligible',
  })}>
<div class="when"><span class="dday" aria-hidden="true">${esc(headline.dday)}</span><span class="sr-only">${esc(headline.sr)}</span><span class="caption">${esc(headline.caption)}</span></div>
<div class="body">
<div class="title-row">${titleLink(program)}${badge(program.category)}</div>
<p class="org">${esc(program.organizer)}${when(program.supportAmount, () => `<span class="amount"> · ${esc(program.supportAmount)}</span>`)}</p>
<ul class="facts">
<li><span>마감 <strong>${esc(program.applyEnd)}</strong></span>${
    program.applyEndTime ? `<strong>${esc(program.applyEndTime)}</strong>` : badge('마감 시각 미확인', 'orange', true)
  }${each(applications, ({ application, targetDaysLeft, overdueUnsubmitted }) =>
    application.targetSubmitDate
      ? `<span${cls('internal', { overdue: overdueUnsubmitted })}>· 내부 마감 <strong>${esc(application.targetSubmitDate)}</strong>${
          targetDaysLeft !== null ? ` (${formatDday(targetDaysLeft)})` : ''
        }${overdueUnsubmitted ? ' — 지났는데 미제출' : ''}</span>`
      : '',
  )}</li>
${when(program.announceDate, () => `<li class="announce">${badge(`발표예정 ${program.announceDate}`, 'blue')}</li>`)}
${each(
  applications,
  ({ application, announceOverdue }) =>
    `<li><span class="status">${esc(application.status)}</span><span>· 담당 ${esc(application.owner)}</span>${when(
      application.submittedAt,
      () => `<span>· 제출 ${esc(application.submittedAt)}</span>`,
    )}${when(announceOverdue, () => badge('발표 예정일 경과', 'amber', true))}${when(
      application.note,
      () => `<p class="note"${attr('title', application.note)}>${esc(application.note)}</p>`,
    )}</li>`,
)}
</ul>
<div class="verdict">${badge(VERDICT_LABEL[eligibility.verdict], VERDICT_TONE[eligibility.verdict], eligibility.verdict === 'ineligible')}${when(
    eligibility.verdict !== 'eligible',
    () => `<ul class="reasons">${each(eligibility.reasons, (reason) => `<li>${esc(reason)}</li>`)}</ul>`,
  )}</div>
</div>
</li>`;
}

interface MonthGroup {
  key: string;
  label: string;
  items: ProgramView[];
}

/** applyEnd 기준 월별 묶음. 입력 순서를 보존하므로 정렬은 호출자가 책임진다. */
function groupByMonth(views: ProgramView[]): MonthGroup[] {
  const groups = new Map<string, ProgramView[]>();
  for (const view of views) {
    const key = monthKey(view.program.applyEnd);
    const bucket = groups.get(key);
    if (bucket) bucket.push(view);
    else groups.set(key, [view]);
  }
  return [...groups].map(([key, items]) => ({ key, label: formatMonth(key), items }));
}

function renderMonthGroup(group: MonthGroup): string {
  return `<section class="month"${attr('aria-label', group.label)} data-auto-hide>
<h3 class="month-heading"><span>${esc(group.label)}</span><span class="n"><span data-visible-count>${group.items.length}</span>건</span></h3>
<ol class="items">${each(group.items, renderTimelineItem)}</ol>
</section>`;
}

function renderTimeline(programs: ProgramView[]): string {
  const open = programs.filter((v) => v.deadline.state !== 'closed');
  // 마감된 공고는 최근에 마감된 것부터 — 접힌 섹션 안에만 있으므로 위 타임라인과 순서가 이어질 필요가 없다.
  const closed = programs.filter((v) => v.deadline.state === 'closed').reverse();

  return `<div class="timeline">
${when(
  open.length === 0,
  () =>
    `<p class="empty">접수 중이거나 예정된 공고가 없습니다. 디스코드에서 <code>${esc(DISCORD_COMMANDS.addProgram)}</code>로 공고를 등록하세요.</p>`,
)}
<!-- 필터로 모두 가려졌을 때. 데이터가 없는 것으로 오해하지 않도록 전체 건수를 같이 적는다. -->
<p class="empty" data-filter-empty hidden>필터에 걸리는 공고가 없습니다 (전체 ${programs.length}건). 위의 <strong>필터 해제</strong>를 누르면 모두 보입니다.</p>
${each(groupByMonth(open), renderMonthGroup)}
${when(
  closed.length > 0,
  () =>
    `<details class="closed" data-auto-hide><summary>마감된 공고 <span data-visible-count>${closed.length}</span>건</summary>${each(
      groupByMonth(closed),
      renderMonthGroup,
    )}</details>`,
)}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ScheduleTab = 보기 전환 + 필터 + (캘린더 | 타임라인)
// ─────────────────────────────────────────────────────────────────────────────

function renderSchedule(board: BoardModel, today: Date): string {
  const facets = collectFacets(board.programs);
  const eventsByDate = groupEventsByDate(board.events);
  const months = monthSpan(
    board.events.map((e) => e.date),
    today,
  ).map(({ year, month }) => buildMonthGrid(year, month, today));
  const now = kstDateParts(today);
  const todayKey = monthKeyOf({ year: now.year, month: now.month });

  return `<div class="schedule" data-filter-scope data-schedule>
<div class="toolbar"><div class="switch" role="group" aria-label="일정 보기 방식"><button type="button" data-view="calendar" aria-pressed="true">캘린더</button><button type="button" data-view="timeline" aria-pressed="false">타임라인</button></div></div>
${when(board.programs.length > 0, () => renderFilterBar(facets, board.programs.length))}
<div data-view-panel="calendar">${renderCalendar(months, eventsByDate, todayKey, board.programs.length)}</div>
<div data-view-panel="timeline" hidden>${renderTimeline(board.programs)}</div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// KanbanTab / KanbanColumn
// ─────────────────────────────────────────────────────────────────────────────

function renderCard({ application, program, deadline, targetDaysLeft, overdueUnsubmitted, docs }: ApplicationView): string {
  const pct = docs.total === 0 ? 0 : Math.round((docs.ready / docs.total) * 100);
  const title = program
    ? titleLink(program)
    : `<span class="title missing">${esc(application.programId)} (공고 데이터 없음)</span>`;

  return `<li${cls('card', `priority-${application.priority}`, { overdue: overdueUnsubmitted })}>
<div class="top">${
    deadline
      ? `<span${cls('dday', `tone-${DEADLINE_TONE[deadline.state]}`)}>${esc(formatDday(deadline.daysLeft))}</span>`
      : '<span class="dday missing">공고 없음</span>'
  }${application.priority === 'high' ? badge('HIGH', 'red', true) : ''}${application.priority === 'low' ? badge('low', 'gray') : ''}</div>
${title}
${when(
  program,
  () =>
    `<p class="org">${esc(program!.organizer)} · 마감 ${esc(formatShortDate(program!.applyEnd))}${
      program!.applyEndTime ? ` ${esc(program!.applyEndTime)}` : ' (시각 미확인)'
    }</p>`,
)}
<div class="meta"><span class="owner" title="담당">${esc(application.owner)}</span>${when(
    application.targetSubmitDate,
    () =>
      `<span${cls('target', { overdue: overdueUnsubmitted })}>내부 ${esc(formatShortDate(application.targetSubmitDate!))}${
        targetDaysLeft !== null ? ` ${formatDday(targetDaysLeft)}` : ''
      }</span>`,
  )}${when(application.submittedAt, () => `<span class="submitted">제출 ${esc(formatShortDate(application.submittedAt!))}</span>`)}</div>
${
  docs.total > 0
    ? `<div class="docs"${attr('title', `서류 ${docs.ready}/${docs.total} 준비`)}><span class="docs-label">서류 ${docs.ready}/${docs.total}</span><span class="bar" aria-hidden="true"><span${cls(
        'fill',
        { partial: pct < 100 },
      )} style="width:${Math.max(0, Math.min(100, pct))}%"></span></span></div>`
    : '<div class="docs docs-none">연결된 서류 없음</div>'
}
${when(overdueUnsubmitted, () => '<p class="alert">내부 마감 지남 · 미제출</p>')}
${when(application.note, () => `<p class="note"${attr('title', application.note)}>${esc(application.note)}</p>`)}
</li>`;
}

function renderColumn(status: ApplicationStatus, cards: ApplicationView[]): string {
  // 컬럼 안에서는 마감 임박순. 공고 데이터가 없는 카드는 맨 뒤.
  // Infinity - Infinity는 NaN이라 정렬 순서가 미정의가 된다. 유한값으로 대체한다.
  const sorted = [...cards].sort(
    (a, b) =>
      (a.deadline?.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.deadline?.daysLeft ?? Number.MAX_SAFE_INTEGER),
  );
  return `<section class="column"${attr('aria-label', `${status} ${cards.length}건`)}>
<h3 class="col-head"><span>${esc(status)}</span><span class="count">${cards.length}</span></h3>
${sorted.length === 0 ? '<p class="none">없음</p>' : `<ul class="cards">${each(sorted, renderCard)}</ul>`}
</section>`;
}

function renderKanban(applications: ApplicationView[]): string {
  const byStatus = (status: ApplicationStatus) => applications.filter((v) => v.application.status === status);
  const resultCounts = RESULT_STATUSES.map((status) => ({ status, count: byStatus(status).length }));
  const resultTotal = resultCounts.reduce((n, r) => n + r.count, 0);

  return `<div class="kanban">
<p class="notice">읽기 전용 보드입니다. 상태를 바꾸려면 디스코드에서 <code>${esc(DISCORD_COMMANDS.changeStatus)}</code>을 쓰세요 — 이 화면에는 저장 경로가 없습니다. 카드의 담당자 이니셜은 <code>${esc(
    DISCORD_COMMANDS.me,
  )}</code>로 내 계정에 한 번 등록해 두세요 — 등록하지 않으면 <code>${esc(DISCORD_COMMANDS.myDeadlines)}</code>이 근사 매칭으로 틀린 결과를 줄 수 있습니다.</p>
${when(
  applications.length === 0,
  () =>
    `<p class="empty">지원건이 없습니다. 디스코드에서 <code>${esc(DISCORD_COMMANDS.changeStatus)}</code>으로 공고를 골라 상태를 잡으면 지원건이 생깁니다.</p>`,
)}
<div class="board">${each(ACTIVE_STATUSES, (status) => renderColumn(status, byStatus(status)))}</div>
<details class="results">
<summary><span>결과</span><span class="count">${resultTotal}</span><span class="hint">${esc(resultCounts.map((r) => `${r.status} ${r.count}`).join(' · '))}</span></summary>
<div class="board">${each(RESULT_STATUSES, (status) => renderColumn(status, byStatus(status)))}</div>
</details>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DocumentsTab
// ─────────────────────────────────────────────────────────────────────────────

function docStateLabel({ expiry }: DocumentView): string {
  if (expiry.state === 'expiring' && expiry.daysLeft !== null) {
    return `${DOC_STATE_LABEL.expiring} ${formatDday(expiry.daysLeft)}`;
  }
  return DOC_STATE_LABEL[expiry.state];
}

function usageLabel(usage: DocumentView['usedBy'][number]): string {
  return usage.program?.title ?? usage.application.programId;
}

function renderDocument(view: DocumentView): string {
  const { document: doc, expiry, usedBy, blocksActive } = view;
  const alarming = expiry.state === 'expired' || expiry.state === 'expiring';
  return `<li${cls('doc', `expiry-${expiry.state}`, { blocking: blocksActive })}>
<div class="head"><span${cls('check', { on: doc.ready })} role="img"${attr('aria-label', doc.ready ? '준비 완료' : '미준비')}>${
    doc.ready ? '✓' : ''
  }</span><span class="name">${esc(doc.name)}</span>${badge(doc.kind)}${badge(docStateLabel(view), DOC_STATE_TONE[expiry.state], alarming)}${
    doc.ready ? '' : badge('미준비', 'amber')
  }</div>
<dl class="facts">
<dt>유효기한</dt>
<dd>${
    expiry.validUntil && expiry.daysLeft !== null
      ? `<span${cls({ alarm: alarming })}><strong>${esc(expiry.validUntil)}</strong> (${esc(formatDday(expiry.daysLeft))})</span>`
      : '<span class="muted">미확인 — 발급일+유효일수 또는 유효기한을 입력하면 계산됩니다</span>'
  }${when(
    doc.issuedAt,
    () => `<span class="muted"> · 발급 ${esc(doc.issuedAt)}${doc.validityDays ? ` + ${doc.validityDays}일` : ''}</span>`,
  )}</dd>
<dt>재사용</dt>
<dd>${doc.reusable ? '가능' : '<span class="muted">불가 (건별 재발급)</span>'}${when(
    doc.reuseSource,
    () => `<span class="source"> — ${esc(doc.reuseSource)}</span>`,
  )}</dd>
<dt>사용처</dt>
<dd>${
    usedBy.length > 0
      ? `<ul class="uses">${each(
          usedBy,
          (u) =>
            `<li${cls({ inactive: !isActiveStatus(u.application.status) })}><span>${esc(usageLabel(u))}</span><span class="st">${esc(
              u.application.status,
            )}</span></li>`,
        )}</ul>`
      : '<span class="muted">연결된 지원건 없음</span>'
  }</dd>
</dl>
</li>`;
}

function renderDocuments(documents: DocumentView[]): string {
  const blocking = documents.filter((v) => v.blocksActive);
  return `<div class="documents">
${when(
  blocking.length > 0,
  () =>
    `<div class="banner" role="alert"><p><strong>만료된 서류가 진행 중인 지원건에 연결되어 있습니다.</strong> 재발급 후 디스코드에서 <code>${esc(
      DISCORD_COMMANDS.addDocument,
    )}</code>로 새 발급일(또는 유효기한)을 등록하세요.</p><ul>${each(
      blocking,
      (v) =>
        `<li><b>${esc(v.document.name)}</b> → ${esc(
          v.usedBy
            .filter((u) => isActiveStatus(u.application.status))
            .map((u) => `${usageLabel(u)} (${u.application.status})`)
            .join(', '),
        )}</li>`,
    )}</ul></div>`,
)}
${when(
  documents.length === 0,
  () =>
    `<p class="empty">등록된 서류가 없습니다. 디스코드에서 <code>${esc(DISCORD_COMMANDS.addDocument)}</code>로 서류를 등록하고 <code>${esc(DISCORD_COMMANDS.linkDocument)}</code>로 지원건에 연결하세요.</p>`,
)}
<ul class="list">${each(documents, renderDocument)}</ul>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 페이지
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 완성된 HTML 문서를 돌려준다. CSS·JS는 인라인이다(자산 요청 0회).
 * 정적 빌드 시절과의 차이: '오늘'이 빌드 시각이 아니라 요청 시각이라 D-day가 항상 맞다.
 */
export function renderPage(input: PageInput): string {
  const { today, profile } = input;
  const board = buildBoard(input as BoardInput);
  const now = kstDateParts(today);
  const todayStr = toDateStr(now.year, now.month, now.day);

  const tabs = [
    { id: 'timeline', label: '일정', count: board.programs.length },
    { id: 'kanban', label: '진행', count: board.summary.activeCount },
    { id: 'documents', label: '서류', count: board.documents.length },
  ];

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<meta name="robots" content="noindex, nofollow" />
<meta name="description" content="예비창업팀 지원사업 일정·진행·서류 대시보드" />
<title>GrantBoard</title>
<style>${STYLES}</style>
</head>
<body>
<div class="page">
<header class="masthead">
<a class="brand" href="/">GrantBoard</a>
<p class="meta">
<span>기준일 <strong>${esc(todayStr)}</strong> <span class="dim-text">(KST · 열 때마다 다시 계산)</span></span>
<span>사업자 ${profile.hasBusinessRegistration ? '등록' : '미등록'}</span>
<span>법인 ${esc(profile.incorporatedAt ?? '미설립')}</span>
<span>${esc(profile.region)}</span>
</p>
</header>
${renderSummary(board.summary)}
<nav class="tabs" role="tablist" aria-label="보드 화면">${each(
    tabs,
    (tab, i) =>
      `<button type="button" role="tab"${attr('id', `tab-${tab.id}`)}${attr('aria-controls', `panel-${tab.id}`)}${attr(
        'aria-selected',
        i === 0 ? 'true' : 'false',
      )}${attr('tabindex', i === 0 ? 0 : -1)}${attr('data-tab', tab.id)}>${esc(tab.label)}<span class="count">${tab.count}</span></button>`,
  )}</nav>
<section id="panel-timeline" role="tabpanel" aria-labelledby="tab-timeline" data-panel="timeline">${renderSchedule(board, today)}</section>
<section id="panel-kanban" role="tabpanel" aria-labelledby="tab-kanban" data-panel="kanban" hidden>${renderKanban(board.applications)}</section>
<section id="panel-documents" role="tabpanel" aria-labelledby="tab-documents" data-panel="documents" hidden>${renderDocuments(board.documents)}</section>
<footer class="discord-note">이 화면은 읽기 전용입니다. 등록·수정은 디스코드에서 — 공고 <strong>${esc(
    DISCORD_COMMANDS.addProgram,
  )}</strong> · 지원 상태 <strong>${esc(DISCORD_COMMANDS.changeStatus)}</strong> · 서류 <strong>${esc(
    DISCORD_COMMANDS.addDocument,
  )}</strong>/<strong>${esc(DISCORD_COMMANDS.completeDocument)}</strong>/<strong>${esc(
    DISCORD_COMMANDS.linkDocument,
  )}</strong>. 담당자는 <strong>${esc(DISCORD_COMMANDS.me)}</strong>로 한 번 등록해야 <strong>${esc(
    DISCORD_COMMANDS.myDeadlines,
  )}</strong>이 정확합니다. 이 페이지는 <strong>${esc(DISCORD_COMMANDS.calendar)}</strong>로 다시 열 수 있습니다.</footer>
</div>
<script>${CLIENT_BUNDLE}</script>
</body>
</html>`;
}
