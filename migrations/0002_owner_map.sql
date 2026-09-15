-- 디스코드 계정 ↔ 담당자 이니셜 매핑.
--
-- 이 테이블이 없을 때는 디스코드 표시이름과 applications.owner를 문자열로 근사매칭했는데,
-- 이니셜이 짧아서(최대 4자) 남의 지원 건이 내 것으로 잡히는 오탐이 났다. 명시적 등록으로 바꾼다.
--
-- 카디널리티 규칙:
--   * discord_user_id가 PK  → 한 계정은 이니셜을 하나만 갖는다. 다시 등록하면 갱신(덮어쓰기)된다.
--   * owner에는 UNIQUE를 걸지 않는다 → 두 계정이 같은 이니셜을 쓰는 건 허용한다(공용 계정).
--
-- ⚠️ 이 레포는 public이다. owner는 applications.owner와 같은 규칙(최대 4자, 실명 금지)을 따른다.
-- discord_user_id는 스노우플레이크 숫자 문자열이라 그 자체로는 개인을 특정하지 않는다.
CREATE TABLE IF NOT EXISTS owner_map (
  discord_user_id TEXT PRIMARY KEY,
  owner           TEXT NOT NULL CHECK (length(owner) <= 4),
  -- 마지막 등록 시각(ISO8601 UTC). 감사용일 뿐 날짜 판정에는 쓰지 않는다 —
  -- 날짜 판정은 전부 src/lib/schedule.ts가 KST 기준으로 한다(0001_init.sql의 날짜 규칙 참고).
  updated_at      TEXT NOT NULL
);

-- '이 이니셜을 쓰는 계정들' 역방향 조회용.
CREATE INDEX IF NOT EXISTS idx_owner_map_owner ON owner_map (owner);
