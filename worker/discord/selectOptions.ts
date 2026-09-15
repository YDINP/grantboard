/**
 * STRING_SELECT 컴포넌트 옵션 목록을 board.ts의 뷰모델에서 뽑아내는 공통 헬퍼.
 * 여러 커맨드(상태 변경/공고 삭제/서류 완료/서류 연결)가 "공고/지원건/서류 하나를 골라라"라는
 * 같은 모양의 드롭다운을 쓰기 때문에 여기 한 곳에 모은다.
 *
 * 디스코드 제약: 옵션은 최대 25개, label/description은 각각 최대 100자.
 */

import { formatDday } from '../../src/lib/format.ts';
import type { ProgramView, ApplicationView, DocumentView } from '../../src/lib/board.ts';

export const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL = 100;
const MAX_DESCRIPTION = 100;

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
}

/** 25개 넘는 목록을 SELECT 한 페이지(기본 MAX_SELECT_OPTIONS개)씩 자른다. page는 범위 밖이면 안전하게 잘린다. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number = MAX_SELECT_OPTIONS): Page<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  return { items: items.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize), page: clampedPage, totalPages };
}

export function programSelectOptions(views: readonly ProgramView[]): SelectOption[] {
  return views.slice(0, MAX_SELECT_OPTIONS).map((v) => ({
    label: truncate(v.program.title, MAX_LABEL),
    value: v.program.id,
    description: truncate(`마감 ${v.program.applyEnd} · ${v.program.organizer}`, MAX_DESCRIPTION),
  }));
}

/**
 * "이 공고에 우리 팀 지원건이 있는가"를 description에 보여준다. /상태 변경·/서류 연결이 쓴다 —
 * 지원건이 없는 공고도 목록에서 빠지면 안 되므로(등록만 되고 손댈 수 없는 구멍), 그 경우
 * "미지원"이라고 명시해 사용자가 알고 고를 수 있게 한다. 호출자가 이미 25개로 자른 목록을
 * 넘긴다고 가정한다(여러 페이지를 만들 땐 paginate를 먼저 쓸 것).
 */
export function programSelectOptionsWithApplicationStatus(views: readonly ProgramView[]): SelectOption[] {
  return views.map((v) => {
    const status = v.applications.length > 0 ? `현재: ${v.applications.map((a) => a.application.status).join(', ')}` : '미지원';
    return {
      label: truncate(v.program.title, MAX_LABEL),
      value: v.program.id,
      description: truncate(`${status} · 마감 ${formatDday(v.deadline.daysLeft)}`, MAX_DESCRIPTION),
    };
  });
}

/**
 * value를 무엇으로 쓸지는 호출자가 고른다 — /상태 변경은 programId(1:1 지원건 전제)로 찾고,
 * /서류 연결은 application.id로 직접 찾는다. 나머지(라벨/설명)는 항상 같은 모양이라 공유한다.
 */
export function applicationSelectOptions(
  views: readonly ApplicationView[],
  valueOf: (view: ApplicationView) => string,
): SelectOption[] {
  return views.slice(0, MAX_SELECT_OPTIONS).map((v) => ({
    label: truncate(v.program?.title ?? v.application.programId, MAX_LABEL),
    value: valueOf(v),
    description: truncate(`현재: ${v.application.status}`, MAX_DESCRIPTION),
  }));
}

/** 마감 지난 공고를 항상 맨 아래로 보내기 위한 오프셋. 활성 공고의 daysLeft(수백 이내)보다 훨씬 크다. */
const CLOSED_SORT_OFFSET = 1_000_000;

/**
 * 공고를 "마감 임박순"으로 정렬하되, 이미 마감된 공고를 빼지 않고 맨 아래로 보낸다.
 * (결과 기록 등 마감 뒤에도 손댈 일이 남아 있을 수 있어 목록에서 빼면 안 된다.)
 * board.programs의 기본 정렬(applyEnd 오름차순)은 지난 날짜가 먼저 오므로 그대로 쓰면 안 된다.
 */
export function sortProgramsByUrgency(views: readonly ProgramView[]): ProgramView[] {
  const key = (v: ProgramView) => (v.deadline.state === 'closed' ? CLOSED_SORT_OFFSET - v.deadline.daysLeft : v.deadline.daysLeft);
  return [...views].sort((a, b) => key(a) - key(b));
}

export function documentSelectOptions(views: readonly DocumentView[]): SelectOption[] {
  return views.slice(0, MAX_SELECT_OPTIONS).map((v) => ({
    label: truncate(v.document.name, MAX_LABEL),
    value: v.document.id,
    description: truncate(v.document.ready ? '준비완료' : '준비중', MAX_DESCRIPTION),
  }));
}
