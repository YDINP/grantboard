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

/** 아직 제출하지 않은 단계. 내부 마감 초과 경고는 이 단계에서만 의미가 있다. */
const PRE_SUBMIT_STATUSES: readonly ApplicationStatus[] = ['검토중', '준비', '작성중'];

export function isActiveStatus(status: ApplicationStatus): boolean {
  return (ACTIVE_STATUSES as readonly ApplicationStatus[]).includes(status);
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

export interface BoardModel {
  /** 마감일 오름차순. */
  programs: ProgramView[];
  applications: ApplicationView[];
  /** 만료됨 → 임박 → 미확인 → 유효 순. */
  documents: DocumentView[];
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
      PRE_SUBMIT_STATUSES.includes(application.status);
    const ready = application.documentIds.filter((id) => documentById.get(id)?.ready).length;
    return {
      application,
      program,
      deadline: program ? toDeadline(program, today) : null,
      targetDaysLeft,
      overdueUnsubmitted,
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
    summary: {
      nearest: programViews.find((v) => v.deadline.state !== 'closed') ?? null,
      activeCount: applicationViews.filter((v) => isActiveStatus(v.application.status)).length,
      docAlertCount: documentViews.filter((v) => v.expiry.state === 'expired' || v.expiry.state === 'expiring')
        .length,
      overdueCount: applicationViews.filter((v) => v.overdueUnsubmitted).length,
    },
  };
}
