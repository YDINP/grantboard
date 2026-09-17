/**
 * 매일 낮 12시(KST)에 보낼 "내일(D-1) 마감" 전용 알림의 대상 선택 순수 함수. 부수효과 없음,
 * 네트워크 접근 절대 금지 — src/lib/digest.ts와 같은 원칙이다.
 *
 * 08:30 다이제스트(src/lib/digest.ts)의 deadlineSoon(마감 3일 이내)과 역할을 분리한다:
 *   - 08:30: 전반 현황, @here는 D-day(오늘 마감)일 때만
 *   - 12:00(이 모듈): 내일 마감인 건만, 대상이 있으면 항상 @here
 * 같은 건을 두 알림이 동시에 @here로 울리면 알림 피로로 채널을 음소거하게 되므로, "할 일이
 * 남았는지" 판정(hasPreSubmitWork)은 board.ts에서 공유해 두 알림이 서로 다르게 판단하지 않는다.
 *
 * 날짜·마감상태 판정은 전부 buildBoard(board.ts)에 위임한다 — 여기서 KST 로직을 새로 짜지 않는다.
 */

import { buildBoard, hasPreSubmitWork, type BoardInput, type ProgramView } from './board.ts';

export type DeadlineTomorrowInput = BoardInput;

/**
 * 내일 마감(daysLeft === 1)이면서 아직 할 일이 남은 공고만 고른다.
 * 대상이 없으면 빈 배열 — 호출자(worker/cron/deadlineTomorrow.ts)는 빈 배열이면 아무것도 보내지
 * 않는다("조용한 날은 조용해야 한다"는 원칙은 digest.ts와 같다).
 */
export function selectDeadlineTomorrow(
  programs: BoardInput['programs'],
  applications: BoardInput['applications'],
  documents: BoardInput['documents'],
  profile: BoardInput['profile'],
  today: Date,
): ProgramView[] {
  const board = buildBoard({ programs, applications, documents, profile, today });
  return board.programs.filter((v) => v.deadline.daysLeft === 1 && hasPreSubmitWork(v));
}
