/**
 * 우리 팀 프로필. 단일 객체이므로 Content Layer 컬렉션(file() 로더는 배열/레코드를 전제)으로 만들지 않고
 * 여기서 zod로 파싱한다. 파싱은 모듈 로드 시점에 한 번 일어나므로 형식이 틀리면 빌드가 실패한다.
 *
 * ⚠️ 이 레포는 public이다. data/team-profile.json에 실명·주민등록번호·상세주소·연락처를 넣지 말 것.
 * 자격요건 자동판정에 필요한 최소 정보만 둔다.
 */

import { z } from 'astro/zod';
import raw from '../../data/team-profile.json';

// 17개 광역시도로 값 자체를 제한한다 — "시도 단위까지만"이라는 규칙을 주석이 아니라 스키마로
// 강제한다. z.enum이므로 상세주소("서울시 강남구 ...")가 들어오면 빌드가 실패한다.
const REGIONS = [
  '서울',
  '부산',
  '대구',
  '인천',
  '광주',
  '대전',
  '울산',
  '세종',
  '경기',
  '강원',
  '충북',
  '충남',
  '전북',
  '전남',
  '경북',
  '경남',
  '제주',
] as const;

const teamProfileSchema = z.object({
  hasBusinessRegistration: z.boolean(),
  businessRegisteredAt: z.string().date().optional(),
  // 법인 설립일. 없으면 미설립(예비창업 단계)으로 본다.
  incorporatedAt: z.string().date().optional(),
  founderBirthYear: z.number().int().optional(),
  // 시도 단위까지만. 상세주소 금지.
  region: z.enum(REGIONS),
});

export type TeamProfileData = z.infer<typeof teamProfileSchema>;

// JSON의 설명용 _comment 키는 zod가 알아서 버린다.
export const teamProfile: TeamProfileData = teamProfileSchema.parse(raw);
