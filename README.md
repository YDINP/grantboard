# GrantBoard

예비창업팀이 정부지원사업·공모전 지원 일정을 관리하는 대시보드입니다. 서버나 로그인 없이,
레포 안의 JSON 파일을 데이터로 사용하고 GitHub Pages로 배포됩니다.

> ⚠️ **이 레포는 public입니다.** `data/` 아래 JSON 파일에 대외비 내용이나 개인정보(실명,
> 연락처, 협상 금액, 내부 평가 등)를 절대 넣지 마세요. `applications.json`의 `owner`는
> 실명 대신 이니셜/닉네임만 사용하고, `note`에는 공개해도 무방한 내용만 적으세요.
> `owner`는 스키마에서 4자 이하로 제한됩니다(`"홍길동 대표"` 같은 실명 표기를 막기 위함 — 완벽한
> 차단은 아니지만 경고 주석보다는 낫습니다).

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
| `region` | 소재지. **17개 광역시도 중 하나**만 허용됩니다(`z.enum`) — 상세주소는 스키마 단계에서 차단됩니다 |

### 파생 판정 로직

- `src/lib/eligibility.ts` — `judgeEligibility(program, profile)` → `eligible` / `ineligible` / `needs-check`.
  **명백한 부적격만 자동으로 걸러냅니다.** 중복지원 제한처럼 예외가 많은 규정은 공고의
  `eligibility.note`에 문장으로 적어두면 자동 판정 대신 `needs-check`로 올라옵니다.
  업력(설립 후 개월수) 계산은 `incorporatedAt`(법인 설립일)을 우선 쓰고, 없으면
  `businessRegisteredAt`(개인사업자 등록일)으로 대체합니다 — 법인 전환 전 개인사업자로
  시작한 팀이 항상 `needs-check`로 빠지는 걸 막기 위함입니다.
- `src/lib/documents.ts` — `documentExpiry(doc)` → 유효기한과 만료 상태(`expired`/`expiring`/`valid`/`unknown`).
  기한은 `validUntil`이 우선이고, 없으면 `issuedAt + validityDays`로 계산합니다.
- 날짜 계산은 전부 `src/lib/schedule.ts`의 KST 헬퍼를 재사용합니다. **타임존 처리를 다른 파일에
  새로 만들지 마세요.**

## 자동 수집 (K-Startup)

`data/programs.json`의 `source: 'k-startup'` 항목은 GitHub Actions가 매일 공공데이터포털의
K-Startup Open API를 호출해 자동으로 채웁니다(`.github/workflows/collect.yml`).
**`source: 'manual'` 항목은 자동수집이 절대 덮어쓰거나 삭제하지 않습니다.**

- `src/lib/collect.ts` — 순수 함수(`normalizeAnnouncement`, `mergePrograms`). 네트워크 접근 없음.
- `scripts/collect.mjs` — 실제 API 호출 + 파일 쓰기. 네트워크 코드는 여기에만 있습니다.

수집 건수가 0건이거나 기존 대비 급감하면(50% 미만) `scripts/collect.mjs`가 stdout에 `⚠️ 경고`를
남깁니다. GitHub Actions 로그에서 이 경고를 보면 API 파라미터나 엔드포인트 규격이 바뀌었는지
의심하세요. 이 경고는 파일을 지우거나 실행을 실패시키지 않습니다 — 기존 데이터는 그대로 남습니다.

### 수동 입력 공고와 중복되지 않게 하기 (`aliasTitles`)

자동수집은 공고명이 **정확히 같을 때만** 기존 항목과 매칭합니다. 팀이 손으로 먼저 입력해둔
공고(예: `"예비창업패키지"`)를 K-Startup이 다른 공식 명칭(예: `"2026년 예비창업패키지 예비창업자
모집 공고"`)으로 가져오면, 제목이 달라 별개 공고로 보고 **중복으로 추가**됩니다.

이걸 막으려면 manual 행에 `aliasTitles`를 적어두세요. 자동수집 공고명이 이 목록 중 하나와
일치하면 신규 추가 대신 그 manual 행으로 매칭되어 스킵됩니다(manual 값은 여전히 덮어쓰지
않습니다). 마감일이 달라도 매칭됩니다 — alias는 사람이 직접 지정한 확실한 매칭이기 때문입니다.

```json
{
  "id": "pre-startup-2026",
  "title": "예비창업패키지",
  "aliasTitles": ["2026년 예비창업패키지 예비창업자 모집 공고"],
  "source": "manual",
  ...
}
```

매칭이 일어나면 `scripts/collect.mjs` 실행 로그에 어떤 자동수집 제목이 어떤 manual 행의
별칭으로 처리됐는지 남습니다.

### 서비스키 발급

1. [data.go.kr](https://www.data.go.kr)에 로그인 → 데이터셋 **"K-Startup 사업공고정보"(15125364)**
   검색 → **활용신청**.
2. 승인 후 마이페이지 > 오픈API > 활용신청 현황에서 **서비스키(디코딩 인증키)** 확인.
3. ⚠️ **이 키를 코드, 커밋, 이슈, PR에 절대 넣지 마세요.** 이 레포는 public입니다.

### GitHub Secrets 등록

레포 **Settings → Secrets and variables → Actions → New repository secret**에서
이름 `DATA_GO_KR_KEY`, 값에 발급받은 서비스키를 등록하세요. 워크플로우는 이 시크릿만 읽고,
로그에 키가 찍히지 않도록 마스킹합니다.

### 로컬에서 dry-run

```bash
DATA_GO_KR_KEY=발급받은키 node scripts/collect.mjs --dry-run
```

`--dry-run`은 API를 호출하고 결과를 요약만 출력할 뿐 `data/programs.json`을 쓰지 않습니다.
`DATA_GO_KR_KEY`가 없으면 조용히 넘어가지 않고 바로 에러로 종료합니다:

```bash
node scripts/collect.mjs --dry-run
# [collect] 오류: DATA_GO_KR_KEY 환경변수가 설정되지 않았습니다. ...
```

실제로 파일을 갱신하려면 `--dry-run`을 빼고 실행하세요.

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

### 매일 재빌드하는 이유

정적 사이트라 D-day·마감상태(`urgent`/`soon`/`open`)·서류 만료 판정이 전부 **빌드 시점**
값으로 HTML에 고정됩니다. `collect.yml`은 신규 공고가 없는 날엔 커밋을 하지 않으므로, 재배포가
없으면 그날 D-day가 하루씩 낡습니다. 그래서 `deploy.yml`은 하루 **두 번**(KST 00:00, KST 09:00 —
`collect.yml`의 KST 08:00 수집 1시간 뒤) 스케줄을 걸어 내용 변경 여부와 무관하게 강제로
재빌드·재배포합니다. KST 00:00 실행분은 자정 직후 D-day가 하루 밀린 채로 하루 종일 표시되는
것을 막기 위한 것으로, 09:00 실행분(자동수집 직후 최신 공고 반영)과는 목적이 다릅니다.

> ⚠️ GitHub는 **60일간 커밋이 없는 레포의 스케줄 워크플로우를 자동으로 비활성화**합니다. 이
> 레포가 오래 방치되면 이 매일 재빌드가 조용히 멈추고 D-day가 다시 낡기 시작합니다. 주기적으로
> `workflow_dispatch`로 수동 실행하거나 커밋을 해서 활성 상태를 유지하세요.

## 스택

- [Astro](https://astro.build) 5 (`output: 'static'`)
- TypeScript (strict)
- UI 라이브러리 없음 — 순수 Astro 컴포넌트 + vanilla JS + CSS
