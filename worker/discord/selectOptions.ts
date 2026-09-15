/**
 * STRING_SELECT 컴포넌트 옵션 목록을 board.ts의 뷰모델에서 뽑아내는 공통 헬퍼.
 * 여러 커맨드(상태 변경/공고 삭제/서류 완료/서류 연결)가 "공고/지원건/서류 하나를 골라라"라는
 * 같은 모양의 드롭다운을 쓰기 때문에 여기 한 곳에 모은다.
 *
 * 디스코드 제약: 옵션은 최대 25개, label/description은 각각 최대 100자.
 */

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

export function programSelectOptions(views: readonly ProgramView[]): SelectOption[] {
  return views.slice(0, MAX_SELECT_OPTIONS).map((v) => ({
    label: truncate(v.program.title, MAX_LABEL),
    value: v.program.id,
    description: truncate(`마감 ${v.program.applyEnd} · ${v.program.organizer}`, MAX_DESCRIPTION),
  }));
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

export function documentSelectOptions(views: readonly DocumentView[]): SelectOption[] {
  return views.slice(0, MAX_SELECT_OPTIONS).map((v) => ({
    label: truncate(v.document.name, MAX_LABEL),
    value: v.document.id,
    description: truncate(v.document.ready ? '준비완료' : '준비중', MAX_DESCRIPTION),
  }));
}
