-- grantboard 초기 스키마.
--
-- 정본은 src/content.config.ts의 zod 스키마다. 여기 컬럼은 그 필드와 1:1로 대응하며
-- 이름만 camelCase → snake_case로 바꿨다. 필드를 빼거나 의미를 바꾸지 말 것.
--
-- 날짜 규칙 (이 프로젝트의 확고한 규칙):
--   * 날짜는 전부 TEXT 'YYYY-MM-DD', 일시는 ISO8601 문자열로 저장한다.
--   * SQLite의 date()/julianday()/strftime() 같은 날짜 함수를 쓰지 않는다.
--     D-day·유효기한·마감상태 판정은 전부 src/lib/schedule.ts가 KST(UTC+9) 자정 기준으로 한다.
--     SQLite는 UTC 기준이라 여기서 날짜를 판정하면 KST 경계에서 하루씩 어긋난다.
--
-- JSON 컬럼(eligibility, tags, alias_titles, document_ids)은 worker/db/repo.ts에서만
-- 파싱/직렬화한다. 호출자는 순수 객체만 본다.

-- 지원사업/공모전 공고
CREATE TABLE IF NOT EXISTS programs (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  organizer       TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  category        TEXT NOT NULL
                    CHECK (category IN ('정부지원사업', '공모전', '경진대회', '교육프로그램', '기타')),
  apply_start     TEXT,                   -- 'YYYY-MM-DD', 없으면 상시/미확인
  apply_end       TEXT NOT NULL,          -- 'YYYY-MM-DD'
  apply_end_time  TEXT                    -- 'HH:MM'. 없으면 화면에 "시각 미확인"으로 표시한다.
                    CHECK (apply_end_time IS NULL OR apply_end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  announce_date   TEXT,                   -- 'YYYY-MM-DD'
  support_amount  TEXT,
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'k-startup', 'bizinfo')),
  collected_at    TEXT,                   -- ISO8601 datetime. 자동수집분만 채워진다.
  eligibility     TEXT,                   -- JSON object 또는 NULL
  tags            TEXT NOT NULL DEFAULT '[]',        -- JSON array
  alias_titles    TEXT NOT NULL DEFAULT '[]'         -- JSON array. manual 행 전용(collect.ts mergePrograms).
);

-- 우리 팀의 지원 현황. programs와 programId로 연결된다.
CREATE TABLE IF NOT EXISTS applications (
  id                  TEXT PRIMARY KEY,
  program_id          TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  status              TEXT NOT NULL
                        CHECK (status IN ('검토중', '준비', '작성중', '제출완료',
                                          '서류통과', '최종선정', '탈락', '미지원')),
  -- 이 레포는 public이다 — 실명 금지, 이니셜/닉네임만. zod의 max(4)를 DB에서도 강제한다.
  owner               TEXT NOT NULL CHECK (length(owner) <= 4),
  priority            TEXT NOT NULL DEFAULT 'mid' CHECK (priority IN ('high', 'mid', 'low')),
  -- 팀 내부 마감일. 마감 당일 접속 폭주 대비로 실제 마감보다 앞당겨 잡는다.
  target_submit_date  TEXT,
  submitted_at        TEXT,
  result_at           TEXT,
  note                TEXT,
  document_ids        TEXT NOT NULL DEFAULT '[]'     -- JSON array of documents.id
);

-- 제출서류 마스터. 사업 간 재사용 추적용.
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('서식', '증빙', '기타')),
  reusable      INTEGER NOT NULL DEFAULT 1 CHECK (reusable IN (0, 1)),
  issued_at     TEXT,                     -- 'YYYY-MM-DD'
  validity_days INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
  valid_until   TEXT,                     -- issued_at + validity_days보다 우선하는 명시적 override
  ready         INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  reuse_source  TEXT
);

-- 팀 프로필. 단일 행만 존재한다 — id를 1로 못박아 두 번째 행이 아예 들어갈 수 없게 한다.
-- ⚠️ public 레포. 실명·주민등록번호·상세주소·연락처를 넣지 말 것. region은 시도 단위까지만.
CREATE TABLE IF NOT EXISTS team_profile (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  has_business_registration  INTEGER NOT NULL CHECK (has_business_registration IN (0, 1)),
  business_registered_at     TEXT,
  incorporated_at            TEXT,        -- 없으면 미설립(예비창업 단계)으로 본다.
  founder_birth_year         INTEGER,
  region                     TEXT NOT NULL
                               CHECK (region IN ('서울', '부산', '대구', '인천', '광주', '대전',
                                                 '울산', '세종', '경기', '강원', '충북', '충남',
                                                 '전북', '전남', '경북', '경남', '제주'))
);

-- 조회 패턴: 달력/타임라인은 마감일순, 칸반은 상태별, 서류탭은 미준비분 우선.
CREATE INDEX IF NOT EXISTS idx_programs_apply_end       ON programs (apply_end);
CREATE INDEX IF NOT EXISTS idx_programs_category        ON programs (category);
CREATE INDEX IF NOT EXISTS idx_programs_source          ON programs (source);
CREATE INDEX IF NOT EXISTS idx_applications_program_id  ON applications (program_id);
CREATE INDEX IF NOT EXISTS idx_applications_status      ON applications (status);
CREATE INDEX IF NOT EXISTS idx_documents_ready          ON documents (ready);
