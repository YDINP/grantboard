-- 봇이 재시작·재배포 사이에 기억해야 하는 값들. 범용 키-값 저장소.
--
-- 첫 용도는 자동 갱신 현황판이다. 봇이 채널에 메시지를 하나 올려두고 데이터가 바뀔 때마다
-- 그 메시지를 편집한다(매번 새로 올리면 채널이 쌓여서 못 쓴다). 그러려면 "어느 채널의
-- 어느 메시지가 현황판인지"를 다음 실행에서도 알아야 한다.
--   key = 'status_board', value = '{"channelId":"...","messageId":"..."}'
--
-- value는 **repo가 해석하지 않는 불투명한 문자열**이다. 용도마다 모양이 다르므로
-- repo가 구조를 알면 새 용도가 생길 때마다 repo를 고쳐야 한다. JSON 파싱은 호출자 몫.
--
-- ⚠️ owner_map과 마찬가지로 **런타임 상태**다. data/*.json에 정본이 없으므로
-- scripts/seed-d1.mjs는 이 테이블을 건드리지 않는다. 시드가 지우면 현황판 메시지 연결이
-- 끊겨 봇이 매번 새 메시지를 만든다.
CREATE TABLE IF NOT EXISTS bot_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  -- 마지막 갱신 시각(ISO8601 UTC). 감사·디버깅용일 뿐 날짜 판정에는 쓰지 않는다 —
  -- 날짜 판정은 전부 src/lib/schedule.ts가 KST 기준으로 한다(0001_init.sql의 날짜 규칙 참고).
  updated_at TEXT NOT NULL
);
