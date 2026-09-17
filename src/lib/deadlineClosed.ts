/**
 * 매일 KST 09:00에 보낼 "마감된 공고" 알림의 대상 선택 순수 함수. 부수효과 없음,
 * 네트워크 접근 절대 금지 — src/lib/deadlineTomorrow.ts와 같은 원칙이다.
 *
 * "마감통지일"(closureDate = applyEnd + 1일)을 기준으로 고른다 — deadlineState(schedule.ts)가
 * remaining < 0일 때 비로소 'closed'로 넘어가는 날이 바로 이 날짜이므로, 그 다음 아침이 이
 * 알림이 정직하게 "마감됐다"고 말할 수 있는 가장 이른 시점이다.
 *
 * 마감 지난 공고는 이후 매일 계속 마감 상태다 — 매번 훑으면 영원히 같은 공고를 다시 알리게
 * 된다. 그래서 이 함수는 스스로 "오늘"만 보지 않고, 호출자(worker/cron/deadlineClosed.ts)가
 * bot_state에서 읽어 넘기는 cursor(직전까지 알린 KST 날짜 문자열)를 받아 그 이후 날짜만 고른다:
 *   - cursor === null(최초 실행)  → closureDate === today인 것만 (과거 이력을 쏟아내지 않는다)
 *   - cursor가 있으면             → cursor < closureDate <= today (누락된 날은 자동으로 따라잡는다)
 * 커서 자체를 전진시키는 책임은 호출자에게 있다 — 이 함수는 순수 선택만 한다.
 */

import {
  buildBoard,
  hasSubmittedStatus,
  type BoardInput,
  type ProgramView,
} from './board.ts';
import { addDays, kstDateParts, toDateStr } from './schedule.ts';

export type DeadlineClosedInput = BoardInput;

/**
 * 마감된 공고의 지원 상태 3분류. 이 분류가 이 알림의 가치다(그냥 "마감됐다"만 말하지 않고,
 * 우리가 뭘 했는지/안 했는지를 함께 말한다).
 *   submitted   — 지원건 중 하나라도 제출 이후 상태(hasSubmittedStatus)
 *   unapplied   — 지원건이 없거나 전부 '미지원'
 *   unsubmitted — 그 외(지원건은 있는데 하나도 제출하지 못함 — '미지원'과 섞여 있어도 포함)
 */
export type ClosureCategory = 'submitted' | 'unsubmitted' | 'unapplied';

export interface ClosedProgramItem {
  view: ProgramView;
  category: ClosureCategory;
}

/** submitted 판정이 최우선이다 — 지원건 중 하나라도 제출했으면 그 공고는 "제출완료" 취급한다. */
function classify(view: ProgramView): ClosureCategory {
  const apps = view.applications;
  if (apps.some((v) => hasSubmittedStatus(v.application.status))) return 'submitted';
  if (apps.length === 0 || apps.every((v) => v.application.status === '미지원')) return 'unapplied';
  return 'unsubmitted';
}

export function selectDeadlineClosed(
  programs: BoardInput['programs'],
  applications: BoardInput['applications'],
  documents: BoardInput['documents'],
  profile: BoardInput['profile'],
  today: Date,
  cursor: string | null,
): ClosedProgramItem[] {
  const board = buildBoard({ programs, applications, documents, profile, today });
  const { year, month, day } = kstDateParts(today);
  const todayStr = toDateStr(year, month, day);

  return board.programs
    .filter((view) => {
      const closureDate = addDays(view.program.applyEnd, 1);
      return cursor === null ? closureDate === todayStr : closureDate > cursor && closureDate <= todayStr;
    })
    .map((view) => ({ view, category: classify(view) }));
}
