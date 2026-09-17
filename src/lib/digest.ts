/**
 * 매일 아침 팀 채널로 보낼 D-day 다이제스트 메시지 조립 순수 함수. 부수효과 없음, 네트워크 접근 절대 금지.
 * 실제 전송(Slack/Discord 웹훅 호출)은 scripts/notify.mjs에서만 한다 — collect.ts/collect.mjs와 같은 구조다.
 *
 * 날짜·마감상태·서류만료 판정은 전부 board.ts(buildBoard)에 위임한다. buildBoard가 이미
 * schedule.ts/eligibility.ts/documents.ts의 KST 헬퍼를 재사용하므로, 여기서 날짜 계산을
 * 새로 짜지 않는다 — 짜는 순간 KST 로직이 두 벌이 되어 반드시 어긋난다.
 */

import {
  buildBoard,
  isActiveStatus,
  hasPreSubmitWork,
  type BoardInput,
  type ApplicationView,
  type ProgramView,
  type DocumentView,
} from './board.ts';
import { daysUntil, kstDateParts } from './schedule.ts';

export type DigestInput = BoardInput;

/** '오늘 마감'은 D-day, 과거는 D+n(지난 일수), 미래는 D-n으로 표기한다. */
function formatDday(daysLeft: number): string {
  if (daysLeft === 0) return 'D-day';
  return daysLeft > 0 ? `D-${daysLeft}` : `D+${-daysLeft}`;
}

/** owner 필드를 가진 항목 목록에서 중복 없는 담당자 표시 문자열을 만든다. 비어 있으면 '담당자 미지정'. */
function ownersOf(items: { application: { owner: string } }[]): string {
  if (items.length === 0) return '담당자 미지정';
  return [...new Set(items.map((i) => i.application.owner))].join(', ');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 메시지 헤더에 표시할 today의 KST 날짜. schedule.ts의 kstDateParts를 그대로 쓴다 — 새로 변환하지 않는다. */
function kstDateLabel(today: Date): string {
  const { year, month, day } = kstDateParts(today);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function section(title: string, lines: string[]): string {
  return [title, ...lines].join('\n');
}

/** buildDigest(텍스트)와 worker/cron/digest.ts(Discord embed)가 공유하는, 다이제스트에 담을 네 범주. */
export interface DigestSections {
  deadlineSoon: ProgramView[];
  overdueUnsubmitted: ApplicationView[];
  docAlerts: DocumentView[];
  announceOverdue: ApplicationView[];
}

/**
 * 다이제스트에 담을 네 가지 경고 범주를 고른다. 네 범주 모두 비어 있으면 null — "오늘은
 * 조용합니다" 같은 알림도 보내지 않기 위함이다(조용한 날까지 알림이 오면 팀이 알림 자체를 꺼버린다).
 *
 * buildDigest(텍스트, scripts/notify.mjs용)와 worker/cron/digest.ts(Discord embed용)가 이 함수 하나로
 * "무엇이 다이제스트에 들어가는가"를 공유한다 — 두 출력 형식이 서로 다른 항목을 보여주면 안 되므로
 * 선택 로직은 여기 한 곳에만 둔다.
 */
export function selectDigestSections(
  programs: BoardInput['programs'],
  applications: BoardInput['applications'],
  documents: BoardInput['documents'],
  profile: BoardInput['profile'],
  today: Date,
): DigestSections | null {
  const board = buildBoard({ programs, applications, documents, profile, today });

  // 1) 오늘 마감 / 3일 이내 마감 — deadlineState의 'urgent' 정의(마감까지 3일 이내, 당일 포함)에 더해
  //    "아직 마감 전에 할 일이 남았는지"까지 본다. 마감만 보고 걸러내면, 이미 제출완료/서류통과/
  //    최종선정/탈락인 공고까지 매일 D-day/D-1로 뜨면서 실제로는 할 일이 없는데 @here까지 울리게
  //    된다(shouldMentionHere는 이 배열만 본다). isActiveStatus(ACTIVE_STATUSES)는 제출완료/
  //    서류통과까지 "진행 중"으로 치는 더 넓은 판정이라(docAlerts엔 맞지만) 여기선 안 맞는다 —
  //    대신 isPreSubmitStatus(PRE_SUBMIT_STATUSES: 검토중/준비/작성중)로 좁힌다.
  //    지원건이 아예 없는 공고는 유지한다 — "지원할지 아직 안 정했다"는 것 자체가 마감 전에
  //    결정해야 할 일이라 가장 놓치기 쉬운 경고이기 때문이다. 지원건이 여럿이면 하나라도
  //    제출 전 단계면 유지한다. 이 "할 일이 남았는지" 판정은 hasPreSubmitWork(board.ts)로 뽑아
  //    src/lib/deadlineTomorrow.ts(D-1 전용 알림)와 공유한다.
  const deadlineSoon: ProgramView[] = board.programs.filter(
    (v) => v.deadline.state === 'urgent' && hasPreSubmitWork(v),
  );

  // 2) 내부 마감(targetSubmitDate)이 지났는데 아직 미제출 — 가장 실질적인 경고.
  const overdueUnsubmitted: ApplicationView[] = board.applications
    .filter((v) => v.overdueUnsubmitted)
    .sort((a, b) => (a.targetDaysLeft ?? 0) - (b.targetDaysLeft ?? 0));

  // 3) 만료됐거나 14일 이내 만료되는 서류 중, 진행 중(active) 지원건에 실제로 물려 있는 것만.
  //    쓰이지 않는 서류의 만료는 소음이므로 뺀다.
  const docAlerts: DocumentView[] = board.documents.filter(
    (v) =>
      (v.expiry.state === 'expired' || v.expiry.state === 'expiring') &&
      v.usedBy.some((u) => isActiveStatus(u.application.status)),
  );

  // 4) 발표 예정일이 지났는데 상태가 결과 계열(최종선정/탈락)이 아닌 지원건 — 결과 확인 필요.
  const announceOverdue: ApplicationView[] = board.applications
    .filter((v) => v.announceOverdue)
    .sort((a, b) => {
      const aDays = a.program?.announceDate ? daysUntil(a.program.announceDate, today) : 0;
      const bDays = b.program?.announceDate ? daysUntil(b.program.announceDate, today) : 0;
      return aDays - bDays;
    });

  if (
    deadlineSoon.length === 0 &&
    overdueUnsubmitted.length === 0 &&
    docAlerts.length === 0 &&
    announceOverdue.length === 0
  ) {
    return null;
  }

  return { deadlineSoon, overdueUnsubmitted, docAlerts, announceOverdue };
}

export type DigestUrgency = 'red' | 'orange' | 'green';

/**
 * 다이제스트 전체의 긴급도. Discord embed 색상 + @here 멘션 판단(shouldMentionHere)의 재료다.
 *   red    — 마감 당일이거나 이미 지남: deadlineSoon에 D-day(daysLeft 0)가 있거나, 내부마감 초과/
 *            발표일 경과 항목이 있거나(둘 다 정의상 "이미 지남"), 서류가 만료됨(expired)
 *   orange — D-3 이내: deadlineSoon에 D-1~D-3이 있거나, 서류 만료가 3일 이내로 임박함
 *   green  — 그 외(만료 임박 서류가 4일 이상 남은 경우 등, 급하진 않지만 알려는 줘야 하는 신호)
 *
 * 내부마감 초과/발표일 경과는 "언제까지"가 아니라 "이미 지났다"는 사실 자체가 신호라, 별도
 * daysLeft 없이 곧장 red 취급용 sentinel(-1)을 넣는다.
 */
export function digestUrgency(sections: DigestSections): DigestUrgency {
  const daysLeftCandidates: number[] = [];
  for (const v of sections.deadlineSoon) daysLeftCandidates.push(v.deadline.daysLeft);
  for (const v of sections.docAlerts) {
    if (v.expiry.daysLeft !== null) daysLeftCandidates.push(v.expiry.daysLeft);
  }
  if (sections.overdueUnsubmitted.length > 0 || sections.announceOverdue.length > 0) {
    daysLeftCandidates.push(-1);
  }

  if (daysLeftCandidates.length === 0) return 'green';
  const worst = Math.min(...daysLeftCandidates);
  if (worst <= 0) return 'red';
  if (worst <= 3) return 'orange';
  return 'green';
}

/**
 * @here로 부를지. 실제 마감이 D-day(오늘)일 때만 true — 그 외에는 절대 멘션하지 않는다.
 * (팀 요청: 매일 같은 방식으로 멘션하면 알림 피로로 채널을 음소거하게 되고, 정작 급한 날에도
 * 아무도 안 보게 된다. 서류만료·내부마감초과·발표경과는 급하지만 "오늘 당장 제출해야 하는
 * 마감"은 아니므로 멘션 기준에서 뺀다. @everyone은 오프라인 멤버까지 깨우므로 절대 쓰지 않는다
 * — 이 함수는 애초에 @here 여부만 판단하고, @everyone은 선택지에 없다.
 *
 * D-1(내일 마감)은 KST 12:00 전용 알림(src/lib/deadlineTomorrow.ts, worker/cron/deadlineTomorrow.ts)이
 * 전담한다 — 08:30 다이제스트가 D-1까지 @here로 울리면 같은 건으로 하루 두 번 멘션하게 된다.)
 */
export function shouldMentionHere(sections: DigestSections): boolean {
  return sections.deadlineSoon.some((v) => v.deadline.daysLeft <= 0);
}

/**
 * 다이제스트를 사람이 읽을 텍스트 메시지로 조립한다. 무엇을 담을지는 selectDigestSections가 정한다 —
 * 텍스트 조립(이 함수)과 Discord embed 조립(worker/cron/digest.ts)이 서로 다른 항목을 보여주지
 * 않도록, "선택"과 "표시"를 분리했다.
 */
export function buildDigest(
  programs: BoardInput['programs'],
  applications: BoardInput['applications'],
  documents: BoardInput['documents'],
  profile: BoardInput['profile'],
  today: Date,
): string | null {
  const selected = selectDigestSections(programs, applications, documents, profile, today);
  if (!selected) return null;
  const { deadlineSoon, overdueUnsubmitted, docAlerts, announceOverdue } = selected;

  const sections: string[] = [`📋 GrantBoard D-day 다이제스트 (${kstDateLabel(today)})`];

  if (deadlineSoon.length > 0) {
    sections.push(
      section(
        '🚨 오늘/3일 이내 마감',
        deadlineSoon.map((v) => {
          const owners = ownersOf(v.applications);
          return `• ${v.program.title} — ${formatDday(v.deadline.daysLeft)} · 담당 ${owners} · ${v.program.sourceUrl}`;
        }),
      ),
    );
  }

  if (overdueUnsubmitted.length > 0) {
    sections.push(
      section(
        '⚠️ 내부 마감 초과 미제출',
        overdueUnsubmitted.map((v) => {
          const title = v.program?.title ?? '(공고 정보 없음 — programId 확인 필요)';
          const link = v.program?.sourceUrl ?? '#';
          const dday = v.targetDaysLeft !== null ? formatDday(v.targetDaysLeft) : '미확인';
          return `• ${title} — 내부마감 ${dday} · 담당 ${v.application.owner} · ${link}`;
        }),
      ),
    );
  }

  if (docAlerts.length > 0) {
    sections.push(
      section(
        '📄 서류 만료/만료 임박 (진행 중 지원건에 사용됨)',
        docAlerts.map((v) => {
          const activeUsages = v.usedBy.filter((u) => isActiveStatus(u.application.status));
          const programTitles =
            [...new Set(activeUsages.map((u) => u.program?.title ?? '(공고 정보 없음)'))].join(', ') || '연결된 지원건 없음';
          const owners = ownersOf(activeUsages);
          const link = activeUsages.find((u) => u.program)?.program?.sourceUrl ?? '#';
          const dday = v.expiry.daysLeft !== null ? formatDday(v.expiry.daysLeft) : '기한 미확인';
          return `• ${v.document.name} (${programTitles}) — ${dday} · 담당 ${owners} · ${link}`;
        }),
      ),
    );
  }

  if (announceOverdue.length > 0) {
    sections.push(
      section(
        '🔔 발표일 경과, 결과 확인 필요',
        announceOverdue.map((v) => {
          const title = v.program?.title ?? '(공고 정보 없음 — programId 확인 필요)';
          const link = v.program?.sourceUrl ?? '#';
          const announceDate = v.program?.announceDate;
          const dday = announceDate ? formatDday(daysUntil(announceDate, today)) : '미확인';
          return `• ${title} — 발표 ${dday} · 담당 ${v.application.owner} · ${link}`;
        }),
      ),
    );
  }

  return sections.join('\n\n');
}
