/**
 * 달력 페이지의 브라우저 스크립트 진입점. Astro 컴포넌트 4개(index 탭·ScheduleTab 보기 전환·
 * FilterBar·CalendarView)의 <script>를 한 파일로 합친 것이다.
 *
 * 이 파일은 Worker에서 실행되지 않는다. `worker/web/buildClient.ts`가 esbuild로 IIFE 번들을 만들어
 * `clientBundle.generated.ts`에 문자열로 박아 넣고, page.ts가 그 문자열을 <script>에 인라인한다.
 * 확장자가 .mts인 이유: worker/tsconfig.json(모든 .ts 포함, DOM lib 없음)에 잡히지 않게 하기 위해서다.
 * 타입체크는 이 디렉터리의 tsconfig.json(DOM lib)으로 따로 한다.
 *
 * 필터 판정은 src/lib/filters.ts를 **그대로 import**한다 — 서버가 data-f-* 속성을 만들 때 쓴 함수와
 * 같은 코드가 번들에 들어가므로 "N건 표시 중"과 실제로 보이는 개수가 어긋날 수 없다.
 *
 * 원칙: 상태 전환은 hidden 속성 토글(style.display 금지). localStorage는 전부 try/catch.
 * 브라우저에서 날짜 계산을 한 줄도 하지 않는다 — 서버가 만든 data-* 속성만 읽는다(KST 단일 소스).
 */

import {
  countSelections,
  DEFAULT_FILTER,
  isFilterActive,
  matchesFilter,
  parseFilterState,
  readAttrs,
  type FilterFacets,
  type FilterState,
} from '../../../src/lib/filters.ts';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 프라이빗 모드 등으로 저장이 막혀도 전환 자체는 정상 동작한다.
  }
}

// ── 탭 전환: hidden 토글. 선택한 탭은 기억하되, 값이 없거나 못 읽으면 마크업 기본(첫 탭)이 그대로 보인다. ──
function initTabs(): void {
  const STORAGE_KEY = 'grantboard.tab';
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"][data-panel]'));
  if (tabs.length === 0) return;

  function select(name: string): void {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.panel !== name;
    }
  }

  const saved = storageGet(STORAGE_KEY);
  if (saved && tabs.some((tab) => tab.dataset.tab === saved)) select(saved);

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      if (!name) return;
      select(name);
      storageSet(STORAGE_KEY, name);
    });

    // 키보드: 좌우 화살표로 탭 이동 (WAI-ARIA tabs 패턴)
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });
}

// ── 일정 탭: 캘린더 | 타임라인 보기 전환. 어느 보기를 보고 있었는지 기억한다(기본: 캘린더). ──
function initScheduleView(): void {
  const STORAGE_KEY = 'grantboard.scheduleView';
  const root = document.querySelector<HTMLElement>('[data-schedule]');
  if (!root) return;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-view]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-view-panel]'));

  function select(name: string): void {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.view === name));
    for (const p of panels) p.hidden = p.dataset.viewPanel !== name;
  }

  const saved = storageGet(STORAGE_KEY);
  if (saved && buttons.some((b) => b.dataset.view === saved)) select(saved);

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const name = button.dataset.view;
      if (!name) return;
      select(name);
      storageSet(STORAGE_KEY, name);
    });
  }
}

// ── 필터 바: [data-filterable] 요소의 hidden 토글. 캘린더 칩·상세 항목·타임라인 항목이 전부 같은 규칙. ──
function initFilterBar(): void {
  const STORAGE_KEY = 'grantboard.filters';
  const OPEN_KEY = 'grantboard.filterOpen';

  const barEl = document.querySelector<HTMLElement>('[data-filter-bar]');
  if (!barEl) return;
  const bar = barEl;
  const form = bar.querySelector<HTMLFormElement>('[data-filter-form]');
  const panel = bar.querySelector<HTMLDetailsElement>('[data-filter-panel]');
  const status = bar.querySelector<HTMLElement>('[data-filter-status]');
  const badge = bar.querySelector<HTMLElement>('[data-filter-badge]');
  const clearBtn = bar.querySelector<HTMLButtonElement>('[data-filter-clear]');
  const total = Number(bar.dataset.total) || 0;

  // 필터 대상은 일정 탭 패널 안의 [data-filterable] 전부(칩·상세 항목·타임라인 항목).
  const scope = bar.closest<HTMLElement>('[data-filter-scope]') ?? document.body;
  const items = Array.from(scope.querySelectorAll<HTMLElement>('[data-filterable]'));
  const programs = items.filter((el) => el.dataset.role === 'program');
  const autoHide = Array.from(scope.querySelectorAll<HTMLElement>('[data-auto-hide]'));
  const emptyNotes = Array.from(scope.querySelectorAll<HTMLElement>('[data-filter-empty]'));
  const summaryNote = document.querySelector<HTMLElement>('[data-filter-note]');

  const inputs = form ? Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) : [];
  const valuesOf = (name: string) => inputs.filter((i) => i.name === name).map((i) => i.value);
  // 선택지는 DOM에 그려진 것이 곧 데이터에 있는 값이다 — 저장된 상태를 검증할 때 이걸 기준으로 쓴다.
  const facets: FilterFacets = {
    categories: valuesOf('category'),
    statuses: valuesOf('status'),
    owners: valuesOf('owner'),
    verdicts: valuesOf('verdict') as FilterFacets['verdicts'],
    hasClosed: inputs.some((i) => i.name === 'hideClosed'),
  };

  function readForm(): FilterState {
    const picked = (name: string) => inputs.filter((i) => i.name === name && i.checked).map((i) => i.value);
    const hide = inputs.find((i) => i.name === 'hideClosed');
    return {
      category: picked('category'),
      status: picked('status'),
      owner: picked('owner'),
      verdict: picked('verdict') as FilterState['verdict'],
      hideClosed: hide ? hide.checked : DEFAULT_FILTER.hideClosed,
    };
  }

  function writeForm(state: FilterState): void {
    for (const input of inputs) {
      if (input.name === 'hideClosed') input.checked = state.hideClosed;
      else input.checked = (state[input.name as keyof Omit<FilterState, 'hideClosed'>] as string[]).includes(input.value);
    }
  }

  function apply(state: FilterState): void {
    for (const el of items) {
      el.hidden = !matchesFilter(readAttrs(el.dataset), state);
    }
    for (const box of autoHide) {
      const visible = box.querySelectorAll('[data-filterable]:not([hidden])').length;
      box.hidden = visible === 0;
      const countEl = box.querySelector<HTMLElement>('[data-visible-count]');
      if (countEl) countEl.textContent = String(visible);
    }

    const shown = programs.filter((el) => !el.hidden).length;
    const active = isFilterActive(state);
    // 마감 숨김(기본값)으로만 빠진 건수 — "왜 3건인데 2건만 보이지"를 설명한다.
    const hiddenClosed = state.hideClosed
      ? programs.filter((el) => {
          const attrs = readAttrs(el.dataset);
          return attrs.closed && matchesFilter(attrs, { ...state, hideClosed: false });
        }).length
      : 0;

    if (status) {
      const note = hiddenClosed > 0 ? ` · 마감 ${hiddenClosed}건 숨김` : '';
      if (total === 0) status.textContent = '등록된 공고 없음';
      else if (shown === 0) status.textContent = `필터에 걸리는 항목이 없습니다 (전체 ${total}건${note})`;
      else if (shown === total) status.textContent = `전체 ${total}건 표시 중`;
      else status.textContent = `${shown}건 표시 중 (전체 ${total}건${note})`;
    }
    bar.classList.toggle('active', active);
    bar.classList.toggle('none', total > 0 && shown === 0);
    if (badge) {
      const n = countSelections(state);
      badge.hidden = n === 0;
      badge.textContent = String(n);
    }
    if (clearBtn) clearBtn.hidden = !active;
    for (const note of emptyNotes) note.hidden = !(total > 0 && shown === 0);
    if (summaryNote) summaryNote.hidden = !active;

    document.dispatchEvent(new CustomEvent('grantboard:filterchange', { detail: state }));
  }

  function recall(): FilterState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return parseFilterState(raw ? JSON.parse(raw) : null, facets);
    } catch {
      return { ...DEFAULT_FILTER };
    }
  }

  const initial = recall();
  writeForm(initial);
  apply(initial);

  form?.addEventListener('change', () => {
    const state = readForm();
    apply(state);
    storageSet(STORAGE_KEY, JSON.stringify(state));
  });

  clearBtn?.addEventListener('click', () => {
    const state = { ...DEFAULT_FILTER };
    writeForm(state);
    apply(state);
    storageSet(STORAGE_KEY, JSON.stringify(state));
  });

  // 패널 펼침 상태도 기억한다 — 매일 여는 도구라 매번 다시 펼치게 하면 귀찮다.
  if (panel) {
    if (storageGet(OPEN_KEY) === '1') panel.open = true;
    panel.addEventListener('toggle', () => storageSet(OPEN_KEY, panel.open ? '1' : '0'));
  }
}

// ── 캘린더: 달 전환·날짜 상세·"+N" 접기. 날짜 계산은 하지 않는다 — 서버가 만든 data 속성만 읽는다. ──
function initCalendar(): void {
  const root = document.querySelector<HTMLElement>('[data-calendar]');
  if (!root) return;
  const months = Array.from(root.querySelectorAll<HTMLElement>('[data-month]'));
  const label = root.querySelector<HTMLElement>('[data-cal-label]');
  const count = root.querySelector<HTMLElement>('[data-cal-count]');
  const prev = root.querySelector<HTMLButtonElement>('[data-cal-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-cal-next]');
  const todayBtn = root.querySelector<HTMLButtonElement>('[data-cal-today]');
  const todayKey = root.dataset.todayMonth ?? '';
  const maxVisible = Number(root.dataset.maxVisible) || 3;

  const todayIndex = () =>
    Math.max(
      0,
      months.findIndex((m) => m.dataset.month === todayKey),
    );
  let index = todayIndex();

  function updateMonthCount(): void {
    const current = months[index];
    if (!count || !current) return;
    const chips = Array.from(current.querySelectorAll<HTMLElement>('.chip'));
    const shown = chips.filter((c) => !c.hidden).length;
    const hidden = chips.length - shown;
    count.textContent = hidden > 0 ? `일정 ${shown}건 · 필터로 ${hidden}건 숨김` : `일정 ${shown}건`;
  }

  function showMonth(i: number): void {
    index = Math.min(Math.max(i, 0), months.length - 1);
    months.forEach((m, j) => (m.hidden = j !== index));
    const current = months[index];
    if (label && current) label.textContent = current.dataset.label ?? '';
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === months.length - 1;
    if (todayBtn) todayBtn.disabled = current?.dataset.month === todayKey;
    updateMonthCount();
  }

  /** 필터 결과에 맞춰 칸마다 보이는 칩을 maxVisible개로 자르고 "+N"을 갱신한다. 이번 달 집계도 여기서. */
  function layoutCells(): void {
    for (const cell of root!.querySelectorAll<HTMLElement>('[data-cell]')) {
      const chips = Array.from(cell.querySelectorAll<HTMLElement>('.chip'));
      const visible = chips.filter((c) => !c.hidden);
      visible.forEach((c, i) => c.classList.toggle('overflow', i >= maxVisible));
      const more = cell.querySelector<HTMLButtonElement>('.more');
      if (more) {
        const extra = Math.max(visible.length - maxVisible, 0);
        more.hidden = extra === 0;
        more.textContent = `+${extra}`;
        more.setAttribute('aria-label', `${cell.dataset.cell} 일정 ${extra}건 더 보기`);
      }
    }
    updateMonthCount();
  }

  // ── 날짜 상세 패널 ──
  const details = root.querySelector<HTMLElement>('[data-day-details]');
  const days = Array.from(root.querySelectorAll<HTMLElement>('[data-day]'));
  const emptyPanel = root.querySelector<HTMLElement>('[data-day-empty]');
  const emptyDate = root.querySelector<HTMLElement>('[data-day-empty-date]');
  let selectedDate: string | null = null;

  /** 상세 패널 안에서 필터로 가려진 항목 수를 알려 준다 — "일정이 없다"로 오해하지 않게. */
  function refreshDayFilterNote(day: HTMLElement): void {
    const entries = Array.from(day.querySelectorAll<HTMLElement>('.entry'));
    const hidden = entries.filter((e) => e.hidden).length;
    const note = day.querySelector<HTMLElement>('[data-day-filtered]');
    const hiddenCount = day.querySelector<HTMLElement>('[data-day-hidden-count]');
    const visibleCount = day.querySelector<HTMLElement>('[data-visible-count]');
    if (note) note.hidden = hidden === 0;
    if (hiddenCount) hiddenCount.textContent = String(hidden);
    if (visibleCount) visibleCount.textContent = String(entries.length - hidden);
  }

  function setPressed(date: string | null): void {
    for (const btn of root!.querySelectorAll<HTMLElement>('[data-day-button]')) {
      btn.setAttribute('aria-pressed', String(date !== null && btn.dataset.date === date));
    }
    for (const cell of root!.querySelectorAll<HTMLElement>('[data-cell]')) {
      cell.classList.toggle('selected', date !== null && cell.dataset.cell === date);
    }
  }

  function openDay(date: string): void {
    selectedDate = date;
    let target: HTMLElement | null = null;
    for (const day of days) {
      const match = day.dataset.day === date;
      day.hidden = !match;
      if (match) target = day;
    }
    if (emptyPanel) emptyPanel.hidden = target !== null;
    if (!target && emptyDate) emptyDate.textContent = date;
    if (target) refreshDayFilterNote(target);
    setPressed(date);
    details?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function closeDay(): void {
    selectedDate = null;
    for (const day of days) day.hidden = true;
    if (emptyPanel) emptyPanel.hidden = true;
    setPressed(null);
  }

  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dayButton = target.closest<HTMLElement>('[data-day-button]');
    if (dayButton?.dataset.date) {
      openDay(dayButton.dataset.date);
      return;
    }
    const chip = target.closest<HTMLElement>('.chip');
    if (chip?.dataset.date) {
      openDay(chip.dataset.date);
      return;
    }
    if (target.closest('[data-day-close]')) closeDay();
  });

  prev?.addEventListener('click', () => showMonth(index - 1));
  next?.addEventListener('click', () => showMonth(index + 1));
  todayBtn?.addEventListener('click', () => showMonth(todayIndex()));

  // FilterBar가 hidden을 바꾼 뒤 알려 주면 "+N"과 집계를 다시 계산한다.
  document.addEventListener('grantboard:filterchange', () => {
    layoutCells();
    if (selectedDate) {
      const day = days.find((d) => d.dataset.day === selectedDate);
      if (day) refreshDayFilterNote(day);
    }
  });

  showMonth(index);
  layoutCells();
}

initTabs();
initScheduleView();
initFilterBar();
initCalendar();
