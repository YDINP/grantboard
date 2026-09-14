/**
 * 자격요건 자동판정 순수 함수. 부수효과 없음.
 *
 * 설계 원칙: **명백한 부적격(하드 필터)만 자동으로 떨어뜨린다.**
 * 공고의 실제 자격요건은 예외 조항이 많아서, 애매한 경우를 기계가 'ineligible'로 판정하면
 * 지원 가능한 사업을 놓치게 된다. 판단이 서지 않으면 항상 'needs-check'로 보내 사람이 확인하게 한다.
 */

import { monthsSince, kstDateParts } from './schedule.ts';

/** programs 스키마의 eligibility 객체와 호환되는 최소 타입. */
export interface ProgramEligibility {
  businessRegistration?: '불가' | '필요' | '무관';
  maxBusinessAgeMonths?: number;
  minFounderAge?: number;
  maxFounderAge?: number;
  regions?: string[];
  note?: string;
}

/** judgeEligibility가 필요로 하는 공고 필드만 담은 타입. */
export interface EligibilityProgramInput {
  eligibility?: ProgramEligibility;
}

/** data/team-profile.json과 호환되는 최소 타입. */
export interface TeamProfile {
  hasBusinessRegistration: boolean;
  businessRegisteredAt?: string;
  incorporatedAt?: string;
  founderBirthYear?: number;
  region: string;
}

export type EligibilityVerdict = 'eligible' | 'ineligible' | 'needs-check';

export interface EligibilityResult {
  verdict: EligibilityVerdict;
  /** 왜 그렇게 판정했는지 사람이 바로 읽을 수 있는 한국어 문장. */
  reasons: string[];
}

/**
 * 출생연도만으로 계산하는 '연 나이'(올해 - 출생연도).
 * 프로필에 생일이 없으므로 만 나이는 계산할 수 없다. 청년창업 공고 상당수가 출생연도 기준으로
 * 대상을 공고하기 때문에 이 근사를 쓰되, 경계선(상한 ±1세)은 어차피 note/needs-check로 걸러야 한다.
 */
function birthYearToAge(birthYear: number, today: Date): number {
  return kstDateParts(today).year - birthYear;
}

/**
 * 공고의 자격요건과 팀 프로필을 대조해 지원 가능 여부를 판정한다.
 * - 하드 필터에 하나라도 걸리면 'ineligible' (그 사유들만 reasons에 담는다)
 * - 걸리지 않았지만 확인이 필요한 항목이 있으면 'needs-check'
 * - 둘 다 없으면 'eligible'
 */
export function judgeEligibility(
  program: EligibilityProgramInput,
  profile: TeamProfile,
  today: Date = new Date(),
): EligibilityResult {
  const rules = program.eligibility;
  if (!rules) {
    return {
      verdict: 'needs-check',
      reasons: ['자격요건 미입력 — 공고문을 보고 eligibility를 채워야 판정할 수 있습니다.'],
    };
  }

  // 부적격 사유(하드 필터)와 확인 필요 사유를 따로 모은다. 하드 필터가 하나라도 있으면 그것이 결론이다.
  const blockers: string[] = [];
  const checks: string[] = [];

  if (rules.businessRegistration === '불가' && profile.hasBusinessRegistration) {
    blockers.push('사업자등록을 하지 않은 자만 지원할 수 있는 공고인데, 우리 팀은 이미 사업자등록을 마쳤습니다.');
  }
  if (rules.businessRegistration === '필요' && !profile.hasBusinessRegistration) {
    blockers.push('사업자등록이 있어야 지원할 수 있는 공고인데, 우리 팀은 아직 사업자등록을 하지 않았습니다.');
  }

  if (rules.maxBusinessAgeMonths !== undefined) {
    if (!profile.incorporatedAt) {
      // 미설립이 '자격 충족'인지 '요건 미달'인지는 공고마다 다르다. 임의로 판정하지 않는다.
      checks.push(
        `법인 설립 후 ${rules.maxBusinessAgeMonths}개월 이내 조건이 있으나 팀 프로필에 법인 설립일이 없습니다. 미설립 상태가 지원 대상인지 공고문에서 확인하세요.`,
      );
    } else {
      const age = monthsSince(profile.incorporatedAt, today);
      if (age > rules.maxBusinessAgeMonths) {
        blockers.push(
          `법인 설립 후 ${rules.maxBusinessAgeMonths}개월 이내만 지원 가능한데, 설립일(${profile.incorporatedAt}) 기준 ${age}개월이 지났습니다.`,
        );
      }
    }
  }

  const hasAgeRule = rules.minFounderAge !== undefined || rules.maxFounderAge !== undefined;
  if (hasAgeRule) {
    if (profile.founderBirthYear === undefined) {
      checks.push('연령 제한이 있는 공고이나 팀 프로필에 대표자 출생연도가 없어 판정할 수 없습니다.');
    } else {
      const age = birthYearToAge(profile.founderBirthYear, today);
      if (rules.minFounderAge !== undefined && age < rules.minFounderAge) {
        blockers.push(`대표자 연령 ${rules.minFounderAge}세 이상 조건에 미달합니다(현재 ${age}세).`);
      }
      if (rules.maxFounderAge !== undefined && age > rules.maxFounderAge) {
        blockers.push(`대표자 연령 ${rules.maxFounderAge}세 이하 조건을 초과합니다(현재 ${age}세).`);
      }
    }
  }

  if (rules.regions && rules.regions.length > 0 && !rules.regions.includes(profile.region)) {
    blockers.push(
      `지역 제한(${rules.regions.join(', ')})에 해당하지 않습니다. 우리 팀 소재지는 ${profile.region}입니다.`,
    );
  }

  if (blockers.length > 0) {
    return { verdict: 'ineligible', reasons: blockers };
  }

  if (rules.note) {
    // 자동판정이 불가능한 조건이 달린 공고는 '적격'으로 단정하지 않는다.
    checks.push(`사람이 확인해야 하는 조건이 있습니다: ${rules.note}`);
  }

  if (checks.length > 0) {
    return { verdict: 'needs-check', reasons: checks };
  }

  return {
    verdict: 'eligible',
    reasons: ['입력된 자격요건(사업자등록·업력·연령·지역)에서 부적격 사유가 발견되지 않았습니다.'],
  };
}
