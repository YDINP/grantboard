/**
 * 일정 탭 필터(카테고리·진행 상태·담당자·자격 판정·마감 숨김) 순수 함수.
 * 빌드타임에는 각 항목의 필터 속성(data-f-*)과 선택지(facets)를 만들고,
 * 클라이언트 스크립트는 같은 matchesFilter를 import해서 hidden을 토글한다 — 판정 로직이 한 벌이어야
 * 서버 렌더 결과와 화면의 개수 표시가 어긋나지 않는다.
 *
 * 규칙: 같은 항목 안의 다중 선택은 OR, 항목 간에는 AND. 아무것도 고르지 않은 항목은 제한 없음.
 */

import type { CalendarEvent, ProgramView } from './board.ts';
import type { EligibilityVerdict } from './eligibility.ts';

/** 지원건이 하나도 없는 공고를 '진행 상태' 항목에서 고를 수 있게 하는 가상 상태 값. */
export const NO_APPLICATION = '__none__';
export const NO_APPLICATION_LABEL = '미지원(지원건 없음)';

/** data 속성 한 칸에 여러 값을 담을 때의 구분자. 담당자(≤4자)·상태 값에 들어갈 일이 없는 문자. */
export const VALUE_SEPARATOR = '|';

/** content.config.ts의 enum 순서. 선택지 정렬에만 쓰고, 데이터에 없는 값은 만들지 않는다. */
const CATEGORY_ORDER = ['정부지원사업', '공모전', '경진대회', '교육프로그램', '기타'];
const STATUS_ORDER = ['검토중', '준비', '작성중', '제출완료', '서류통과', '최종선정', '탈락', '미지원'];
const VERDICT_ORDER: EligibilityVerdict[] = ['eligible', 'needs-check', 'ineligible'];

export interface FilterFacets {
  categories: string[];
  /** 실제 status 값 + (지원건 없는 공고가 있으면) NO_APPLICATION. */
  statuses: string[];
  owners: string[];
  verdicts: EligibilityVerdict[];
  /** 마감된 공고가 하나라도 있는지. 없으면 '마감 숨기기' 토글을 그릴 이유가 없다. */
  hasClosed: boolean;
}

/** 한 항목(공고·이벤트)이 가진 필터 대상 속성. */
export interface FilterAttrs {
  category: string;
  /** 비어 있으면 안 된다 — 지원건 없는 공고는 [NO_APPLICATION]. */
  statuses: string[];
  owners: string[];
  verdict: string;
  /** '마감된 공고 숨기기'에 걸리는 항목인지. */
  closed: boolean;
}

export interface FilterState {
  category: string[];
  status: string[];
  owner: string[];
  verdict: string[];
  hideClosed: boolean;
}

export const DEFAULT_FILTER: FilterState = Object.freeze({
  category: [],
  status: [],
  owner: [],
  verdict: [],
  hideClosed: true,
}) as FilterState;

function sortByOrder(values: Iterable<string>, order: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    // 순서표에 없는 값(스키마가 늘어난 경우)은 뒤로, 그 안에서는 가나다.
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b, 'ko');
  });
}

/** 데이터에 실제로 존재하는 값만 선택지로 모은다. */
export function collectFacets(programs: readonly ProgramView[]): FilterFacets {
  const categories = new Set<string>();
  const statuses = new Set<string>();
  const owners = new Set<string>();
  const verdicts = new Set<EligibilityVerdict>();
  let hasClosed = false;

  for (const view of programs) {
    categories.add(view.program.category);
    verdicts.add(view.eligibility.verdict);
    if (view.deadline.state === 'closed') hasClosed = true;
    if (view.applications.length === 0) statuses.add(NO_APPLICATION);
    for (const { application } of view.applications) {
      statuses.add(application.status);
      owners.add(application.owner);
    }
  }

  // NO_APPLICATION은 실제 상태들 뒤, 맨 끝에.
  const realStatuses = sortByOrder([...statuses].filter((s) => s !== NO_APPLICATION), STATUS_ORDER);
  return {
    categories: sortByOrder(categories, CATEGORY_ORDER),
    statuses: statuses.has(NO_APPLICATION) ? [...realStatuses, NO_APPLICATION] : realStatuses,
    owners: [...owners].sort((a, b) => a.localeCompare(b, 'ko')),
    verdicts: VERDICT_ORDER.filter((v) => verdicts.has(v)),
    hasClosed,
  };
}

export function programFilterAttrs(view: ProgramView): FilterAttrs {
  return {
    category: view.program.category,
    statuses:
      view.applications.length === 0 ? [NO_APPLICATION] : view.applications.map((a) => a.application.status),
    owners: view.applications.map((a) => a.application.owner),
    verdict: view.eligibility.verdict,
    closed: view.deadline.state === 'closed',
  };
}

/**
 * 달력 이벤트의 필터 속성. 내부 마감(target)은 특정 지원건의 것이므로 그 건의 상태·담당자만 쓴다 —
 * 담당자 K로 거르면 J의 내부 마감 칩은 빠져야 한다.
 */
export function eventFilterAttrs(event: CalendarEvent): FilterAttrs {
  const base = programFilterAttrs(event.program);
  if (event.application) {
    return {
      ...base,
      statuses: [event.application.application.status],
      owners: [event.application.application.owner],
      closed: event.stale,
    };
  }
  return { ...base, closed: event.stale };
}

function intersects(selected: readonly string[], values: readonly string[]): boolean {
  return selected.length === 0 || values.some((v) => selected.includes(v));
}

export function matchesFilter(attrs: FilterAttrs, state: FilterState): boolean {
  if (state.hideClosed && attrs.closed) return false;
  return (
    intersects(state.category, [attrs.category]) &&
    intersects(state.status, attrs.statuses) &&
    intersects(state.owner, attrs.owners) &&
    intersects(state.verdict, [attrs.verdict])
  );
}

/** 기본값과 다른 선택이 하나라도 있는지. '필터 해제' 버튼과 강조 표시의 기준. */
export function isFilterActive(state: FilterState): boolean {
  return (
    state.category.length > 0 ||
    state.status.length > 0 ||
    state.owner.length > 0 ||
    state.verdict.length > 0 ||
    state.hideClosed !== DEFAULT_FILTER.hideClosed
  );
}

/** 사용자가 고른 값의 개수(마감 숨김은 기본에서 벗어났을 때만 1). 요약 배지용. */
export function countSelections(state: FilterState): number {
  return (
    state.category.length +
    state.status.length +
    state.owner.length +
    state.verdict.length +
    (state.hideClosed !== DEFAULT_FILTER.hideClosed ? 1 : 0)
  );
}

function pickKnown(raw: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  // 데이터가 바뀌어 사라진 값은 버린다 — 존재하지 않는 선택지로 화면이 비는 일을 막는다.
  return raw.filter((v): v is string => typeof v === 'string' && known.includes(v));
}

/**
 * localStorage에서 읽은 임의의 값을 안전한 FilterState로 바꾼다.
 * 형식이 깨졌거나 모르는 값이 섞여 있어도 던지지 않고 기본값으로 메운다.
 */
export function parseFilterState(raw: unknown, facets: FilterFacets): FilterState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_FILTER };
  const r = raw as Record<string, unknown>;
  return {
    category: pickKnown(r.category, facets.categories),
    status: pickKnown(r.status, facets.statuses),
    owner: pickKnown(r.owner, facets.owners),
    verdict: pickKnown(r.verdict, facets.verdicts),
    hideClosed: typeof r.hideClosed === 'boolean' ? r.hideClosed : DEFAULT_FILTER.hideClosed,
  };
}

/** data-f-* 속성 문자열 ↔ FilterAttrs. 빌드(Astro)와 클라이언트가 같은 직렬화를 쓴다. */
export function serializeAttrs(attrs: FilterAttrs): Record<string, string> {
  return {
    'data-filterable': '',
    'data-f-category': attrs.category,
    'data-f-status': attrs.statuses.join(VALUE_SEPARATOR),
    'data-f-owner': attrs.owners.join(VALUE_SEPARATOR),
    'data-f-verdict': attrs.verdict,
    'data-f-closed': attrs.closed ? '1' : '0',
  };
}

function splitValues(value: string | undefined): string[] {
  return value ? value.split(VALUE_SEPARATOR).filter(Boolean) : [];
}

export function readAttrs(dataset: DOMStringMap | Record<string, string | undefined>): FilterAttrs {
  return {
    category: dataset.fCategory ?? '',
    statuses: splitValues(dataset.fStatus),
    owners: splitValues(dataset.fOwner),
    verdict: dataset.fVerdict ?? '',
    closed: dataset.fClosed === '1',
  };
}
