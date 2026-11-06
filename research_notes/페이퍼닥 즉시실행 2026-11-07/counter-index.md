# 멈춘 카운터의 진상 + 검색엔진 인덱싱 + 사이트 동작 (2026-11-07 실측, curl 전용)

## 결론 3문장
1. **카운터는 거짓이 아니다.** 하드코딩도 고장도 아니고, 클라이언트가 Supabase RPC `analyses_stats` 를 호출해 실시간 값을 받아온다(실호출 결과 `total:110`). 즉 110건에서 멈춘 것은 "진짜로 아무도 안 쓴다"(가설 가)다. 다만 110건 중 89건이 월세이고 의뢰인 본인 테스트가 다수일 가능성이 높아(추정 85%) 랜딩의 "누적 분석 의뢰"는 사실상 의뢰인 자신의 테스트 횟수다.
2. **사이트는 검색엔진에 막혀 있지 않다(robots Allow, noindex 없음, sitemap 28개 URL 전부 200). 그런데 색인된 흔적도 없다.** `site:` 검색(WebSearch, Bing)에서 0건, 브랜드명 검색에서도 0건. 원인은 차단이 아니라 "발견·신뢰 신호 0"(vercel.app 서브도메인, 외부 링크 없음, canonical 없음)이다.
3. **페이지별 메타가 깨져 있다.** `/terms`·`/privacy`·`/diagnosis` 가 홈과 동일한 `<title>`·description·`og:url`(=홈)을 낸다. 공유·색인 시 전부 홈의 중복으로 취급될 위험이 크다. 이건 의뢰인이 소스를 못 가진 상태에선 고칠 수 없는 항목이다(소스 부재가 막고 있음).

## 확인된 사실

### 문제 1 — 카운터
- 홈 SSR HTML 의 「누적 분석 의뢰」 값은 `—`(대시)다. 즉 서버 렌더링 값이 아니고, 하드코딩도 아니다. (`curl https://paperdoc-web.vercel.app/` → 마크업 `<p class="text-3xl ...">—<span>건</span>`)
- `/_next/static/chunks/app/page-374d15df643cebff.js` 에서 클라이언트가 `t.rpc("analyses_stats")` 와 `t.rpc("diagnoses_stats")` 를 호출하고 결과를 `total`, `byType` 으로 표시하며 localStorage(`pd_analyses_stats`)에 캐시한다.
- `layout-5fa01c9e6e17ee8a.js` 에는 `rpc("claim_anonymous_analysis")`, `.from("notices")` 가 있다.
- 번들에 Supabase 프로젝트 URL(`https://<ref>.supabase.co`) **있음**, anon(공개) JWT 키 **있음**(layout 청크 1건, 값은 기록하지 않음). 환경변수명 `NEXT_PUBLIC_SUPABASE_*` 문자열 자체는 번들에서 못 찾음(빌드 시 인라인됨).
- 공개 RPC 실호출(읽기만, 키 비출력):
  - `analyses_stats` → HTTP 200 `{"total": 110, "byType": {"wolse": 89, "jeonse": 6, "maemae": 3, "sangga": 1, "bunyang": 1, "gwonrigeum": 3, "standalone": 7}}` (합 110, 숫자 일치)
  - `diagnoses_stats` → HTTP 200 `{"total" : 31}` (홈의 「누적 진단 · 이 집, 괜찮을까?」 카운터)
  - `notices` 테이블 → 익명 SELECT 가능(공지 데이터 반환). 공지 제목에 "페이퍼닥 오픈 기념! 등기사항전부증명서 무료 분석 이벤트"(작성 2026-05-14, 수정 2026-07-07) 등 존재.
- 세션에 연결된 Supabase MCP 의 프로젝트 URL(ref 앞 4자 `xypr`)은 페이퍼닥 번들의 프로젝트(ref 앞 4자 `awnz`)와 **다른 프로젝트**다. 그래서 MCP 로는 페이퍼닥 DB 를 조회하지 않았다. 함수 정의(`analyses_stats` 가 어떤 행을 세는지, 테스트 제외 필터가 있는지)는 **못 봤다**.
- 해석: 감사 시점 108 → 2026-11-07 110, 두 달 +2. 숫자는 정직하지만 신뢰 지표로는 역효과다("110건"이 아니라 사용량이 사실상 없다는 증거가 공개되어 있음). 반면 진단 31건은 별도 기능 사용량이며 시점별 추이는 이번에 측정하지 않았다(못 찾음).

### 문제 2 — 인덱싱
- `robots.txt` HTTP 200: `Allow: /`, `Disallow: /mypage /admin /history /result /auth /api/`, `Sitemap: https://paperdoc-web.vercel.app/sitemap.xml`. 크롤 차단 없음.
- `sitemap.xml` HTTP 200, `<loc>` 28개(홈, diagnosis, special-terms, analyze, pricing, faq, methodology, notices, disclaimer, privacy, terms, analyze/6종, docs/12종), **전부 같은 lastmod `2026-11-03T07:27:10.782Z`**(빌드 시각으로 일괄 찍힘 → 실제 갱신 신호가 아님).
- 5개 주요 페이지(`/`, `/methodology`, `/terms`, `/privacy`, `/diagnosis`) 모두 `<meta name="robots">` 없음, `X-Robots-Tag` 헤더 없음 → noindex 아님.
- `<link rel="canonical">` 가 5개 페이지 전부 **없음**.
- `/terms`, `/privacy`, `/diagnosis`: `<title>` = 홈과 동일("쉬운계약 페이퍼닥 — 부동산 계약서, 서명 전 스스로 점검"), description 동일, `og:url` = `https://paperdoc-web.vercel.app`(홈). `/methodology` 만 고유 title. 이 페이지들은 `<h1>` 은 1개씩 있음(홈만 0개 — 기 확인).
- OG/Twitter: `og:title/description/url/locale/image(+width/height/alt)/type`, `twitter:card/title/description/image` **전부 존재**. `og:image` = `/hero.png` HTTP 200 `image/png` **1,376,415바이트(약 1.3MB)** — 카카오톡 등 일부 앱에서 무겁다(추정, 신뢰도 50%).
- 색인 확인(전부 **0건**): WebSearch `site:paperdoc-web.vercel.app` → 해당 도메인 결과 없음; WebFetch Bing `site:` → 해당 도메인 결과 없음(전부 answers.microsoft.com); WebSearch "쉬운계약 페이퍼닥 계약서 점검" → 브랜드 직접 결과 없음. **한계: WebSearch 는 구글이 아니고, Bing 은 결과 페이지가 `site:` 를 무시한 듯하다. 네이버는 WebFetch 가 `search.naver.com` 접근을 거부해 못 봤다. 구글·네이버·다음의 실제 색인 여부는 확정 못 함.** 확정하려면 의뢰인이 Search Console/서치어드바이저에 사이트를 등록해야 한다.
- 도메인:
  - `paperdoc.co.kr` → 등록·운영 중, `https://paperdoc.co.kr/login` 200, 타이틀 "페이퍼닥 — 의사를 위한 의학 근거 플랫폼". **타인의 동일 상호 서비스**다(의학 근거 플랫폼). 이 도메인은 못 가진다.
  - `paperdoc.com` → http 301 / https 404, 등록된 것으로 보임(소유자 불명).
  - `paperdoc.kr` → Google DNS(8.8.8.8) `Non-existent domain`. 미등록일 가능성이 있다(추정 65%, whois 미조회 — 등록기관에서 확인 필요).
  - `paperdoc.app` → 응답 없음(DNS 이름 해석은 되나 서비스 없음).
  - 페이퍼닥이라는 상호 자체가 이미 의학 서비스, 앱스토어 PaperDoc 앱과 겹친다(WebSearch 결과에 App Store PaperDoc 등장). 상표·검색 충돌 가능성(추정).
- `*.vercel.app` 서브도메인의 영향: 검색엔진이 금지하진 않지만, 도메인 권위 0에서 시작하고 사용자에게 "개인 프로젝트" 인상을 준다(일반론, 이번에 수치 측정 안 함 → `(추정)`). 결제를 받으려면 결국 자체 도메인이 필요하다.

### 문제 3 — 동작
- sitemap 28개 URL 전부 HTTP 200. 느린 건 `/notices` 1.15초, 나머지 `/analyze/*`·`/docs/*` 0.25~0.50초, 정적 페이지 0.05~0.06초. (전부 응답 정상.)
- 홈 `<script>` 번들 11개 + CSS 전부 200, 404 난 번들 없음. 홈 HTML 61,815B, `/methodology` 269,446B.
- 404: `/favicon.ico`, `/manifest.webmanifest`, `/ads.txt`, `/.well-known/security.txt`(없어도 무방), 임의 경로 `/nonexistent`(정상 404). 500 은 없음. **`/favicon.ico` 404** 는 탭 아이콘·네이버 검색 노출에 영향(추정; `<link rel="icon">` 으로 대체됐는지는 확인 안 함).
- CSP 헤더가 설정되어 있음(`frame-ancestors 'self'` — 앱인토스 웹뷰/iframe 임베드는 이 정책으로 막힘. 임베드 방식이면 걸림돌 `(추정)`).

## 당장 할 것 — 집행 단위
| # | 작업 | 소요 | 막고 있는 것 | 완료 판정 |
|---|---|---|---|---|
| 1 | 구글 Search Console + 네이버 서치어드바이저에 `paperdoc-web.vercel.app` 등록, sitemap 제출 | 1시간(소유확인 포함) | 소유확인에 `<meta>` 태그나 파일 업로드가 필요한데 소스가 없음. Vercel 계정 접근 가능한지 불명 | 두 콘솔에서 "색인 요청 N건 제출", 1주 후 색인 수 확인 |
| 2 | 랜딩 「누적 분석 의뢰 110건」 노출을 **숨기거나** 라벨 교체(예: 출시 준비 중) | 소스 수정 30분 | 소스 없음 | 홈 HTML/번들에서 해당 블록 사라짐 |
| 3 | `/terms`·`/privacy`·`/diagnosis` 고유 title/description/og:url + canonical 추가 | 소스 수정 1시간 | 소스 없음 | `curl` 로 각 페이지 `<title>` 이 서로 다름 |
| 4 | `paperdoc.kr` whois 확인(가비아 등 등록기관 검색), 비어 있으면 상호 충돌 검토 후 결정 | 20분 + 연 2만원대(추정) | 상호 "페이퍼닥"이 의학 서비스와 충돌(상표 확인 필요) | 도메인 확보 또는 "안 산다" 결정 기록 |
| 5 | `/favicon.ico` 추가, `og:image` 를 300KB 이하로 경량화 | 소스 수정 30분 | 소스 없음 | `curl -I /favicon.ico` 200, hero.png 크기 감소 |

## 하지 말 것 / 버릴 것
- **카운터 "수정"에 시간 쓰지 말 것** — 고장이 아니라 사용량 부재다. 고칠 대상은 숫자가 아니라 노출 여부.
- **SEO 최적화(키워드 글, 블로그, 백링크 작업)를 지금 하지 말 것** — 앞서 확정된 검색 수요(월 10~100회)가 없으므로 색인돼도 유입이 없다. 색인 등록(#1)은 1시간 작업이라 하되 그 이상은 버린다.
- 자체 도메인 구매를 결제 개시 전에 서두르지 말 것 — 소스·상호 문제가 먼저다.
- 3~5번은 모두 **소스 부재**가 전제 조건이다. 소스가 없으면 #1(콘솔 등록)만 가능하며, 이마저 Vercel 접근이 필요하다.

## 못 찾은 것
- `analyses_stats` RPC 가 테스트·내부 호출을 제외하는지(함수 SQL 정의) — 페이퍼닥 Supabase 에 접근할 연결이 없음.
- 구글·네이버·다음의 실제 색인 상태(WebSearch/Bing 으로는 확정 불가, 네이버 WebFetch 거부).
- `paperdoc.kr` 의 정확한 등록 여부(whois 미실행, DNS 만 조회) 및 `paperdoc.com` 소유자.
- 진단(diagnoses) 카운터 31건의 시점별 추이, 분석 110건의 최근 증분 시각.
- 홈 `<link rel="icon">` 존재 여부(favicon.ico 404 만 확인).
