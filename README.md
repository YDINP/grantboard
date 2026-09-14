# GrantBoard

예비창업팀이 정부지원사업·공모전 지원 일정을 관리하는 대시보드입니다. 서버나 로그인 없이,
레포 안의 JSON 파일을 데이터로 사용하고 GitHub Pages로 배포됩니다.

> ⚠️ **이 레포는 public입니다.** `data/` 아래 JSON 파일에 대외비 내용이나 개인정보(실명,
> 연락처, 협상 금액, 내부 평가 등)를 절대 넣지 마세요. `applications.json`의 `owner`는
> 실명 대신 이니셜/닉네임만 사용하고, `note`에는 공개해도 무방한 내용만 적으세요.

## 무엇을 하는 프로젝트인가

- `data/programs.json` — 지원사업/공모전 공고 목록
- `data/applications.json` — 우리 팀의 지원 현황 (programs와 `programId`로 연결)
- `data/documents.json` — 제출서류 마스터 (사업 간 재사용 추적용)
- `data/team-profile.json` — 우리 팀 프로필 (자격요건 자동판정용, 단일 객체)

**일정 관리는 이 JSON 파일들을 직접 수정하는 방식으로 합니다.** 앞의 세 파일은 Astro Content
Layer(`src/content.config.ts`)의 zod 스키마로, `team-profile.json`은 단일 객체라 컬렉션 대신
`src/lib/teamProfile.ts`의 zod 스키마로 빌드 시점에 검증되며, 형식이 틀린 JSON을 커밋하면
빌드가 실패합니다.

### ⚠️ `data/team-profile.json` 작성 규칙

이 파일에는 **실명·주민등록번호·상세주소·연락처·계좌번호를 절대 적지 마세요.** public 레포이고,
자격요건 자동판정에 필요한 건 아래가 전부입니다.

| 필드 | 설명 |
|------|------|
| `hasBusinessRegistration` | 사업자등록 여부 (예비창업 대상 공고 판정에 필수) |
| `businessRegisteredAt` | 사업자등록일 (선택) |
| `incorporatedAt` | 법인 설립일 (선택). 없으면 미설립으로 봅니다 |
| `founderBirthYear` | 대표자 출생연도 (선택). 생년월일이 아니라 **연도만** |
| `region` | 소재지. **시도 단위까지만** (예: `"서울"`) |

### 파생 판정 로직

- `src/lib/eligibility.ts` — `judgeEligibility(program, profile)` → `eligible` / `ineligible` / `needs-check`.
  **명백한 부적격만 자동으로 걸러냅니다.** 중복지원 제한처럼 예외가 많은 규정은 공고의
  `eligibility.note`에 문장으로 적어두면 자동 판정 대신 `needs-check`로 올라옵니다.
- `src/lib/documents.ts` — `documentExpiry(doc)` → 유효기한과 만료 상태(`expired`/`expiring`/`valid`/`unknown`).
  기한은 `validUntil`이 우선이고, 없으면 `issuedAt + validityDays`로 계산합니다.
- 날짜 계산은 전부 `src/lib/schedule.ts`의 KST 헬퍼를 재사용합니다. **타임존 처리를 다른 파일에
  새로 만들지 마세요.**

## 로컬 실행

```bash
npm install
npm run dev
```

## 빌드

```bash
npm run build
```

## 테스트

```bash
node --test src/lib/*.test.ts
```

## 배포

`main` 브랜치에 푸시하면 `.github/workflows/deploy.yml`이 자동으로 빌드 후
GitHub Pages에 배포합니다.

## 스택

- [Astro](https://astro.build) 5 (`output: 'static'`)
- TypeScript (strict)
- UI 라이브러리 없음 — 순수 Astro 컴포넌트 + vanilla JS + CSS
