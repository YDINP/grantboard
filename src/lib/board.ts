/**
 * 대시보드 뷰모델 조립. 세 컬렉션을 programId / documentId로 묶고 파생 판정을 붙인다.
 * 날짜·자격·만료 계산은 전부 schedule.ts / eligibility.ts / documents.ts를 호출만 한다 —
 * 여기서 새로 짜지 말 것 (KST 처리가 두 벌 생기면 반드시 어긋난다).
 */

import type { CollectionEntry } from 'astro:content';
import { daysUntil, deadlineState, type DeadlineState } from './schedule.ts';
import { judgeEligibility, type EligibilityResult, type TeamProfile } from './eligibility.ts';
import { documentExpiry, type DocumentExpiry, type DocumentExpiryState } from './documents.ts';

export type Program = CollectionEntry<'programs'>['data'];
export type Application = CollectionEntry<'applications'>['data'];
export type Document = CollectionEntry<'documents'>['data'];
export type ApplicationStatus = Application['status'];

/** 칸반 기본 노출 컬럼. 배열 순서가 곧 진행 순서다. */
export const ACTIVE_STATUSES = [
  '검토중',
  '준비',
  '작성중',
  '제출완료',
  '서류통과',
] as const satisfies readonly ApplicationStatus[];

/** 결과 계열. 칸반에서 접힌 섹션으로 분리한다. */
export const RESULT_STATUSES = ['최종선정', '탈락', '미지원'] as const satisfies readonly ApplicationStatus[];

/**
 * 아직 제출하지 않은 단계. 내부 마감 초과 경고(overdueUnsubmitted)가 이 단계에서만 의미가 있는 것과
 * 같은 이유로, 다이제스트의 "마감 임박, 아직 할 일이 남은 공고"(src/lib/digest.ts의 deadlineSoon)도
 * 이 상태를 기준으로 판정한다 — isActiveStatus(ACTIVE_STATUSES)는 제출완료/서류통과까지 포함해서
 * "더 할 일이 없는데 마감이 임박했다고 알리는" 오탐을 만든다. export해서 digest.ts가 재사용한다.
 */
export const PRE_SUBMIT_STATUSES = ['검토중', '준비', '작성중'] as const satisfies readonly ApplicationStatus[];

/** 발표 예정일 경과 판정에서 '결과가 나온' 것으로 보는 상태. 미지원은 발표일과 무관하므로 제외한다. */
const ANNOUNCED_RESULT_STATUSES: readonly ApplicationStatus[] = ['최종선정', '탈락'];

export function isActiveStatus(status: ApplicationStatus): boolean {
  return (ACTIVE_STATUSES as readonly ApplicationStatus[]).includes(status);
}

/** 제출 전 단계(PRE_SUBMIT_STATUSES)인지 — "아직 마감 전에 할 일이 남았는지" 판정에 쓴다. */
export function isPreSubmitStatus(status: ApplicationStatus): boolean {
  return (PRE_SUBMIT_STATUSES as readonly ApplicationStatus[]).includes(status);
}

export interface Deadline {
  /** applyEnd까지 남은 일수. 음수면 마감 지남. */
  daysLeft: number;
  state: DeadlineState;
}

export interface ApplicationView {
  application: Application;
  /** programId가 가리키는 공고. 삭제된 공고를 가리키면 null — 화면이 죽지 않게 한다. */
  program: Program | null;
  deadline: Deadline | null;
  /** 내부 마감(targetSubmitDate)까지 남은 일수. 미설정이면 null. */
  targetDaysLeft: number | null;
  /** 내부 마감이 지났는데 아직 제출 전 단계 → 경고 대상. */
  overdueUnsubmitted: boolean;
  /** 공고의 발표 예정일이 지났는데 아직 결과 계열(최종선정/탈락)이 아님 → 경고 대상. */
  announceOverdue: boolean;
  /** documentIds 중 ready인 서류 비율. */
  docs: { total: number; ready: number };
}

export interface ProgramView {
  program: Program;
  deadline: Deadline;
  /** upcoming일 때 접수 시작까지 남은 일수. 그 외 null. */
  startsIn: number | null;
  eligibility: EligibilityResult;
  /** 이 공고에 대한 우리 팀 지원건 (programs:applications = 1:N). */
  applications: ApplicationView[];
}

/**
 * 이 공고가 "아직 마감 전에 할 일이 남았는지" — 지원건이 아예 없거나(지원 여부 결정 자체가 할 일),
 * 하나라도 제출 전 단계(PRE_SUBMIT_STATUSES)면 true. src/lib/digest.ts의 마감임박 섹션(3일 이내)과
 * src/lib/deadlineTomorrow.ts의 내일마감 전용 알림(daysLeft===1)이 이 판정을 공유한다 — 두 알림이
 * "할 일이 남았는지"를 서로 다르게 판단하면 한쪽엔 뜨고 한쪽엔 안 뜨는 불일치가 생긴다.
 */
export function hasPreSubmitWork(view: ProgramView): boolean {
  if (view.applications.length === 0) return true;
  return view.applications.some((v) => isPreSubmitStatus(v.application.status));
}

/**
 * 제출 이후 단계(제출완료/서류통과/최종선정/탈락)인지 — "실제로 제출은 했는지"만 본다. 결과가
 * 나왔는지(최종선정/탈락)와는 무관하게 true다. isPreSubmitStatus의 반대는 아니다 — '미지원'은
 * 어느 쪽도 아니다(제출 전 단계도, 제출 이후 단계도 아니다).
 * src/lib/deadlineClosed.ts(마감 통지 알림)가 "제출완료"/"미제출"/"미지원" 3분류 중 "제출완료"를
 * 가를 때 이 술어를 쓴다.
 */
export function hasSubmittedStatus(status: ApplicationStatus): boolean {
  return !isPreSubmitStatus(status) && status !== '미지원';
}

export interface DocumentUsage {
  application: Application;
  program: Program | null;
}

export interface DocumentView {
  document: Document;
  expiry: DocumentExpiry;
  /** applications.documentIds를 뒤집은 역참조 — 이 서류를 쓰는 지원건. */
  usedBy: DocumentUsage[];
  /** 만료됐는데 진행 중 지원건에 물려 있음 → 최상단 경고 대상. */
  blocksActive: boolean;
}

export interface BoardSummary {
  /** 마감이 지나지 않은 공고 중 가장 임박한 것. 없으면 null. */
  nearest: ProgramView | null;
  activeCount: number;
  /** 만료됨 + 만료 임박 서류 수. */
  docAlertCount: number;
  /** 내부 마감 지난 미제출 건수. */
  overdueCount: number;
}

/**
 * 달력에 올리는 이벤트 종류. 배열 순서가 곧 같은 날 안의 표시 순서(중요도)다.
 * apply-end(접수 마감) > target(내부 마감) > announce(발표 예정) > apply-start(접수 시작)
 */
export const CALENDAR_EVENT_KINDS = ['apply-end', 'target', 'announce', 'apply-start'] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

export interface CalendarEvent {
  /** DOM 식별용. `${kind}:${programId}` 또는 내부 마감이면 `${kind}:${applicationId}`. */
  key: string;
  kind: CalendarEventKind;
  /** 'YYYY-MM-DD' */
  date: string;
  program: ProgramView;
  /** 내부 마감(target)만 특정 지원건에 속한다. 그 외 null. */
  application: ApplicationView | null;
  /** 이 이벤트 날짜까지 남은 일수. 음수면 지남. */
  daysLeft: number;
  /**
   * '마감된 공고 숨기기'에 걸리는 이벤트인지 = 공고가 마감됐고 이 날짜도 지났음.
   * 마감된 공고라도 발표 예정일이 아직 남아 있으면 결과 확인용으로 살아 있어야 하므로 stale이 아니다.
   */
  stale: boolean;
}

export interface BoardModel {
  /** 마감일 오름차순. */
  programs: ProgramView[];
  applications: ApplicationView[];
  /** 만료됨 → 임박 → 미확인 → 유효 순. */
  documents: DocumentView[];
  /** 날짜 오름차순, 같은 날은 CALENDAR_EVENT_KINDS 순. */
  events: CalendarEvent[];
  summary: BoardSummary;
}

export interface BoardInput {
  programs: Program[];
  applications: Application[];
  documents: Document[];
  profile: TeamProfile;
  /** 모든 파생 계산이 같은 '오늘'을 쓰도록 호출자가 한 번만 만들어 넘긴다. */
  today: Date;
}

const EXPIRY_ORDER: Record<DocumentExpiryState, number> = { expired: 0, expiring: 1, unknown: 2, valid: 3 };

function toDeadline(program: Program, today: Date): Deadline {
  return { daysLeft: daysUntil(program.applyEnd, today), state: deadlineState(program, today) };
}

const KIND_ORDER: Record<CalendarEventKind, number> = Object.fromEntries(
  CALENDAR_EVENT_KINDS.map((kind, i) => [kind, i]),
) as Record<CalendarEventKind, number>;

/**
 * 공고 뷰에서 달력 이벤트 4종을 뽑는다. 날짜가 없는 항목(applyStart·announceDate·targetSubmitDate 미설정)은
 * 이벤트를 만들지 않는다. 정렬은 날짜 → 종류 중요도 → 공고 제목.
 */
export function buildCalendarEvents(programs: readonly ProgramView[], today: Date): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const push = (
    kind: CalendarEventKind,
    date: string,
    program: ProgramView,
    application: ApplicationView | null,
  ) => {
    const daysLeft = daysUntil(date, today);
    events.push({
      key: `${kind}:${application ? application.application.id : program.program.id}`,
      kind,
      date,
      program,
      application,
      daysLeft,
      stale: program.deadline.state === 'closed' && daysLeft < 0,
    });
  };

  for (const view of programs) {
    const { program } = view;
    push('apply-end', program.applyEnd, view, null);
    if (program.applyStart) push('apply-start', program.applyStart, view, null);
    if (program.announceDate) push('announce', program.announceDate, view, null);
    for (const application of view.applications) {
      if (application.application.targetSubmitDate) {
        push('target', application.application.targetSubmitDate, view, application);
      }
    }
  }

  return events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.program.program.title.localeCompare(b.program.program.title, 'ko'),
  );
}

/** 날짜별로 묶는다. 입력 순서를 보존한다. */
export function groupEventsByDate(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const bucket = byDate.get(event.date);
    if (bucket) bucket.push(event);
    else byDate.set(event.date, [event]);
  }
  return byDate;
}

export function buildBoard({ programs, applications, documents, profile, today }: BoardInput): BoardModel {
  const programById = new Map(programs.map((p) => [p.id, p]));
  const documentById = new Map(documents.map((d) => [d.id, d]));

  const applicationViews: ApplicationView[] = applications.map((application) => {
    const program = programById.get(application.programId) ?? null;
    const targetDaysLeft = application.targetSubmitDate ? daysUntil(application.targetSubmitDate, today) : null;
    const overdueUnsubmitted =
      targetDaysLeft !== null &&
      targetDaysLeft < 0 &&
      !application.submittedAt &&
      isPreSubmitStatus(application.status);
    const ready = application.documentIds.filter((id) => documentById.get(id)?.ready).length;
    const announceOverdue =
      program?.announceDate !== undefined &&
      daysUntil(program.announceDate, today) < 0 &&
      !ANNOUNCED_RESULT_STATUSES.includes(application.status);
    return {
      application,
      program,
      deadline: program ? toDeadline(program, today) : null,
      targetDaysLeft,
      overdueUnsubmitted,
      announceOverdue,
      docs: { total: application.documentIds.length, ready },
    };
  });

  const programViews: ProgramView[] = [...programs]
    .sort((a, b) => a.applyEnd.localeCompare(b.applyEnd) || a.title.localeCompare(b.title, 'ko'))
    .map((program) => {
      const deadline = toDeadline(program, today);
      return {
        program,
        deadline,
        startsIn:
          deadline.state === 'upcoming' && program.applyStart ? daysUntil(program.applyStart, today) : null,
        eligibility: judgeEligibility(program, profile, today),
        applications: applicationViews.filter((v) => v.application.programId === program.id),
      };
    });

  const documentViews: DocumentView[] = documents
    .map((document) => {
      const expiry = documentExpiry(document, today);
      const usedBy = applicationViews
        .filter((v) => v.application.documentIds.includes(document.id))
        .map(({ application, program }) => ({ application, program }));
      const blocksActive =
        expiry.state === 'expired' && usedBy.some((u) => isActiveStatus(u.application.status));
      return { document, expiry, usedBy, blocksActive };
    })
    .sort(
      (a, b) =>
        EXPIRY_ORDER[a.expiry.state] - EXPIRY_ORDER[b.expiry.state] ||
        a.document.name.localeCompare(b.document.name, 'ko'),
    );

  return {
    programs: programViews,
    applications: applicationViews,
    documents: documentViews,
    events: buildCalendarEvents(programViews, today),
    summary: {
      nearest: programViews.find((v) => v.deadline.state !== 'closed') ?? null,
      activeCount: applicationViews.filter((v) => isActiveStatus(v.application.status)).length,
      docAlertCount: documentViews.filter((v) => v.expiry.state === 'expired' || v.expiry.state === 'expiring')
        .length,
      overdueCount: applicationViews.filter((v) => v.overdueUnsubmitted).length,
    },
  };
}
