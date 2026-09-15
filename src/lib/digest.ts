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

/**
 * 다이제스트에 담을 네 가지 경고 범주를 골라 사람이 읽을 텍스트 메시지로 조립한다.
 * 네 범주 모두 비어 있으면 null을 반환한다 — "오늘은 조용합니다" 같은 알림도 보내지 않기 위함이다
 * (조용한 날까지 알림이 오면 팀이 알림 자체를 꺼버린다).
 */
export function buildDigest(
  programs: BoardInput['programs'],
  applications: BoardInput['applications'],
  documents: BoardInput['documents'],
  profile: BoardInput['profile'],
  today: Date,
): string | null {
  const board = buildBoard({ programs, applications, documents, profile, today });

  // 1) 오늘 마감 / 3일 이내 마감 — deadlineState의 'urgent' 정의(마감까지 3일 이내, 당일 포함)를 그대로 쓴다.
  const deadlineSoon: ProgramView[] = board.programs.filter((v) => v.deadline.state === 'urgent');

  // 2) 내부 마감(targetSubmitDate)이 지났는데 아직 미제출 — 가장 실질적인 경고.
  const overdueUnsubmitted: ApplicationView[] = board.applications
    .filter((v) => v.overdueUnsubmitted)
    .sort((a, b) => (a.targetDaysLeft ?? 0) - (b.targetDaysLeft ?? 0));

  // 3) 만료됐거나 14일 이내 만료되는 서류 중, 진행 중(active) 지원건에 실제로 물려 있는 것만.
  //    쓰이지 않는 서류의 만료는 소음이므로 뺀다.
  const docAlerts = board.documents.filter(
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
