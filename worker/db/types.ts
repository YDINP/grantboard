/**
 * Worker 쪽 도메인 타입.
 *
 * 정본은 src/content.config.ts의 zod 스키마다. 이 파일은 그 스키마에서 추론되는 타입과
 * **구조가 동일해야 한다** — src/lib/*(board/eligibility/documents/digest/filters)는
 * 이 형태를 전제로 짜여 있고, 그 테스트 134개가 계약서 역할을 한다.
 *
 * Astro의 CollectionEntry<'programs'>['data']를 그대로 쓰지 않는 이유:
 * 그 타입은 'astro:content' 가상 모듈에 묶여 있어 Worker 번들에서는 해석되지 않는다.
 * 대신 같은 형태를 여기 손으로 적고, zod 스키마가 바뀌면 이 파일도 같이 고친다.
 *
 * optional 필드는 DB의 NULL에 대응한다. repo 계층은 NULL을 `undefined`로 바꿔서 넘긴다 —
 * zod의 .optional()이 만드는 형태가 `undefined`이고, src/lib은 `?? / === undefined`로 분기하기 때문이다.
 */

export type ProgramCategory = '정부지원사업' | '공모전' | '경진대회' | '교육프로그램' | '기타';
export type ProgramSource = 'manual' | 'k-startup' | 'bizinfo';

/** 자동판정(eligibility.ts)이 쓰는 하드 필터. 기계가 판단 못 하는 조건은 전부 note로 간다. */
export interface ProgramEligibility {
  /** '불가' = 사업자등록 미보유자만 지원 가능. '필요' = 있어야 함. '무관' = 조건 없음. */
  businessRegistration?: '불가' | '필요' | '무관';
  maxBusinessAgeMonths?: number;
  minFounderAge?: number;
  maxFounderAge?: number;
  regions?: string[];
  /** 이 값이 있으면 판정은 'needs-check'로 승격된다 — 기계가 임의로 떨어뜨리지 않는다. */
  note?: string;
}

export interface Program {
  id: string;
  title: string;
  organizer: string;
  sourceUrl: string;
  category: ProgramCategory;
  applyStart?: string;
  applyEnd: string;
  /** 'HH:MM'. 없으면 화면에 "시각 미확인"으로 표시한다. */
  applyEndTime?: string;
  announceDate?: string;
  supportAmount?: string;
  tags: string[];
  source: ProgramSource;
  collectedAt?: string;
  /** manual 행 전용. 자동수집이 다른 명칭으로 같은 공고를 가져왔을 때 매칭시키는 별칭. */
  aliasTitles: string[];
  eligibility?: ProgramEligibility;
}

export type ApplicationStatus =
  | '검토중'
  | '준비'
  | '작성중'
  | '제출완료'
  | '서류통과'
  | '최종선정'
  | '탈락'
  | '미지원';

export type ApplicationPriority = 'high' | 'mid' | 'low';

export interface Application {
  id: string;
  programId: string;
  status: ApplicationStatus;
  /** 최대 4자. public 레포이므로 실명 금지 — 이니셜/닉네임만. */
  owner: string;
  priority: ApplicationPriority;
  /** 팀 내부 마감일. 실제 마감(applyEnd)보다 1~2일 앞당겨 잡는다. */
  targetSubmitDate?: string;
  submittedAt?: string;
  resultAt?: string;
  documentIds: string[];
  note?: string;
}

export type DocumentKind = '서식' | '증빙' | '기타';

export interface Document {
  id: string;
  name: string;
  kind: DocumentKind;
  reusable: boolean;
  issuedAt?: string;
  /** 발급일 기준 유효일수 (예: 사업자등록증명원 90). */
  validityDays?: number;
  /** issuedAt+validityDays보다 우선하는 명시적 override. */
  validUntil?: string;
  reuseSource?: string;
  ready: boolean;
}

/** 17개 광역시도. 상세주소 금지를 타입으로 강제한다(team_profile 테이블의 CHECK와 동일 집합). */
export const REGIONS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
] as const;

export type Region = (typeof REGIONS)[number];

export interface TeamProfile {
  hasBusinessRegistration: boolean;
  businessRegisteredAt?: string;
  /** 없으면 미설립(예비창업 단계)으로 본다. */
  incorporatedAt?: string;
  founderBirthYear?: number;
  region: Region;
}

/** loadAll의 반환 형태. src/lib/board.ts의 BoardInput에 `today`만 더하면 그대로 들어간다. */
export interface BoardData {
  programs: Program[];
  applications: Application[];
  documents: Document[];
  profile: TeamProfile;
}

/** 디스코드 계정 ↔ 담당자 이니셜 매핑 (migrations/0002_owner_map.sql). */
export interface OwnerMapping {
  discordUserId: string;
  owner: string;
}
