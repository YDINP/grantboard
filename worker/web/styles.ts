/**
 * 페이지 전체 CSS. Astro 컴포넌트의 <style>을 한 파일로 합친 것이다.
 * Astro는 컴포넌트마다 스코프 해시를 붙여 줬지만 여기서는 그게 없으므로, 같은 이름을 쓰던 클래스
 * (.day .title .facts .empty .dday .tone-* …)를 컴포넌트 루트 클래스 아래로 스코프해 충돌을 막는다.
 *   .summary / .schedule / .filter / .calendar / .chip / .dd(날짜 상세) / .timeline / .kanban / .documents / .badge
 * 디자인 토큰·색 사용 원칙·모바일 규칙(≤640px 칩→점, ≤400px 여백)은 원본 그대로다.
 */
export const STYLES = /* css */ `
/* ── 디자인 토큰. 색은 상태를 나타낼 때만 쓴다 — 장식용 색 추가 금지. ── */
:root {
  color-scheme: dark;
  --bg: #111318;
  --surface: #181c24;
  --surface-2: #1f242e;
  --line: #2b313d;
  --text: #e6e8ee;
  --text-2: #a3abbd;
  --text-3: #6f7889;
  --red: #f87171;
  --red-bg: rgba(248, 113, 113, 0.14);
  --orange: #fb923c;
  --orange-bg: rgba(251, 146, 60, 0.14);
  --amber: #fbbf24;
  --amber-bg: rgba(251, 191, 36, 0.14);
  --green: #4ade80;
  --green-bg: rgba(74, 222, 128, 0.14);
  --blue: #60a5fa;
  --blue-bg: rgba(96, 165, 250, 0.14);
  --gray: #8b93a5;
  --gray-bg: rgba(139, 147, 165, 0.16);
  --radius: 8px;
  --radius-sm: 5px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; max-width: 100vw; overflow-x: hidden; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI',
    'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
  font-size: 15px;
  line-height: 1.5;
  padding: 1rem;
  -webkit-text-size-adjust: 100%;
  /* 한글은 어절 단위로 줄바꿈, 긴 URL·영문은 강제 분리 */
  word-break: keep-all;
  overflow-wrap: anywhere;
}
a { color: #7dd3fc; }
/* 탭 전환은 hidden 속성 토글이다. 컴포넌트의 display 지정이 이를 덮어쓰지 못하게 한다. */
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  padding: 0.05em 0.3em;
  border-radius: 3px;
  background: var(--surface-2);
}
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 400px) { body { padding: 0.75rem; } }

/* ── 페이지 골격 ── */
.page { max-width: 1100px; margin: 0 auto; }
.masthead {
  display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
  gap: 0.25rem 1rem; margin-bottom: 0.75rem;
}
.brand { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); text-decoration: none; }
.meta { display: flex; flex-wrap: wrap; gap: 0.2rem 0.75rem; margin: 0; font-size: 0.78rem; color: var(--text-2); }
.meta strong { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.dim-text { color: var(--text-3); }

/* 탭 바는 스크롤해도 따라온다 — 하루에도 몇 번씩 탭을 오가는 도구라서 */
.tabs {
  position: sticky; top: 0; z-index: 10;
  display: flex; gap: 0.25rem; margin: 1rem 0 0.75rem;
  border-bottom: 1px solid var(--line); background: var(--bg);
}
.tabs button {
  display: inline-flex; align-items: center; gap: 0.4rem;
  min-height: 44px; margin-bottom: -1px; padding: 0.5rem 0.9rem;
  border: 0; border-bottom: 2px solid transparent; background: none;
  color: var(--text-2); font: inherit; font-weight: 600; cursor: pointer;
}
.tabs button:hover { color: var(--text); }
.tabs button[aria-selected='true'] { color: var(--text); border-bottom-color: var(--text); }
.tabs .count {
  min-width: 1.4em; padding: 0 0.4em; border-radius: 999px;
  background: var(--surface-2); color: var(--text-3);
  font-size: 0.72rem; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums;
}
.tabs button[aria-selected='true'] .count { color: var(--text); }

/* 데이터 입력은 디스코드에서 한다 — 웹은 읽기 전용. 모든 탭 아래 공통으로 한 줄. */
.discord-note {
  margin: 1.25rem 0 0; padding: 0.55rem 0.8rem;
  border: 1px dashed var(--line); border-radius: var(--radius);
  background: var(--surface); font-size: 0.78rem; color: var(--text-2);
}
.discord-note strong { color: var(--text); font-weight: 600; }

/* 빈 상태 안내. 탭마다 같은 모양. */
.empty {
  margin: 0 0 0.75rem; padding: 0.8rem 0.9rem;
  border: 1px dashed var(--line); border-radius: var(--radius);
  background: var(--surface); font-size: 0.85rem; color: var(--text-2);
}
.empty strong { color: var(--text); }

/* 서버 오류 화면 */
.error-box { max-width: 560px; margin: 3rem auto; padding: 1rem 1.2rem; border: 1px solid var(--red); border-radius: var(--radius); background: var(--red-bg); }
.error-box h1 { margin: 0 0 0.4rem; font-size: 1.05rem; }
.error-box p { margin: 0; font-size: 0.85rem; color: var(--text-2); }

/* ── Badge ── */
.badge {
  display: inline-flex; align-items: center; gap: 0.25em;
  padding: 0.1rem 0.5rem; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface-2); color: var(--text-2);
  font-size: 0.72rem; font-weight: 600; line-height: 1.5; white-space: nowrap; vertical-align: middle;
}
.badge.tone-gray { color: var(--gray); background: var(--gray-bg); border-color: transparent; }
.badge.tone-green { color: var(--green); background: var(--green-bg); border-color: transparent; }
.badge.tone-blue { color: var(--blue); background: var(--blue-bg); border-color: transparent; }
.badge.tone-amber { color: var(--amber); background: var(--amber-bg); border-color: transparent; }
.badge.tone-orange { color: var(--orange); background: var(--orange-bg); border-color: transparent; }
.badge.tone-red { color: var(--red); background: var(--red-bg); border-color: transparent; }
.badge.strong { color: #101216; }
.badge.strong.tone-red { background: var(--red); }
.badge.strong.tone-orange { background: var(--orange); }
.badge.strong.tone-amber { background: var(--amber); }
.badge.strong.tone-green { background: var(--green); }
.badge.strong.tone-blue { background: var(--blue); }
.badge.strong.tone-gray { background: var(--gray); }

/* ── SummaryBar ── */
.summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
@media (min-width: 720px) { .summary { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.summary .filter-note {
  grid-column: 1 / -1; margin: 0; padding: 0.3rem 0.6rem;
  border-left: 3px solid var(--amber); border-radius: var(--radius-sm); background: var(--amber-bg);
  font-size: 0.75rem; color: var(--text-2);
}
.summary .filter-note strong { color: var(--text); }
.summary .stat {
  --stat-color: var(--line);
  display: grid; gap: 0.05rem; min-width: 0; padding: 0.55rem 0.75rem;
  background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--stat-color);
  border-radius: var(--radius);
}
.summary .label { font-size: 0.72rem; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary .value { font-size: 1.5rem; font-weight: 800; line-height: 1.15; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--stat-color); }
.summary .hint { font-size: 0.72rem; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary .tone-quiet .value { color: var(--text-3); }
/* open 상태(여유 있음)는 숫자만 흰색, 왼쪽 띠는 그대로 */
.summary .tone-neutral .value { color: var(--text); }
.summary .tone-red { --stat-color: var(--red); }
.summary .tone-orange { --stat-color: var(--orange); }
.summary .tone-blue { --stat-color: var(--blue); }
.summary .tone-gray { --stat-color: var(--gray); }

/* ── ScheduleTab: 보기 전환 ── */
.schedule { min-width: 0; max-width: 100%; }
.schedule .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; }
.schedule .switch { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.schedule .switch button {
  min-height: 36px; padding: 0.2rem 0.9rem; border: 0; border-radius: 6px; background: none;
  color: var(--text-2); font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer;
}
.schedule .switch button:hover { color: var(--text); }
.schedule .switch button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }

/* ── FilterBar ── */
.filter { margin-bottom: 0.75rem; }
.filter .bar { display: flex; align-items: flex-start; gap: 0.5rem; }
.filter .panel { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.filter.active .panel { border-color: var(--amber); }
.filter.none .panel { border-color: var(--orange); }
.filter summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem;
  min-height: 44px; padding: 0.35rem 0.75rem; cursor: pointer; list-style: none; font-size: 0.8rem;
}
.filter summary::-webkit-details-marker { display: none; }
.filter summary::before { content: '▸'; color: var(--text-3); font-size: 0.8rem; }
.filter .panel[open] summary::before { content: '▾'; }
.filter .sum-label { font-weight: 700; color: var(--text); }
.filter .sum-badge {
  min-width: 1.4em; padding: 0 0.4em; border-radius: 999px; background: var(--amber); color: #101216;
  font-size: 0.7rem; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums;
}
.filter .sum-status { color: var(--text-2); font-variant-numeric: tabular-nums; }
.filter.active .sum-status { color: var(--amber); font-weight: 600; }
.filter.none .sum-status { color: var(--orange); font-weight: 600; }
.filter .groups { display: flex; flex-wrap: wrap; gap: 0.6rem 1.25rem; padding: 0.25rem 0.75rem 0.75rem; border-top: 1px solid var(--line); }
.filter fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.filter legend { padding: 0.45rem 0 0.3rem; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.02em; color: var(--text-3); }
.filter .options { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.filter .opt {
  position: relative; display: inline-flex; align-items: center; min-height: 32px; padding: 0.15rem 0.65rem;
  border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); color: var(--text-2);
  font-size: 0.78rem; font-weight: 600; cursor: pointer; user-select: none;
}
.filter .opt input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.filter .opt:hover { color: var(--text); }
.filter .opt:has(input:checked) { border-color: var(--amber); background: var(--amber-bg); color: var(--text); }
.filter .opt:has(input:focus-visible) { outline: 2px solid var(--blue); outline-offset: 2px; }
.filter .toggle { border-radius: var(--radius-sm); }
.filter .toggle::before { content: ''; width: 0.8em; height: 0.8em; margin-right: 0.4em; border: 1.5px solid var(--text-3); border-radius: 3px; }
.filter .toggle:has(input:checked)::before { background: var(--amber); border-color: var(--amber); }
.filter .clear {
  flex-shrink: 0; min-height: 44px; padding: 0.3rem 0.8rem;
  border: 1px solid var(--amber); border-radius: var(--radius); background: var(--amber-bg); color: var(--amber);
  font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer;
}
.filter .clear:hover { background: var(--amber); color: #101216; }

/* ── CalendarView ── */
.calendar { min-width: 0; max-width: 100%; }
.calendar .cal-nav { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.5rem; }
.calendar .cal-title {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; flex: 1; min-width: 0;
  margin: 0; font-size: 1rem; font-weight: 700; font-variant-numeric: tabular-nums;
}
.calendar .cal-count { font-size: 0.75rem; font-weight: 500; color: var(--text-3); }
.calendar .nav-btn, .calendar .today-btn {
  min-width: 44px; min-height: 40px; padding: 0.2rem 0.6rem;
  border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--text);
  font: inherit; font-weight: 600; cursor: pointer;
}
.calendar .nav-btn { font-size: 1.25rem; line-height: 1; }
.calendar .today-btn { font-size: 0.8rem; }
.calendar .nav-btn:hover, .calendar .today-btn:hover { background: var(--surface-2); }
.calendar .nav-btn:disabled, .calendar .today-btn:disabled { opacity: 0.4; cursor: default; }
.calendar .legend { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; list-style: none; margin: 0 0 0.5rem; padding: 0; font-size: 0.72rem; color: var(--text-2); }
.calendar .legend li { display: inline-flex; align-items: center; gap: 0.35rem; }
.calendar .swatch { display: inline-block; width: 14px; height: 8px; border-radius: 2px; }
.calendar .swatch.end { background: var(--text); }
.calendar .swatch.target { border: 1px solid var(--text-2); }
.calendar .swatch.announce { background: var(--blue-bg); border: 1px solid var(--blue); }
.calendar .swatch.start { height: 1px; align-self: center; background: var(--text-3); }
.calendar .empty { margin-bottom: 0.6rem; padding: 0.7rem 0.9rem; }
.calendar .weekdays, .calendar .week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.calendar .weekdays { padding: 0 0 0.25rem; font-size: 0.7rem; font-weight: 600; text-align: center; color: var(--text-3); }
.calendar .wd.sun { color: var(--red); }
.calendar .wd.sat { color: var(--blue); }
.calendar .grid { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.calendar .week + .week { border-top: 1px solid var(--line); }
.calendar .cell {
  position: relative; display: flex; flex-direction: column; gap: 0.15rem;
  min-width: 0; min-height: 96px; padding: 0.25rem; overflow: hidden;
}
.calendar .cell + .cell { border-left: 1px solid var(--line); }
.calendar .cell.out { background: var(--bg); }
.calendar .cell.selected { background: var(--surface-2); }
.calendar .day {
  align-self: flex-start; min-width: 26px; min-height: 26px; padding: 0 0.3rem;
  border: 0; border-radius: 999px; background: none; color: var(--text-2);
  font: inherit; font-size: 0.78rem; font-weight: 600; font-variant-numeric: tabular-nums; cursor: pointer;
}
.calendar .day:hover { background: var(--surface-2); color: var(--text); }
.calendar .cell.sun .day { color: var(--red); }
.calendar .cell.sat .day { color: var(--blue); }
.calendar .cell.out .day { color: var(--text-3); opacity: 0.55; }
/* 오늘: 채운 원 + 칸 테두리. 하루에 몇 번씩 여는 화면이라 무엇보다 먼저 눈에 들어와야 한다. */
.calendar .cell.today { box-shadow: inset 0 0 0 2px var(--text); }
.calendar .cell.today .day { background: var(--text); color: #101216; }
.calendar .cell.today.out { box-shadow: inset 0 0 0 2px var(--text-3); }
.calendar .chips { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
/* "+N" 접기: 넓은 화면에서만. 좁은 화면에서는 점이 작아서 다 보여도 된다. */
.calendar .more {
  align-self: flex-start; margin: 0; padding: 0 0.35rem; border: 0; border-radius: 3px; background: none;
  color: var(--text-2); font: inherit; font-size: 0.7rem; font-weight: 700; cursor: pointer;
}
.calendar .more:hover { background: var(--surface-2); color: var(--text); }
@media (min-width: 641px) { .calendar .chips .chip.overflow { display: none; } }
.calendar .day-empty {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  margin-top: 0.75rem; padding: 0.6rem 0.9rem;
  border: 1px dashed var(--line); border-radius: var(--radius); background: var(--surface);
  font-size: 0.85rem; color: var(--text-2);
}
.calendar .day-empty p { margin: 0; }
.calendar .day-empty strong { color: var(--text); font-variant-numeric: tabular-nums; }
.calendar .close, .dd .close {
  min-height: 32px; padding: 0.2rem 0.7rem; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text-2); font: inherit; font-size: 0.78rem; cursor: pointer;
}
.dd .close:hover { color: var(--text); }
/* 좁은 화면: 날짜 버튼이 칸 전체를 덮고(터치 타겟), 칩은 하단에 점으로 깔린다. */
@media (max-width: 640px) {
  .calendar .cell { min-height: 56px; padding: 0; gap: 0; }
  /* 버튼은 내용을 세로 중앙에 두므로 flex로 위쪽에 고정한다 — 아래는 점(dot)이 차지한다. */
  .calendar .day {
    position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: center;
    width: 100%; min-height: 100%; padding: 0.25rem 0 0; border-radius: 0; align-self: stretch; text-align: center;
  }
  /* 오늘: 숫자 뒤에만 채운 원. 겹침 순서에 의존하지 않도록 배경 그라디언트로 그린다. */
  .calendar .cell.today .day { background: radial-gradient(circle 13px at 50% 14px, var(--text) 99%, transparent 100%); color: #101216; }
  .calendar .cell.today .day:hover { background: radial-gradient(circle 13px at 50% 14px, var(--text) 99%, var(--surface-2) 100%); }
  .calendar .cell.selected { background: var(--surface-2); }
  .calendar .chips {
    position: absolute; left: 3px; right: 3px; bottom: 4px;
    flex-direction: row; flex-wrap: wrap; justify-content: center; align-items: center; gap: 3px; pointer-events: none;
  }
  .calendar .more { display: none; }
}

/* ── EventChip: 날짜 칸 위의 이벤트 한 개 ── */
.chip {
  display: block; width: 100%; min-width: 0; margin: 0; padding: 0.05rem 0.35rem;
  border: 1px solid transparent; border-radius: 3px; background: none; color: var(--text);
  font: inherit; font-size: 0.7rem; line-height: 1.45; text-align: left; cursor: pointer;
}
.chip .text { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* 종류 표시. 마감(가장 강함)은 접두어 없이 채운 칩 자체로 말한다. */
.chip.kind-target .text::before { content: '내부 '; font-weight: 700; }
.chip.kind-announce .text::before { content: '발표 '; font-weight: 700; }
.chip.kind-apply-start .text::before { content: '시작 '; }
/* 접수 마감: 채운 칩. 색은 deadlineState. */
.chip.kind-apply-end { font-weight: 700; color: #101216; background: var(--text); }
.chip.kind-apply-end.tone-red { background: var(--red); }
.chip.kind-apply-end.tone-orange { background: var(--orange); }
.chip.kind-apply-end.tone-blue { background: var(--blue); }
.chip.kind-apply-end.tone-gray { background: var(--gray); text-decoration: line-through; }
/* 내부 마감: 테두리 칩. 지났는데 미제출이면 빨강. */
.chip.kind-target { border-color: var(--text-2); color: var(--text); }
.chip.kind-target.tone-red { border-color: var(--red); color: var(--red); }
.chip.kind-target.tone-gray { border-color: var(--line); color: var(--text-3); text-decoration: line-through; }
/* 발표 예정: 연한 파랑 배경. 지난 발표일은 회색. */
.chip.kind-announce { background: var(--blue-bg); color: var(--blue); }
.chip.kind-announce.tone-gray { background: var(--gray-bg); color: var(--text-3); }
/* 접수 시작: 가장 약하게, 텍스트만. */
.chip.kind-apply-start { color: var(--text-3); }
.chip:hover, .chip:focus-visible { filter: brightness(1.15); }
/* 지원 불가 판정은 흐리게만 — 판정이 틀릴 수 있으니 숨기지 않는다. */
.chip.dim { opacity: 0.45; }
.chip.dim:hover, .chip.dim:focus-visible { opacity: 1; }
/* 좁은 화면: 칩 → 점. 종류는 모양(원/링/사각/작은 점)과 색으로 구분한다. */
@media (max-width: 640px) {
  .chip {
    width: 7px; height: 7px; padding: 0; border-radius: 50%; border-width: 1.5px;
    font-size: 0; line-height: 0; text-decoration: none; pointer-events: none;
  }
  .chip .text { display: none; }
  .chip.kind-target { background: transparent; }
  .chip.kind-announce { border-radius: 1px; background: var(--blue); }
  .chip.kind-announce.tone-gray { background: var(--gray); }
  .chip.kind-apply-start { width: 5px; height: 5px; background: var(--text-3); }
}

/* ── DayDetail(.dd): 하루치 일정 상세, 달력 아래에 펼쳐지는 패널 ── */
.dd { margin-top: 0.75rem; padding: 0.75rem 0.9rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.dd .dd-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
.dd .dd-head h4 { margin: 0; font-size: 0.95rem; font-weight: 700; }
.dd .n { margin-left: 0.35rem; font-size: 0.78rem; font-weight: 500; color: var(--text-3); font-variant-numeric: tabular-nums; }
.dd .filtered { margin: 0 0 0.5rem; padding: 0.4rem 0.6rem; border: 1px dashed var(--line); border-radius: var(--radius-sm); font-size: 0.78rem; color: var(--text-2); }
.dd .entries { list-style: none; margin: 0; padding: 0; }
.dd .entry { padding: 0.6rem 0; }
.dd .entry + .entry { border-top: 1px solid var(--line); }
.dd .entry.dim { opacity: 0.55; }
.dd .entry.dim:hover, .dd .entry.dim:focus-within { opacity: 1; }
.dd .entry-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.75rem; }
.dd .kind { padding: 0.05rem 0.45rem; border-radius: 3px; font-weight: 700; color: #101216; background: var(--text); }
.dd .kind.kind-target { background: none; border: 1px solid var(--text-2); color: var(--text); }
.dd .kind.kind-announce { background: var(--blue-bg); color: var(--blue); }
.dd .kind.kind-apply-start { background: var(--surface-2); color: var(--text-3); }
.dd .dday { font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text); }
.dd .dday.tone-red { color: var(--red); }
.dd .dday.tone-orange { color: var(--orange); }
.dd .dday.tone-blue { color: var(--blue); }
.dd .dday.tone-gray { color: var(--text-3); text-decoration: line-through; }
.dd .title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.5rem; margin: 0.3rem 0 0; }
.dd .title { font-size: 0.95rem; font-weight: 600; color: var(--text); text-decoration: none; }
.dd a.title:hover { text-decoration: underline; }
.dd a.title::after { content: ' ↗'; font-size: 0.75em; color: var(--text-3); }
.dd .title.no-link { cursor: default; }
.dd .org { font-size: 0.8rem; color: var(--text-2); }
.dd .amount { font-size: 0.8rem; color: var(--text-3); }
.dd .facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.25rem 0.75rem; margin: 0.45rem 0 0; font-size: 0.8rem; }
.dd .facts dt { color: var(--text-3); white-space: nowrap; }
.dd .facts dd { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem 0.4rem; margin: 0; color: var(--text-2); }
.dd .facts strong { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.dd .facts strong.closed { color: var(--text-3); text-decoration: line-through; }
.dd .muted { color: var(--text-3); }
.dd .reasons { flex-basis: 100%; margin: 0.1rem 0 0; padding-left: 1.1rem; font-size: 0.76rem; line-height: 1.45; }
.dd .apps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.dd .apps li { display: flex; flex-wrap: wrap; gap: 0.2rem 0.4rem; }
/* 내부 마감 이벤트가 가리키는 그 지원건을 살짝 짚어 준다 */
.dd .apps li.current { color: var(--text); }
.dd .status { font-weight: 600; color: var(--text); }
.dd .overdue { color: var(--red); font-weight: 600; }

/* ── TimelineTab / TimelineItem ── */
.timeline .month-heading {
  display: flex; justify-content: space-between; align-items: baseline;
  margin: 1.25rem 0 0.25rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--line);
  font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; color: var(--text-2);
}
.timeline .month:first-child .month-heading { margin-top: 0.25rem; }
.timeline .n { font-weight: 500; color: var(--text-3); font-variant-numeric: tabular-nums; }
.timeline .items { list-style: none; margin: 0; padding: 0; }
.timeline .closed { margin-top: 1.5rem; }
.timeline .closed summary { cursor: pointer; padding: 0.5rem 0; font-size: 0.85rem; font-weight: 600; color: var(--text-2); }
.timeline .closed summary::marker { color: var(--text-3); }
.timeline .empty { margin: 0.25rem 0 0; padding: 1rem; }
.timeline .item { --dot: var(--text-3); position: relative; display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); column-gap: 0.75rem; padding: 0.85rem 0; }
.timeline .item + .item { border-top: 1px solid var(--line); }
/* deadlineState → 색. 상태 외의 용도로 색을 쓰지 않는다. */
.timeline .state-urgent { --dot: var(--red); }
.timeline .state-soon { --dot: var(--orange); }
.timeline .state-upcoming { --dot: var(--blue); }
.timeline .state-closed { --dot: var(--gray); }
.timeline .when { display: flex; flex-direction: column; min-width: 0; }
.timeline .dday { font-size: 1.6rem; font-weight: 800; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--dot); }
.timeline .state-open .dday { color: var(--text); }
.timeline .state-closed .dday { text-decoration: line-through; text-decoration-thickness: 2px; }
.timeline .caption { margin-top: 0.3rem; font-size: 0.72rem; line-height: 1.3; color: var(--text-3); }
.timeline .body { position: relative; min-width: 0; padding-left: 0.85rem; border-left: 2px solid var(--line); }
.timeline .body::before {
  content: ''; position: absolute; left: -6px; top: 0.45rem; width: 10px; height: 10px; border-radius: 50%;
  background: var(--dot); box-shadow: 0 0 0 3px var(--bg);
}
/* 지원 불가는 흐리게만 — 판정이 틀릴 수 있으니 숨기지 않고, 마우스를 올리면 다시 또렷하게. */
.timeline .item.dim { opacity: 0.5; }
.timeline .item.dim:hover, .timeline .item.dim:focus-within { opacity: 1; }
.timeline .title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.5rem; }
.timeline .title { font-size: 1rem; font-weight: 600; color: var(--text); text-decoration: none; }
.timeline a.title:hover { text-decoration: underline; }
.timeline a.title::after { content: ' ↗'; font-size: 0.75em; color: var(--text-3); }
.timeline .state-closed .title { color: var(--text-3); text-decoration: line-through; }
.timeline .title.no-link { cursor: default; }
.timeline .org { margin: 0.1rem 0 0; font-size: 0.8125rem; color: var(--text-2); }
.timeline .amount { color: var(--text-3); }
.timeline .facts { list-style: none; margin: 0.45rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; color: var(--text-2); }
.timeline .facts li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem 0.4rem; }
.timeline .facts strong { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.timeline .status { font-weight: 600; color: var(--text); }
.timeline .overdue, .timeline .overdue strong { color: var(--red); font-weight: 600; }
/* 발표 예정일은 별도 줄의 배지로 — 마감(strong 텍스트)과 시각적으로 혼동되지 않게. */
.timeline .announce { margin-top: 0.1rem; }
.timeline .note { flex-basis: 100%; margin: 0.15rem 0 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.78rem; color: var(--text-3); }
.timeline .verdict { display: flex; flex-direction: column; align-items: flex-start; gap: 0.3rem; margin-top: 0.55rem; }
.timeline .reasons { margin: 0; padding-left: 1.1rem; font-size: 0.78rem; line-height: 1.45; color: var(--text-2); }

/* ── KanbanTab / KanbanColumn ── */
/* 자식 .board가 가로 스크롤을 갖되, 페이지 자체는 절대 넓어지지 않게 */
.kanban { min-width: 0; max-width: 100%; }
.kanban .notice { margin: 0 0 0.75rem; padding: 0.5rem 0.75rem; border: 1px dashed var(--line); border-radius: var(--radius-sm); background: var(--surface); font-size: 0.8rem; color: var(--text-2); }
.kanban .board {
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(200px, 1fr);
  /* 빈 컬럼이 가장 긴 컬럼 높이까지 늘어나 화면을 빈 상자로 채우지 않게 */
  align-items: start; gap: 0.6rem; max-width: 100%; overflow-x: auto; padding-bottom: 0.5rem; scrollbar-gutter: stable;
}
.kanban .results { margin-top: 1rem; }
.kanban .results summary { display: flex; align-items: baseline; gap: 0.5rem; cursor: pointer; padding: 0.5rem 0; font-size: 0.85rem; font-weight: 600; color: var(--text-2); }
.kanban .results summary::marker { color: var(--text-3); }
.kanban .results .count { color: var(--text-3); font-variant-numeric: tabular-nums; }
.kanban .results .hint { font-weight: 500; font-size: 0.75rem; color: var(--text-3); }
.kanban .results .board { margin-top: 0.25rem; }
.kanban .column { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; padding: 0.5rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.kanban .col-head { display: flex; justify-content: space-between; margin: 0; padding: 0.1rem 0.25rem; font-size: 0.8125rem; font-weight: 600; color: var(--text-2); }
.kanban .col-head .count { color: var(--text-3); font-variant-numeric: tabular-nums; }
.kanban .none { margin: 0.5rem 0.25rem; font-size: 0.8rem; color: var(--text-3); }
.kanban .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.kanban .card { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.65rem; background: var(--surface-2); border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--radius-sm); }
/* priority high만 왼쪽 띠로 구분. mid/low는 색 없음. */
.kanban .priority-high { border-left-color: var(--red); }
.kanban .card.overdue { border-color: var(--red); }
.kanban .top { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
.kanban .dday { font-size: 1rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
.kanban .dday.tone-red { color: var(--red); }
.kanban .dday.tone-orange { color: var(--orange); }
.kanban .dday.tone-blue { color: var(--blue); }
.kanban .dday.tone-gray { color: var(--gray); text-decoration: line-through; }
.kanban .dday.missing { font-size: 0.85rem; color: var(--text-3); }
.kanban .title { font-size: 0.9rem; font-weight: 600; line-height: 1.35; color: var(--text); text-decoration: none; }
.kanban a.title:hover { text-decoration: underline; }
/* sourceUrl이 없으면 링크가 아니라 텍스트다 — hover 밑줄도 클릭 가능하다는 오해를 주므로 끈다. */
.kanban .title.no-link { cursor: default; }
.kanban .title.missing { color: var(--text-3); }
.kanban .org { margin: 0; font-size: 0.75rem; color: var(--text-3); }
.kanban .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; font-size: 0.75rem; color: var(--text-2); }
.kanban .owner { display: inline-flex; align-items: center; justify-content: center; min-width: 1.5rem; height: 1.5rem; padding: 0 0.45rem; border-radius: 999px; background: var(--gray-bg); color: var(--text); font-size: 0.7rem; font-weight: 700; }
.kanban .target.overdue { color: var(--red); font-weight: 600; }
.kanban .submitted { color: var(--text-3); }
.kanban .docs { display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem; color: var(--text-2); font-variant-numeric: tabular-nums; }
.kanban .docs-none { color: var(--text-3); }
.kanban .bar { flex: 1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.kanban .fill { display: block; height: 100%; background: var(--green); }
.kanban .fill.partial { background: var(--amber); }
.kanban .alert { margin: 0; font-size: 0.75rem; font-weight: 600; color: var(--red); }
.kanban .note { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.72rem; color: var(--text-3); }

/* ── DocumentsTab ── */
.documents .banner { margin-bottom: 0.9rem; padding: 0.7rem 0.9rem; border: 1px solid var(--red); border-radius: var(--radius); background: var(--red-bg); font-size: 0.85rem; color: var(--text); }
.documents .banner p { margin: 0; }
.documents .banner strong { color: var(--red); }
.documents .banner ul { margin: 0.4rem 0 0; padding-left: 1.1rem; }
.documents .empty { padding: 1rem; }
.documents .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
.documents .doc { padding: 0.7rem 0.85rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
/* 만료·임박은 테두리로도 튀게 */
.documents .expiry-expired { border-color: var(--red); }
.documents .expiry-expiring { border-color: var(--orange); }
.documents .head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.documents .check { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 1.15rem; height: 1.15rem; border: 1.5px solid var(--text-3); border-radius: 4px; font-size: 0.8rem; font-weight: 700; color: var(--bg); }
.documents .check.on { background: var(--green); border-color: var(--green); }
.documents .name { font-weight: 600; color: var(--text); }
.documents .facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.3rem 0.75rem; margin: 0.55rem 0 0; font-size: 0.8125rem; }
.documents .facts dt { color: var(--text-3); white-space: nowrap; }
.documents .facts dd { margin: 0; color: var(--text-2); }
.documents .facts strong { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.documents .alarm, .documents .alarm strong { color: var(--red); }
.documents .expiry-expiring .alarm, .documents .expiry-expiring .alarm strong { color: var(--orange); }
.documents .muted { color: var(--text-3); }
.documents .source { color: var(--text-2); }
.documents .uses { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
.documents .uses li { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.05rem 0.55rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); font-size: 0.75rem; color: var(--text); }
.documents .uses .st { color: var(--text-3); }
.documents .uses .inactive { opacity: 0.6; }
`;
