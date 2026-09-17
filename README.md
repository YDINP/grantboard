# GrantBoard

예비창업팀이 정부지원사업·공모전 지원 일정을 관리하는 디스코드 봇 + 달력 페이지입니다.
Cloudflare Workers 위에서 돌아가고, 데이터는 Cloudflare D1에 저장됩니다.

> ⚠️ **이 레포는 public입니다.** `data/` 아래 JSON 파일에 대외비 내용이나 개인정보(실명,
> 연락처, 협상 금액, 내부 평가 등)를 절대 넣지 마세요. `applications.json`의 `owner`는
> 실명 대신 이니셜/닉네임만 사용하고, `note`에는 공개해도 무방한 내용만 적으세요.
> `owner`는 스키마에서 4자 이하로 제한됩니다(`"홍길동 대표"` 같은 실명 표기를 막기 위함 — 완벽한
> 차단은 아니지만 경고 주석보다는 낫습니다).

## 무엇을 하는 프로젝트인가

- **디스코드 봇** — `/일정` `/임박` `/내마감` `/현황` `/달력` `/공고 추가|목록|삭제`
  `/상태 변경` `/서류 목록|추가|완료|연결` `/나는`, 총 9개 커맨드로 일정을 조회·입력합니다.
- **달력 웹페이지** — 봇의 `/달력`이 링크로 안내하는 `https://grantboard.benclaude-toss.workers.dev`
  (또는 `/calendar`). 같은 Worker가 요청 시점에 D1을 읽어 렌더링합니다.
- **자동 수집** — 매일 아침 K-Startup·기업마당 공고를 크론으로 긁어옵니다.
- **D-day 다이제스트** — 매일 아침 봇이 채널에 요약을 올립니다.

데이터 정본은 **Cloudflare D1**(`grantboard`)입니다. `data/*.json`은 초기 시드 원본으로만
남아 있고, 런타임에는 읽지 않습니다.

- `data/programs.json` — 지원사업/공모전 공고 목록 (시드)
- `data/applications.json` — 우리 팀의 지원 현황, programs와 `programId`로 연결 (시드)
- `data/documents.json` — 제출서류 마스터, 사업 간 재사용 추적용 (시드)
- `data/team-profile.json` — 우리 팀 프로필, 자격요건 자동판정용 단일 객체 (시드)

이 네 파일은 `src/content.config.ts`의 zod 스키마(`team-profile.json`만 `src/lib/teamProfile.ts`)로
검증되며, 형식이 틀린 JSON을 커밋하면 `npm run build`(타입체크)가 실패합니다. D1 스키마
(`migrations/0001~0003`)는 이 zod 스키마와 필드가 1:1로 대응합니다 — 컬럼명만
camelCase → snake_case로 바뀌었을 뿐입니다.

**일정을 바꿀 땐 디스코드 커맨드로 D1에 직접 씁니다.** `data/*.json`을 고치는 건 "처음 시드를
채우거나 다시 채울 때"뿐이고, 그 경우에도 `node scripts/seed-d1.mjs`로 D1에 반영해야 실제
데이터에 반영됩니다 — JSON을 고치는 것만으로는 봇이나 달력 페이지에 아무 변화가 없습니다.

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
  새로 만들지 마세요.** D1은 SQLite라 날짜 함수가 UTC 기준이므로, `worker/db/`는 날짜를
  TEXT로만 저장·전달하고 판정은 전부 이 헬퍼에 맡깁니다.

## 자동 수집 (K-Startup + 기업마당)

`worker/cron/collect.ts`가 매일 **KST 08:00**에 공공데이터포털의 K-Startup Open API와
기업마당(bizinfo.go.kr) Open API를 호출해 D1의 `programs` 테이블을 채웁니다(`wrangler.toml`의
`[triggers]`). **`source: 'manual'` 행은 자동수집이 절대 덮어쓰거나 삭제하지 않습니다.**

기업마당은 K-Startup에 없는 지자체·타부처 공고를 보강하는 **2차 소스**입니다.
`BIZINFO_CRTFC_KEY`가 설정되지 않은 환경에서는 기업마당 수집만 건너뛰고 K-Startup 수집은
정상 진행합니다 — 크론이 실패하지 않습니다.

- `src/lib/collect.ts` — 순수 함수(`normalizeAnnouncement`, `mergePrograms`). 네트워크 접근 없음.
- `worker/cron/collectSources.ts` — 실제 API 호출. 네트워크 코드는 여기에만 있습니다.
- `worker/cron/collect.ts` — D1 읽기/쓰기 + 소스별 실패 격리. `mergePrograms`로 병합한 뒤
  `source !== 'manual'`인 행만 upsert합니다.
- `scripts/collect.mjs` — 같은 네트워크·병합 로직을 `data/programs.json`(시드 파일) 대상으로
  돌리는 로컬 도구입니다. D1을 건드리지 않으므로 API 응답을 미리 확인하거나 시드를 새로
  채울 때 씁니다. D1에 반영하려면 이후 `node scripts/seed-d1.mjs`를 따로 돌려야 합니다.

수집 건수가 0건이거나 기존 대비 급감하면(50% 미만) 병합 로직이 경고를 로그로 남깁니다.
`npx wrangler tail`로 이 경고를 보면 API 파라미터나 엔드포인트 규격이 바뀌었는지 의심하세요.
이 경고는 D1을 건드리거나 크론을 실패시키지 않습니다 — 기존 데이터는 그대로 남습니다.

### 수동 입력 공고와 중복되지 않게 하기 (`aliasTitles`)

자동수집은 공고명이 **정확히 같을 때만** 기존 항목과 매칭합니다. 팀이 손으로 먼저 입력해둔
공고(예: `"예비창업패키지"`)를 K-Startup이 다른 공식 명칭(예: `"2026년 예비창업패키지 예비창업자
모집 공고"`)으로 가져오면, 제목이 달라 별개 공고로 보고 **중복으로 추가**됩니다.

이걸 막으려면 manual 행에 `aliasTitles`를 적어두세요(`/공고 추가`로 등록하거나 시드 JSON에
직접 적어둘 수 있습니다). 자동수집 공고명이 이 목록 중 하나와 일치하면 신규 추가 대신 그
manual 행으로 매칭되어 스킵됩니다(manual 값은 여전히 덮어쓰지 않습니다). 마감일이 달라도
매칭됩니다 — alias는 사람이 직접 지정한 확실한 매칭이기 때문입니다.

```json
{
  "id": "pre-startup-2026",
  "title": "예비창업패키지",
  "aliasTitles": ["2026년 예비창업패키지 예비창업자 모집 공고"],
  "source": "manual",
  ...
}
```

매칭이 일어나면 `worker/cron/collect.ts` 실행 로그(`wrangler tail`)에 어떤 자동수집 제목이
어떤 manual 행의 별칭으로 처리됐는지 남습니다.

### 두 소스에서 같은 공고가 올 때 (중복 제거)

K-Startup과 기업마당이 같은 공고를 조금 다른 표기로 줄 수 있습니다. 병합은 4단계로 시도합니다.

1. 공고명 + 마감일이 완전히 같으면 1건으로 합칩니다.
2. manual 행의 `aliasTitles`와 일치하면 그 manual 행으로 매칭됩니다.
3. 공고명이 정확히 같은 자동수집 항목이 **정확히 1건**이면 마감일이 바뀐 것으로 보고 갱신합니다.
4. 위 셋 다 아니면, 제목에서 **선행 연도(`"2026년 "`)와 괄호 안이 순수 연도인 표기(`"(2026)"`)만**
   제거한 정규화 제목으로 다시 비교해, 일치하는 자동수집 항목이 정확히 1건이면 갱신합니다.

이 정규화는 **의도적으로 보수적**입니다. 지역·회차 등 괄호 안 내용은 지우지 않으므로
`"OO사업(서울)"`과 `"OO사업(경기)"`는 별개 공고로 남습니다. 정규화 후에도 후보가 2건 이상이면
(모호하면) 병합하지 않고 신규로 추가합니다 — **다른 공고를 잘못 합쳐 한쪽 마감일이 사라지는
것보다, 중복이 남는 쪽이 안전하기 때문입니다.**

### 서비스키 발급

1. [data.go.kr](https://www.data.go.kr)에 로그인 → 데이터셋 **"K-Startup 사업공고정보"(15125364)**
   검색 → **활용신청**.
2. 승인 후 마이페이지 > 오픈API > 활용신청 현황에서 **서비스키(디코딩 인증키)** 확인.
3. ⚠️ **이 키를 코드, 커밋, 이슈, PR에 절대 넣지 마세요.** 이 레포는 public입니다.

기업마당(2차 소스)은 [bizinfo.go.kr](https://www.bizinfo.go.kr/apiList.do) 회원가입 후
지원사업정보 API 크리덴셜(`crtfcKey`)을 발급받습니다.
⚠️ 기업마당의 정확한 발급 절차·응답 필드 키명·일일 호출 한도는 아직 실호출로 확인하지
못했습니다. `worker/cron/collectSources.ts`의 `⚠️ 미확인` 주석을 참고해 키 발급 후 검증하고
고치세요.

### 로컬에서 dry-run

```bash
DATA_GO_KR_KEY=키 node scripts/collect.mjs --dry-run          # 전체(기본 --source=all)
DATA_GO_KR_KEY=키 BIZINFO_CRTFC_KEY=키 node scripts/collect.mjs
node scripts/collect.mjs --source=kstartup                    # kstartup | bizinfo | all
```

`--dry-run`은 API를 호출하고 결과를 요약만 출력할 뿐 `data/programs.json`을 쓰지 않습니다.
`DATA_GO_KR_KEY`가 없으면 조용히 넘어가지 않고 바로 에러로 종료합니다. 이 스크립트는
`data/programs.json`만 갱신하므로, D1(실데이터)까지 반영하려면 `node scripts/seed-d1.mjs`를
이어서 돌려야 합니다.

## 디스코드 봇

- `worker/discord/interactions.ts` — 커맨드 이름으로 라우팅.
- `worker/discord/commands.ts` — 슬래시 커맨드 정의(한 곳에 모아둠). 등록은
  `node scripts/register-commands.mjs`가 이 배열을 그대로 디스코드에 PUT합니다.
- `worker/discord/verify.ts` — Ed25519 서명 검증. `/interactions` 요청이 진짜 디스코드에서
  왔는지 확인하고, 실패하면 401을 돌려줍니다.

### 커맨드 등록

```bash
DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
node scripts/register-commands.mjs --dry-run   # 전송하지 않고 등록될 커맨드 이름만 출력
```

길드 커맨드로 등록합니다(글로벌 커맨드는 반영까지 최대 1시간 걸리므로). 등록은 배포와 별개
단계입니다 — 커맨드 정의(`commands.ts`)를 바꿨을 때만 다시 실행하면 됩니다.

디스코드 개발자 포털의 **Interactions Endpoint URL**은 `https://grantboard.benclaude-toss.workers.dev/interactions`
로 설정합니다. 이 URL에 GET/HEAD로 접근하면 404, POST 이외 메서드는 405를 돌려줍니다.

### 서류함

서류 실물(PDF 등)은 디스코드의 `#서류함` 포럼 채널에 파일로 보관합니다. 봇의 `/서류` 커맨드는
파일 저장소가 아니라 **유효기간이 있는 증빙서류만 선택적으로** 등록해 만료 임박을 추적하는
용도입니다 — 모든 제출서류를 등록할 필요는 없습니다.

## 알림 (매일 아침 D-day 다이제스트)

`worker/cron/digest.ts`가 매일 **KST 08:30**(수집 1시간 뒤)에 봇 토큰으로
`DISCORD_CHANNEL_ID` 채널에 embed를 올립니다. 메시지 조립(`selectDigestSections`,
`digestUrgency` 등)은 `src/lib/digest.ts`의 순수 함수에 맡기고, `digest.ts`는 D1 읽기와
Discord 전송(재시도 포함)만 합니다.

포함되는 항목: 오늘/3일 이내 마감 공고, 내부 마감(`targetSubmitDate`)을 넘긴 미제출 지원건,
진행 중인 지원건에 물려 있는 만료/만료 임박(14일 이내) 서류, 발표 예정일이 지났는데 아직
결과가 안 나온 지원건. **넷 다 해당 사항이 없으면 아무 메시지도 보내지 않습니다** — 매일 "급한
거 없음"이 오면 알림을 꺼버리게 되기 때문입니다.

로컬에서 실제 채널에 올리지 않고 확인하려면 `.dev.vars`에 `CRON_DRY_RUN=true`를 넣고
`wrangler dev --test-scheduled`로 크론을 트리거하세요 — 메시지를 조립만 하고 전송은 건너뜁니다.

> `scripts/notify.mjs`는 Slack/Discord **웹훅**으로 같은 내용을 보내던 예전 방식이 코드에
> 남아 있는 것입니다. `data/*.json`(시드 파일)을 대상으로 하고 D1을 읽지 않으므로 지금의
> 운영 다이제스트(`worker/cron/digest.ts`, D1 대상)와는 별개입니다. 현재는 사용하지 않습니다.

## D1

- 데이터베이스: `grantboard` (Cloudflare D1, APAC 리전).
- 스키마: `migrations/0001_init.sql` ~ `0003_bot_state.sql`. 컬럼은 `src/content.config.ts`의
  zod 스키마와 1:1 대응(camelCase → snake_case)하고, `eligibility`/`tags`/`aliasTitles` 같은
  중첩 구조는 JSON 컬럼에 담아 `worker/db/repo.ts`에서만 파싱/직렬화합니다.
- 접근은 항상 `worker/db/repo.ts`를 통해서만 합니다.

```bash
npx wrangler d1 migrations apply grantboard --local   # 로컬(.wrangler/state)
npx wrangler d1 migrations apply grantboard --remote  # 실제 D1
node scripts/seed-d1.mjs --local                      # data/*.json → 로컬 D1
node scripts/seed-d1.mjs --remote                     # data/*.json → 실제 D1
node scripts/seed-d1.mjs --local --dry-run            # 생성될 SQL만 출력
```

시드는 멱등합니다(전부 `INSERT ... ON CONFLICT(id) DO UPDATE`) — 몇 번을 돌려도 행 수가
늘지 않고, `data/*.json`이 정본이므로 다시 돌리면 D1이 JSON 쪽에 맞춰집니다. 필수 필드가
하나라도 어긋나면 아무것도 쓰지 않고 멈춥니다.

## 로컬 실행

```bash
npm install
npx wrangler d1 migrations apply grantboard --local
node scripts/seed-d1.mjs --local
npm run dev:worker      # wrangler dev — Worker(봇 + 달력 페이지)를 로컬에서 띄움
```

로컬에서 디스코드 상호작용을 실제로 받으려면(서명 검증 포함) `/interactions`가 외부에서
접근 가능해야 하므로 ngrok 등으로 로컬 서버를 터널링하고, 그 URL을 개발자 포털의 테스트용
Interactions Endpoint URL에 임시로 걸어야 합니다. 달력 페이지(`/`, `/calendar`)만 확인할
때는 터널링이 필요 없습니다.

`.dev.vars`에 아래 시크릿을 채워야 합니다(형식은 [시크릿](#시크릿) 절 참고).

> `npm run dev`(`astro dev`)는 Workers 이전 시절의 정적 사이트(`src/pages/index.astro`)를
> 띄웁니다. `data/*.json`을 직접 읽어 화면을 그리며 D1이나 봇과는 무관합니다 — 코드가
> 레포에 남아 있어서 실행은 되지만, 지금 실제로 배포된 화면(`worker/web/`)과는 다른
> 화면입니다. 보드 UI 컴포넌트(`src/components/`)만 따로 손볼 때 외에는 쓸 일이 없습니다.

## 빌드 / 타입체크

```bash
npm run build              # astro check && astro build — 위 레거시 정적 사이트 + 공유 lib 타입체크
npm run typecheck:worker   # tsc -p worker/tsconfig.json --noEmit — Worker 코드 타입체크
```

Worker는 별도 빌드 산출물이 없습니다(TypeScript를 wrangler가 배포 시점에 번들합니다) — 배포
전 확인은 `typecheck:worker`가 담당합니다.

## 테스트

```bash
npm test          # src/lib + worker/** 전체 (284개)
npm run test:lib   # src/lib만
npm run test:db    # worker/db만
```

## 배포

```bash
npx wrangler deploy
```

`worker/index.ts`를 Cloudflare Workers에 직접 배포합니다. 별도 빌드 단계나 CI 없이, 이
명령 하나로 끝납니다. 배포·수집·알림을 맡던 CI 워크플로우 3개는 전부 삭제했고, 이 레포에는
자동화 워크플로우 파일이 하나도 없습니다 — 그 역할은 전부 아래처럼 Worker(크론 + 요청 시점
렌더링)로 옮겼습니다.

### 요청 시점 렌더링이라 D-day가 항상 정확하다

`worker/web/handler.ts`가 GET 요청마다 D1을 읽어 그 자리에서 HTML을 만듭니다. 캐시도
`no-store`로 꺼두었습니다. 그래서 자정(KST)이 지나 D-day가 바뀌어도, 또는 디스코드에서
공고나 지원 현황이 바뀌어도 다음 요청에 바로 반영됩니다.

(예전 정적 사이트 시절엔 D-day가 빌드 시각에 고정돼 하루 두 번 강제 재빌드가 필요했습니다 —
지금은 렌더링 자체가 요청 시점이라 그 크론이 필요 없고, 존재하지도 않습니다.)

## 시크릿

로컬은 `.dev.vars`, 배포 환경은 `wrangler secret put`으로 넣습니다. `wrangler.toml`의
`[vars]`에는 절대 넣지 않습니다 — 이 레포는 public이라 평문으로 커밋됩니다.

**필수**

| 키 | 용도 |
|----|------|
| `DISCORD_PUBLIC_KEY` | `/interactions` 서명(Ed25519) 검증 |
| `DISCORD_BOT_TOKEN` | 다이제스트 전송 등 봇이 먼저 말을 거는 API 호출 |
| `DISCORD_APPLICATION_ID` | 커맨드 등록, 인터랙션 응답 편집 |
| `DISCORD_GUILD_ID` | 커맨드를 등록할 길드 |
| `DISCORD_CHANNEL_ID` | D-day 다이제스트를 올릴 채널 |

**선택** — 없으면 해당 수집만 조용히 건너뜁니다(크론이 실패하지 않습니다).

| 키 | 용도 |
|----|------|
| `DATA_GO_KR_KEY` | K-Startup Open API |
| `BIZINFO_CRTFC_KEY` | 기업마당 Open API |

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put DISCORD_CHANNEL_ID
npx wrangler secret put DATA_GO_KR_KEY       # 선택
npx wrangler secret put BIZINFO_CRTFC_KEY    # 선택
```

> ⚠️ **값을 파이프로 넘길 때 끝에 개행이 붙으면 안 됩니다.** 실제로 겪은 사고입니다 —
> PowerShell 파이프(`echo $val | npx wrangler secret put ...`)는 값 끝에 개행을 붙이는데,
> 그 개행이 `DISCORD_PUBLIC_KEY`에 섞여 들어가 hex 문자열이 `<hex>\n`이 되면서
> `verifyDiscordRequest`의 hex 파싱이 조용히 실패해 **모든 인터랙션이 401로 튕겨나갔습니다.**
> 값을 넣을 때는 개행을 붙이지 않는 방식을 쓰세요. bash라면:
> ```bash
> printf '%s' "$VAL" | npx wrangler secret put DISCORD_PUBLIC_KEY
> ```
> PowerShell에서 파이프를 꼭 써야 한다면 `[Console]::Out.Write($val)`처럼 개행 없는 출력
> 방식을 쓰고, 넣은 뒤에는 실제로 인터랙션 서명 검증이 통과하는지(디스코드 포털의 엔드포인트
> 등록이 성공하는지) 확인하세요 — 값이 잘못 들어가도 `secret put` 자체는 성공한 것처럼
> 끝납니다.

## 스택

- [Cloudflare Workers](https://workers.cloudflare.com) — 봇 + 달력 페이지 + 크론, 전부 한 Worker(`worker/index.ts`)
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — 데이터 정본
- TypeScript (strict)
- [Astro](https://astro.build) 5 — Workers 이전 정적 사이트가 `src/`에 레거시로 남아 있음(위 [로컬 실행](#로컬-실행) 참고). 현재 배포되는 화면과는 무관
