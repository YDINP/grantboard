/**
 * 자금 축 — "지금 노릴 수 있는 돈이 합쳐서 얼마냐"에 답한다.
 *
 * 이 파일은 날짜도 자격도 판정하지 않는다. 이미 판정이 끝난 ProgramView(board.ts)를 받는다 —
 * 마감 판정은 schedule.ts(KST 자정 기준), 자격 판정은 eligibility.ts 몫이다. 여기서 다시 짜면
 * 같은 공고가 /자금과 /임박에서 다르게 집계된다(board.ts 머리말과 같은 이유).
 *
 * 설계상 지키는 것 하나: **모르는 금액을 0으로도 추정값으로도 쓰지 않는다.**
 * amountKrw가 비어 있으면 합계에서 빼고 그 건수를 따로 보고한다(unknownAmountCount).
 * 빈칸을 0으로 더하면 합계는 조용히 과소평가되고, 추정으로 채우면 조용히 거짓이 된다.
 * 둘 다 "합쳐서 얼마"라는 질문에 대한 답으로는 쓸 수 없다.
 */

import type { Program, ProgramView } from './board.ts';

/** content.config.ts의 programs.funding 스키마에서 그대로 파생시킨다 — 유니온을 복제하지 않는다. */
export type Funding = NonNullable<Program['funding']>;
export type FundingType = Funding['type'];

/**
 * 자기부담금을 뺀 실수령 추정액(원). amountKrw가 없으면 null.
 *
 * 바우처형은 자기부담금이 0이 아니라서 공고에 적힌 금액이 그대로 들어오지 않는다.
 * selfBurdenPct가 비어 있으면 0%로 보지 않고 "자기부담 없음이 확인된 것"으로만 취급한다 —
 * 실제로 자기부담이 있는데 안 적힌 경우를 구분할 방법이 없으므로, 적는 쪽이 책임이다.
 */
export function netAmountKrw(funding: Funding | undefined): number | null {
  if (!funding || funding.amountKrw === undefined) return null;
  const burden = funding.selfBurdenPct ?? 0;
  return Math.round(funding.amountKrw * (1 - burden / 100));
}

export interface FundingBucket {
  type: FundingType;
  /** 이 성격으로 분류된 공고 수 (금액 미기입 포함). */
  count: number;
  /** 그중 amountKrw가 적혀 있어 합계에 들어간 수. */
  countedCount: number;
  /** countedCount 건만의 실수령 추정 합계(원). */
  netKrw: number;
}

export interface FundingSummary {
  /** FUNDING_TYPES 순서. 해당 공고가 0건인 성격은 빠진다. */
  buckets: FundingBucket[];
  /** 전 성격 netKrw 합계(원). */
  netKrw: number;
  /** 분류는 됐지만 금액이 비어 합계에서 빠진 공고 수. 이 값을 숨기면 합계가 과소평가로 읽힌다. */
  unknownAmountCount: number;
  /** funding 자체가 없는 공고 수 — 아직 분류되지 않은 재고다. */
  unclassifiedCount: number;
}

/**
 * 표시·집계 순서. worker/db/types.ts의 FUNDING_TYPES와 값이 같아야 한다.
 * 그쪽을 import하지 않는 이유: src/lib은 Worker에 의존하지 않는다(Astro 빌드도 이 파일을 쓴다).
 */
const TYPE_ORDER: readonly FundingType[] = ['상금', '크레딧', '사업화자금', '지분투자', '융자'];

/**
 * 집계 대상 고르기 — "마감이 지나지 않았고 자격에 명백히 걸리지도 않은" 공고.
 *
 * 'needs-check'를 빼지 않는 이유: 자동판정이 못 가린 조건(중복지원 제한 등)은 사람이 보고
 * 판단할 몫이고, 여기서 떨어뜨리면 합계가 실제보다 작게 나와 "노릴 게 없다"는 잘못된 결론으로 간다.
 * 반대로 'ineligible'은 하드 필터에 걸린 것이라 합계에 넣으면 없는 돈을 세는 셈이다.
 */
export function reachableViews(views: readonly ProgramView[]): ProgramView[] {
  return views.filter((v) => v.deadline.state !== 'closed' && v.eligibility.verdict !== 'ineligible');
}

export function summarizeFunding(views: readonly ProgramView[]): FundingSummary {
  const byType = new Map<FundingType, FundingBucket>();
  let unknownAmountCount = 0;
  let unclassifiedCount = 0;

  for (const view of views) {
    const funding = view.program.funding;
    if (!funding) {
      unclassifiedCount += 1;
      continue;
    }

    const bucket = byType.get(funding.type) ?? { type: funding.type, count: 0, countedCount: 0, netKrw: 0 };
    bucket.count += 1;

    const net = netAmountKrw(funding);
    if (net === null) {
      unknownAmountCount += 1;
    } else {
      bucket.countedCount += 1;
      bucket.netKrw += net;
    }
    byType.set(funding.type, bucket);
  }

  const buckets = TYPE_ORDER.map((type) => byType.get(type)).filter((b): b is FundingBucket => b !== undefined);
  return {
    buckets,
    netKrw: buckets.reduce((sum, b) => sum + b.netKrw, 0),
    unknownAmountCount,
    unclassifiedCount,
  };
}

/** "3,000만원" 꼴. 만원 미만은 버린다 — 공고 금액은 만원 단위로만 쓰이고 원 단위는 노이즈다. */
export function formatKrw(amount: number): string {
  if (amount === 0) return '0원';
  const man = Math.floor(amount / 10_000);
  if (man === 0) return `${amount.toLocaleString('ko-KR')}원`;
  if (man < 10_000) return `${man.toLocaleString('ko-KR')}만원`;
  const eok = Math.floor(man / 10_000);
  const rest = man % 10_000;
  return rest === 0 ? `${eok}억원` : `${eok}억 ${rest.toLocaleString('ko-KR')}만원`;
}
