import { defineCollection } from 'astro:content';
import { file } from 'astro/loaders';
import { z } from 'astro/zod';

// 지원사업/공모전 공고
const programs = defineCollection({
  loader: file('data/programs.json'),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    organizer: z.string(),
    sourceUrl: z.string(),
    category: z.enum(['정부지원사업', '공모전', '경진대회', '교육프로그램', '기타']),
    applyStart: z.string().date().optional(),
    applyEnd: z.string().date(),
    // 마감 시각. 없으면 화면에 "시각 미확인"으로 표시할 것.
    applyEndTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    announceDate: z.string().date().optional(),
    supportAmount: z.string().optional(),
    tags: z.array(z.string()).default([]),
    // 자동수집분 구분용. 기본은 수동 입력.
    source: z.enum(['manual', 'k-startup', 'bizinfo']).default('manual'),
    collectedAt: z.string().datetime().optional(),
    // 자격요건. 자동판정(eligibility.ts)이 쓰는 하드 필터만 구조화하고,
    // 예외가 많아 기계가 판단할 수 없는 조건은 전부 note로 보낸다.
    eligibility: z
      .object({
        // '불가' = 사업자등록을 하지 않은 자만 지원 가능(예비창업패키지형).
        // '필요' = 사업자등록이 있어야 지원 가능. '무관' = 조건 없음.
        businessRegistration: z.enum(['불가', '필요', '무관']).optional(),
        // 법인 설립일로부터의 개월 수 상한 (예: 초기창업패키지 "설립 후 3년 이내" -> 36).
        maxBusinessAgeMonths: z.number().int().positive().optional(),
        minFounderAge: z.number().int().nonnegative().optional(),
        maxFounderAge: z.number().int().nonnegative().optional(),
        // 지역 제한. 없거나 빈 배열이면 제한 없음.
        regions: z.array(z.string()).optional(),
        // 자동판정이 불가능한 조건(중복지원 제한 등)을 사람이 읽을 문장으로.
        // 이 값이 있으면 판정은 'needs-check'로 승격된다 — 기계가 임의로 떨어뜨리지 않는다.
        note: z.string().optional(),
      })
      .optional(),
  }),
});

// 우리 팀의 지원 현황. programs와 1:N (programId로 연결)
const applications = defineCollection({
  loader: file('data/applications.json'),
  schema: z.object({
    id: z.string(),
    programId: z.string(),
    status: z.enum([
      '검토중',
      '준비',
      '작성중',
      '제출완료',
      '서류통과',
      '최종선정',
      '탈락',
      '미지원',
    ]),
    // 담당자 표기. 이 레포는 public이다 — 실명 금지, 이니셜이나 닉네임만 쓸 것.
    owner: z.string(),
    priority: z.enum(['high', 'mid', 'low']).default('mid'),
    // 팀 내부 마감일. 마감 당일 접속 폭주/전산오류로 제출이 실패하는 사례가 흔해
    // 실제 마감(applyEnd)보다 1~2일 앞당겨 잡는다.
    targetSubmitDate: z.string().date().optional(),
    submittedAt: z.string().date().optional(),
    resultAt: z.string().date().optional(),
    documentIds: z.array(z.string()).default([]),
    // 이 레포는 public이다. 대외비 내용(금액 협상, 내부 평가 등)을 여기 쓰지 말 것.
    note: z.string().optional(),
  }),
});

// 제출서류 마스터. 사업 간 재사용 추적용.
const documents = defineCollection({
  loader: file('data/documents.json'),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['서식', '증빙', '기타']),
    reusable: z.boolean().default(true),
    // 발급일. validityDays와 함께 유효기한을 계산한다(documents.ts).
    issuedAt: z.string().date().optional(),
    // 발급일 기준 유효일수 (예: 사업자등록증명원 90).
    validityDays: z.number().int().positive().optional(),
    // 증빙서류 유효기간. issuedAt+validityDays보다 우선하는 명시적 override.
    validUntil: z.string().date().optional(),
    // 어느 사업 제출본을 기반으로 만들었는지 한 줄. PSST 구조라 사업계획서는 상당 부분 재사용된다.
    reuseSource: z.string().optional(),
    ready: z.boolean().default(false),
  }),
});

export const collections = { programs, applications, documents };
