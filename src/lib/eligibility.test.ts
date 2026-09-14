import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { judgeEligibility } from './eligibility.ts';
import type { EligibilityProgramInput, TeamProfile } from './eligibility.ts';

// today 헬퍼: KST 벽시계 기준 'YYYY-MM-DD HH:mm'을 UTC Date 인스턴스로 만든다.
function kst(dateStr: string, time = '12:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, 0));
}

const TODAY = kst('2026-09-14');

/** 예비창업 단계 팀: 사업자 미등록, 법인 미설립, 서울, 대표 1994년생(2026년 기준 32세). */
const preStartupTeam: TeamProfile = {
  hasBusinessRegistration: false,
  founderBirthYear: 1994,
  region: '서울',
};

const registeredTeam: TeamProfile = {
  ...preStartupTeam,
  hasBusinessRegistration: true,
  businessRegisteredAt: '2025-03-02',
};

/** 예비창업패키지형 공고: 사업자등록을 하지 않은 자만 지원 가능. */
const preStartupProgram: EligibilityProgramInput = {
  eligibility: { businessRegistration: '불가', maxFounderAge: 39 },
};

describe('judgeEligibility - 사업자등록 요건', () => {
  test('예비창업패키지형(불가) x 미등록 팀 -> eligible', () => {
    const result = judgeEligibility(preStartupProgram, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'eligible');
    assert.ok(result.reasons.length > 0);
  });

  test('예비창업패키지형(불가) x 이미 등록한 팀 -> ineligible', () => {
    const result = judgeEligibility(preStartupProgram, registeredTeam, TODAY);
    assert.equal(result.verdict, 'ineligible');
    assert.match(result.reasons[0], /사업자등록/);
  });

  test('사업자등록 필요 x 미등록 팀 -> ineligible', () => {
    const result = judgeEligibility(
      { eligibility: { businessRegistration: '필요' } },
      preStartupTeam,
      TODAY,
    );
    assert.equal(result.verdict, 'ineligible');
  });

  test('사업자등록 무관 -> 등록 여부와 무관하게 통과', () => {
    const program: EligibilityProgramInput = { eligibility: { businessRegistration: '무관' } };
    assert.equal(judgeEligibility(program, preStartupTeam, TODAY).verdict, 'eligible');
    assert.equal(judgeEligibility(program, registeredTeam, TODAY).verdict, 'eligible');
  });
});

describe('judgeEligibility - 업력(법인 설립) 요건', () => {
  const program: EligibilityProgramInput = { eligibility: { maxBusinessAgeMonths: 36 } };

  test('설립 후 개월 수 제한이 있는데 법인 미설립 -> needs-check (ineligible이 아니다)', () => {
    const result = judgeEligibility(program, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'needs-check');
    assert.match(result.reasons[0], /법인 설립일/);
  });

  test('설립 후 36개월 이내 -> eligible', () => {
    const team: TeamProfile = { ...preStartupTeam, incorporatedAt: '2024-09-14' };
    assert.equal(judgeEligibility(program, team, TODAY).verdict, 'eligible');
  });

  test('설립 후 딱 36개월이면 아직 eligible', () => {
    const team: TeamProfile = { ...preStartupTeam, incorporatedAt: '2023-09-14' };
    assert.equal(judgeEligibility(program, team, TODAY).verdict, 'eligible');
  });

  test('36개월을 하루 넘긴 경계는 월 단위 절삭으로 36개월로 보아 떨어뜨리지 않는다', () => {
    // 업력은 '개월' 단위로만 비교한다(monthsSince는 만 개월로 절삭).
    // 경계에서 하루 차이로 자동 부적격 처리하는 것보다, 사람이 보게 두는 쪽이 안전하다.
    const team: TeamProfile = { ...preStartupTeam, incorporatedAt: '2023-09-13' };
    assert.equal(judgeEligibility(program, team, TODAY).verdict, 'eligible');
  });

  test('설립 후 36개월 초과 -> ineligible', () => {
    const team: TeamProfile = { ...preStartupTeam, incorporatedAt: '2023-08-14' };
    const result = judgeEligibility(program, team, TODAY);
    assert.equal(result.verdict, 'ineligible');
    assert.match(result.reasons[0], /36개월/);
  });
});

describe('judgeEligibility - 연령 요건', () => {
  test('상한 초과 -> ineligible', () => {
    const result = judgeEligibility({ eligibility: { maxFounderAge: 29 } }, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'ineligible');
    assert.match(result.reasons[0], /29세/);
  });

  test('하한 미달 -> ineligible', () => {
    const result = judgeEligibility({ eligibility: { minFounderAge: 40 } }, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'ineligible');
  });

  test('출생연도가 없으면 판정하지 않고 needs-check', () => {
    const team: TeamProfile = { hasBusinessRegistration: false, region: '서울' };
    const result = judgeEligibility({ eligibility: { maxFounderAge: 39 } }, team, TODAY);
    assert.equal(result.verdict, 'needs-check');
    assert.match(result.reasons[0], /출생연도/);
  });
});

describe('judgeEligibility - 지역 요건', () => {
  test('제한 지역에 포함되면 eligible', () => {
    const program: EligibilityProgramInput = { eligibility: { regions: ['서울', '경기'] } };
    assert.equal(judgeEligibility(program, preStartupTeam, TODAY).verdict, 'eligible');
  });

  test('제한 지역 밖이면 ineligible', () => {
    const program: EligibilityProgramInput = { eligibility: { regions: ['경기'] } };
    const result = judgeEligibility(program, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'ineligible');
    assert.match(result.reasons[0], /지역 제한/);
  });

  test('regions가 빈 배열이면 지역 제한 없음', () => {
    const program: EligibilityProgramInput = { eligibility: { regions: [] } };
    assert.equal(judgeEligibility(program, preStartupTeam, TODAY).verdict, 'eligible');
  });
});

describe('judgeEligibility - note와 미입력 처리', () => {
  test('eligibility 자체가 없으면 needs-check', () => {
    const result = judgeEligibility({}, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'needs-check');
    assert.match(result.reasons[0], /자격요건 미입력/);
  });

  test('note만 있는 공고 -> needs-check, note 내용이 reasons에 포함된다', () => {
    const program: EligibilityProgramInput = {
      eligibility: { note: '중복지원 제한 대상인지 확인 필요' },
    };
    const result = judgeEligibility(program, preStartupTeam, TODAY);
    assert.equal(result.verdict, 'needs-check');
    assert.ok(result.reasons.some((r) => r.includes('중복지원 제한 대상인지 확인 필요')));
  });

  test('하드 필터에 걸리면 note가 있어도 ineligible이 유지된다', () => {
    const program: EligibilityProgramInput = {
      eligibility: { businessRegistration: '불가', note: '중복지원 제한 확인 필요' },
    };
    const result = judgeEligibility(program, registeredTeam, TODAY);
    assert.equal(result.verdict, 'ineligible');
    assert.ok(!result.reasons.some((r) => r.includes('중복지원')));
  });

  test('통과한 조건들 + note -> needs-check로 승격', () => {
    const program: EligibilityProgramInput = {
      eligibility: { businessRegistration: '불가', maxFounderAge: 39, note: '기수혜 여부 확인' },
    };
    assert.equal(judgeEligibility(program, preStartupTeam, TODAY).verdict, 'needs-check');
  });
});
