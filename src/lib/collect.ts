/**
 * 공공데이터 자동수집 정규화/병합 순수 함수 모음. 네트워크 접근 절대 금지.
 * 실제 fetch는 scripts/collect.mjs에서만 하고, 이 파일의 함수를 import해서 쓴다.
 *
 * ⚠️ K-Startup Open API(getAnnouncementInformation01)의 정확한 응답 필드 키명은
 * 아직 서비스키가 없어 실호출로 확인하지 못했다. normalizeAnnouncement는 흔히 쓰이는
 * camelCase/snake_case 후보 키를 여러 개 시도하는 방식으로 방어적으로 작성했고,
 * 실호출 후 실제 키를 확인하면 아래 *_KEYS 배열 맨 앞에 실제 키를 추가할 것.
 * (파일 하단 "실호출 검증 필요 목록" 주석 참고)
 *
 * ⚠️ 기업마당(bizinfo.go.kr) Open API(bizinfoApi.do)도 마찬가지로 크리덴셜(crtfcKey)이
 * 없어 실호출로 검증하지 못했다. BIZINFO_* 후보 키 목록도 전부 미확인 추정치다.
 */

import { createHash } from 'node:crypto';

export type ProgramCategory = '정부지원사업' | '공모전' | '경진대회' | '교육프로그램' | '기타';
export type AutoSource = 'k-startup' | 'bizinfo';

/** content.config.ts의 programs 스키마와 호환되는 최소 형태. 수동/자동 항목 공통. */
export interface ProgramRecord {
  id: string;
  title: string;
  organizer: string;
  sourceUrl: string;
  category: ProgramCategory;
  applyStart?: string;
  applyEnd: string;
  applyEndTime?: string;
  announceDate?: string;
  supportAmount?: string;
  tags: string[];
  source: 'manual' | AutoSource;
  collectedAt?: string;
  eligibility?: Record<string, unknown>;
  // manual 행 전용. 자동수집 공고가 이 제목들 중 하나로 들어오면 같은 공고로 보고
  // 신규 추가 대신 이 manual 행을 유지한 채 스킵한다. mergePrograms 참고.
  aliasTitles?: string[];
}

export interface NormalizeResult {
  program: ProgramRecord | null;
  /** program이 null일 때 왜 버렸는지 사람이 읽을 수 있는 한국어 문장. */
  reason?: string;
}

interface NormalizeOptions {
  source?: AutoSource;
  now?: Date;
}

// ── K-Startup 후보 키 목록 (⚠️ 전부 미확인 — 실호출로 검증 필요) ────────────
const TITLE_KEYS = ['bizPbancNm', 'biz_pbanc_nm', 'pbancNm', 'pbanc_nm', 'sj', 'title'];
const ORGANIZER_KEYS = [
  'pbancNtrpNm',
  'pbanc_ntrp_nm',
  'sprvInst',
  'sprv_inst',
  'jrsdInsttNm',
  'organizer',
];
const URL_KEYS = ['detlPgUrl', 'detl_pg_url', 'pblancUrl', 'pblanc_url', 'sourceUrl', 'url'];
const APPLY_START_KEYS = ['pbancRcptBgngDt', 'pbanc_rcpt_bgng_dt', 'reqstBeginDe', 'aplyStartDt'];
const APPLY_END_KEYS = ['pbancRcptEndDt', 'pbanc_rcpt_end_dt', 'reqstEndDe', 'aplyEndDt'];
const APPLY_END_TIME_KEYS = ['pbancRcptEndTm', 'pbanc_rcpt_end_tm', 'aplyEndTm'];
const ANNOUNCE_DATE_KEYS = ['pbancDt', 'pbanc_dt', 'anncDt'];
const SUPPORT_AMOUNT_KEYS = ['sportScale', 'supt_scale', 'sprtScale', 'supportAmount'];
const ID_KEYS = ['pbancSn', 'pbanc_sn', 'pblancId', 'id'];
// K-Startup 응답에는(추정상) 신청기간이 시작/종료 두 필드로 나뉘어 오므로 범위 문자열
// 후보 키가 없다 — 있다면 이 배열은 비워둔 채로 둔다(즉시 discrete 키만 시도).
const APPLY_RANGE_KEYS: string[] = [];
// ─────────────────────────────────────────────────────────────────────

// ── 기업마당(bizinfo) 후보 키 목록 (⚠️ 전부 미확인 — 실호출로 검증 필요) ───
// 공공데이터포털의 다른 유사 API들이 흔히 쓰는 camelCase/snake_case 후보를 관대하게
// 나열했다. 실제 키는 크리덴셜 발급 후 실호출로 반드시 확인할 것.
const BIZINFO_TITLE_KEYS = ['pblancNm', 'pblanc_nm', 'bizPbancNm', 'title'];
const BIZINFO_ORGANIZER_KEYS = ['jrsdInsttNm', 'jrsdInstt_nm', 'excInsttNm', 'organizer'];
const BIZINFO_URL_KEYS = ['pblancUrl', 'pblanc_url', 'rceptEngnHmpgUrl', 'sourceUrl', 'url'];
// 기업마당은 신청기간이 시작/종료로 나뉜 필드로 올 수도, "YYYY-MM-DD ~ YYYY-MM-DD" 같은
// 범위 문자열 한 필드로 올 수도 있다고 알려져 있다(둘 다 미확인). discrete 키를 먼저
// 시도하고, 없으면 applyRange 키로 범위 문자열 파싱을 시도한다.
const BIZINFO_APPLY_START_KEYS = ['reqstBeginDe', 'reqst_begin_de', 'aplyBeginDe'];
const BIZINFO_APPLY_END_KEYS = ['reqstEndDe', 'reqst_end_de', 'aplyEndDe'];
const BIZINFO_APPLY_RANGE_KEYS = ['reqstBeginEndDe', 'reqst_begin_end_de', 'reqstPd', 'aplyPd'];
const BIZINFO_APPLY_END_TIME_KEYS = ['reqstEndTm', 'reqst_end_tm'];
const BIZINFO_ANNOUNCE_DATE_KEYS = ['pblancDe', 'pblanc_de', 'creatPnttm'];
const BIZINFO_SUPPORT_AMOUNT_KEYS = ['sprtSclNm', 'sprt_scl_nm', 'supportAmount'];
const BIZINFO_ID_KEYS = ['pblancId', 'pblanc_id', 'id'];
// ─────────────────────────────────────────────────────────────────────

interface SourceKeySet {
  title: string[];
  organizer: string[];
  url: string[];
  applyStart: string[];
  applyEnd: string[];
  applyRange: string[];
  applyEndTime: string[];
  announceDate: string[];
  supportAmount: string[];
  id: string[];
}

const KEY_SETS: Record<AutoSource, SourceKeySet> = {
  'k-startup': {
    title: TITLE_KEYS,
    organizer: ORGANIZER_KEYS,
    url: URL_KEYS,
    applyStart: APPLY_START_KEYS,
    applyEnd: APPLY_END_KEYS,
    applyRange: APPLY_RANGE_KEYS,
    applyEndTime: APPLY_END_TIME_KEYS,
    announceDate: ANNOUNCE_DATE_KEYS,
    supportAmount: SUPPORT_AMOUNT_KEYS,
    id: ID_KEYS,
  },
  bizinfo: {
    title: BIZINFO_TITLE_KEYS,
    organizer: BIZINFO_ORGANIZER_KEYS,
    url: BIZINFO_URL_KEYS,
    applyStart: BIZINFO_APPLY_START_KEYS,
    applyEnd: BIZINFO_APPLY_END_KEYS,
    applyRange: BIZINFO_APPLY_RANGE_KEYS,
    applyEndTime: BIZINFO_APPLY_END_TIME_KEYS,
    announceDate: BIZINFO_ANNOUNCE_DATE_KEYS,
    supportAmount: BIZINFO_SUPPORT_AMOUNT_KEYS,
    id: BIZINFO_ID_KEYS,
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function pickString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * 'YYYYMMDD' / 'YYYY.MM.DD' / 'YYYY/MM/DD' / 'YYYY-MM-DD' 등 흔한 공공데이터 날짜 표기를
 * content.config.ts가 요구하는 'YYYY-MM-DD'로 정규화한다. 이건 형식 파싱일 뿐 KST 날짜 연산이
 * 아니므로 schedule.ts를 건드리지 않고 여기서 처리한다.
 */
function normalizeDateStr(input: string): string | null {
  const trimmed = input.trim();
  if (DATE_RE.test(trimmed)) return isValidCalendarDate(trimmed) ? trimmed : null;

  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const candidate = `${compact[1]}-${compact[2]}-${compact[3]}`;
    return isValidCalendarDate(candidate) ? candidate : null;
  }

  const dotted = trimmed.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})$/);
  if (dotted) {
    const candidate = `${dotted[1]}-${dotted[2].padStart(2, '0')}-${dotted[3].padStart(2, '0')}`;
    return isValidCalendarDate(candidate) ? candidate : null;
  }

  return null;
}

function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * "2026-09-01 ~ 2026-10-15" 같은 한 필드짜리 신청기간 범위 문자열을 시작/종료로 나눈다.
 * 구분자는 '~' 하나만 인정한다(관대하게 다른 구분자까지 받으면 엉뚱한 문자열도 날짜로
 * 오인할 위험이 커진다). 양쪽 다 유효한 날짜로 파싱될 때만 결과를 반환하고, 하나라도
 * 실패하면 null을 반환한다 — 시작일만 버리고 종료일만 살리는 식의 부분 성공은 하지 않는다
 * (잘못된 날짜로 D-day가 틀리는 것보다, 항목 전체를 버리는 게 낫다).
 */
function parseApplyRange(input: string): { start: string; end: string } | null {
  const parts = input.split('~');
  if (parts.length !== 2) return null;

  const start = normalizeDateStr(parts[0].trim());
  const end = normalizeDateStr(parts[1].trim());
  if (!start || !end) return null;

  return { start, end };
}

/** title+applyEnd로부터 짧고 결정적인(같은 입력 -> 같은 출력) id suffix를 만든다. 원본에 안정적인 ID가 없을 때 쓴다. */
function deterministicIdSuffix(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 10);
}

/**
 * API 원본 항목(raw) 1건을 programs 스키마 형태로 변환한다. source 옵션(기본 'k-startup')에
 * 따라 KEY_SETS에서 후보 키 목록을 골라 쓴다 — 소스별 분기는 이 키 선택 하나뿐이고, 나머지
 * 파싱/검증 로직은 공유한다.
 * 필수 필드(공고명, 마감일)를 찾지 못하면 program: null과 사유를 반환한다 — 예외를 던지지 않는다.
 * 매핑에 실패한 이유는 reason에 담겨 호출자(scripts/collect.mjs)가 경고로 남길 수 있다.
 */
export function normalizeAnnouncement(raw: unknown, options: NormalizeOptions = {}): NormalizeResult {
  const source = options.source ?? 'k-startup';
  const now = options.now ?? new Date();
  const keys = KEY_SETS[source];

  if (!raw || typeof raw !== 'object') {
    return { program: null, reason: '응답 항목이 객체가 아닙니다.' };
  }
  const r = raw as Record<string, unknown>;

  const title = pickString(r, keys.title);
  if (!title) {
    return {
      program: null,
      reason: `공고명 필드를 찾지 못해 버림 (시도한 키: ${keys.title.join(', ')})`,
    };
  }

  // 마감일: discrete 키를 먼저 시도하고, 없으면 신청기간 범위 문자열(있는 소스만)을 시도한다.
  const applyEndRaw = pickString(r, keys.applyEnd);
  let applyEnd = applyEndRaw ? normalizeDateStr(applyEndRaw) : null;
  let applyStart: string | undefined;
  let rangeRaw: string | undefined;
  let rangeParseFailed = false;

  const applyStartRaw = pickString(r, keys.applyStart);
  applyStart = applyStartRaw ? (normalizeDateStr(applyStartRaw) ?? undefined) : undefined;

  if (!applyEnd && keys.applyRange.length > 0) {
    rangeRaw = pickString(r, keys.applyRange);
    if (rangeRaw) {
      const parsed = parseApplyRange(rangeRaw);
      if (parsed) {
        applyStart = applyStart ?? parsed.start;
        applyEnd = parsed.end;
      } else {
        rangeParseFailed = true;
      }
    }
  }

  if (!applyEnd) {
    const reason = rangeParseFailed
      ? `"${title}" — 신청기간 범위 필드("${rangeRaw}")의 형식을 인식할 수 없어 버림 (시도한 키: ${keys.applyRange.join(', ')})`
      : `"${title}" — 마감일 필드를 찾지 못했거나 형식을 인식할 수 없어 버림 (원본값: ${applyEndRaw ?? '없음'}, 시도한 키: ${[...keys.applyEnd, ...keys.applyRange].join(', ')})`;
    return { program: null, reason };
  }

  const applyEndTimeRaw = pickString(r, keys.applyEndTime);
  const applyEndTime = applyEndTimeRaw && TIME_RE.test(applyEndTimeRaw) ? applyEndTimeRaw : undefined;

  const announceDateRaw = pickString(r, keys.announceDate);
  const announceDate = announceDateRaw ? (normalizeDateStr(announceDateRaw) ?? undefined) : undefined;

  const organizer = pickString(r, keys.organizer) ?? '기관명 미확인';
  const sourceUrl = pickString(r, keys.url) ?? '#';
  const supportAmount = pickString(r, keys.supportAmount);

  const idRaw = pickString(r, keys.id);
  const id = idRaw ? `${source}-${idRaw}` : `${source}-${deterministicIdSuffix(`${title}|${applyEnd}`)}`;

  return {
    program: {
      id,
      title,
      organizer,
      sourceUrl,
      // ⚠️ 미확인 — K-Startup/기업마당 응답에 사업유형 분류 필드가 있다면 매핑해야 하지만
      // 키를 모르므로 일단 기본값으로 고정한다. 실호출 후 실제 분류 필드를 확인할 것.
      category: '정부지원사업',
      applyStart,
      applyEnd,
      applyEndTime,
      announceDate,
      supportAmount,
      tags: [],
      source,
      collectedAt: now.toISOString(),
    },
  };
}

export interface MergeStats {
  merged: ProgramRecord[];
  added: number;
  updated: number;
  skipped: number;
  /**
   * manual 행의 aliasTitles와 매칭돼 신규 추가 대신 스킵된 자동수집 항목 상세.
   * skipped 카운트에도 포함되어 있다 — 이건 "왜" 스킵됐는지 사람이 로그로 볼 수 있게 별도로 남기는 것.
   */
  aliasSkips: { manualTitle: string; incomingTitle: string }[];
}

interface MergeOptions {
  now?: Date;
}

// 자동수집 병합 시 갱신 대상이 되는 필드. id/title/source/collectedAt은 병합 로직이 별도로 관리한다.
//
// ⚠️ category/tags는 여기 넣지 않는다. normalizeAnnouncement는 원본 API에 분류 필드가
// 무엇인지 몰라 항상 category: '정부지원사업', tags: []라는 기본값만 채운다. 이 필드들이
// UPDATABLE_FIELDS에 있으면, 팀이 실제 값으로 수동 수정해도(category: '경진대회' 등) 다음날
// 크론이 그 기본값으로 되돌려버린다 — 되돌린 사실이 커밋 로그("자동수집 갱신")에도 드러나지
// 않아 발견하기 어렵다. 자동수집은 최초 생성 시에만 기본값을 채우고, 이후 사람이 고친 값은
// 절대 건드리지 않는다.
const UPDATABLE_FIELDS: (keyof ProgramRecord)[] = [
  'organizer',
  'sourceUrl',
  'applyStart',
  'applyEnd',
  'applyEndTime',
  'announceDate',
  'supportAmount',
  'eligibility',
];

function exactKey(p: ProgramRecord): string {
  return `${p.title.trim()}|${p.applyEnd}`;
}

function titleKey(p: ProgramRecord): string {
  return p.title.trim();
}

// 퍼지 제목 매칭에 쓸 정규화 후 최소 길이. 정규화 후 이보다 짧으면(예: 흔한 단어 하나만
// 남는 경우) 서로 무관한 공고를 우연히 같은 키로 묶을 위험이 커서 매칭 후보에서 제외한다.
const MIN_FUZZY_TITLE_LEN = 6;

/**
 * 괄호(반각/전각) 안의 내용이 "순수 연도"일 때만 제거한다. 지역/회차 등 의미 있는 괄호
 * 내용(예: "OO사업(서울)")은 남긴다 — 잘못 지우면 서로 다른 공고가 같은 것으로 합쳐진다.
 */
function stripYearOnlyBrackets(s: string): string {
  return s.replace(/[（(]\s*\d{4}\s*년?\s*[）)]/g, '');
}

/**
 * K-Startup/기업마당이 같은 공고를 다른 표기로 줄 때(선행 연도 유무, 괄호 안 연도 표기,
 * 공백 개수 차이 등) mergePrograms가 같은 공고로 인식할 수 있게 제목을 정규화한다.
 * 의도적으로 보수적이다 — 연도/공백 같은 "명백히 부가적인" 표기만 제거하고, 그 외
 * 텍스트(지역, 회차, 대상 등 실제 공고를 구분 짓는 정보일 수 있는 내용)는 그대로 둔다.
 * 애매한 경우 정규화하지 않고 원문 그대로 남겨, 다른 공고가 잘못 합쳐지느니 중복으로
 * 남는 쪽을 택한다.
 */
function normalizeTitleForFuzzyMatch(title: string): string {
  let t = title.trim();
  t = t.replace(/^\d{4}\s*년?\s*/, ''); // 선행 연도 접두사 제거 (예: "2026년 ", "2026 ")
  t = stripYearOnlyBrackets(t);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function applyUpdates(current: ProgramRecord, incoming: ProgramRecord): { changed: boolean; next: ProgramRecord } {
  let changed = false;
  const currentRecord = current as unknown as Record<string, unknown>;
  const incomingRecord = incoming as unknown as Record<string, unknown>;
  const nextRecord: Record<string, unknown> = { ...currentRecord };
  for (const field of UPDATABLE_FIELDS) {
    const incomingValue = incomingRecord[field];
    if (incomingValue === undefined) continue;
    if (JSON.stringify(incomingValue) !== JSON.stringify(currentRecord[field])) {
      nextRecord[field] = incomingValue;
      changed = true;
    }
  }
  return { changed, next: nextRecord as unknown as ProgramRecord };
}

/**
 * 기존 programs 배열에 자동수집분을 병합한다.
 *
 * 중복 판정은 네 단계다:
 * 1) 공고명+마감일이 완전히 같으면 같은 공고의 재수집으로 보고 다른 변경분(URL 등)만 갱신한다.
 * 2) manual 행의 aliasTitles 중 하나와 공고명이 일치하면, 공식 명칭이 다르게 들어온 같은 공고로
 *    보고 그 manual 행으로 매칭한다(마감일 일치 여부는 보지 않는다 — alias는 사람이 직접 지정한
 *    확실한 매칭이므로).
 * 3) 위 둘 다 아니면, 자동수집 항목 중 공고명이 같은 게 정확히 하나 있으면
 *    "같은 공고인데 마감일이 연장/변경된 경우"로 보고 그 항목을 갱신한다(신규 추가하지 않음).
 *    단, 같은 제목의 자동수집 항목이 이미 여러 건이면(연례 반복 공고 등) 어느 것인지 모호하므로
 *    이 단계는 건너뛰고 신규 추가로 처리한다.
 * 4) 위 셋 다 아니면, 정규화한 제목(normalizeTitleForFuzzyMatch — 선행 연도/괄호 안 연도만
 *    제거)이 같은 자동수집 항목이 정확히 하나 있으면 같은 공고로 보고 갱신한다. K-Startup과
 *    기업마당이 같은 공고를 다른 표기(연도 유무 등)로 줄 때를 위한 단계다. 3)과 마찬가지로
 *    정규화된 제목이 2건 이상과 겹치면 모호하므로 건너뛴다. manual 행은 이 단계의 매칭 후보에서
 *    제외된다 — manual과의 매칭은 alias(2단계)로만 한다.
 *
 * `source: 'manual'`인 항목은 위 단계 어디서 매칭되든 절대 덮어쓰지 않고 skipped로만 센다.
 * alias로 매칭되어 스킵된 경우는 aliasSkips에도 상세가 남는다(호출자가 로그로 남길 수 있게).
 * incoming이 비어 있으면 아무것도 하지 않는다 — API가 일시적으로 빈 배열을 줘도 기존 데이터가
 * 지워지지 않는다.
 */
export function mergePrograms(
  existing: ProgramRecord[],
  incoming: ProgramRecord[],
  options: MergeOptions = {},
): MergeStats {
  const now = options.now ?? new Date();
  const merged: ProgramRecord[] = existing.map((p) => ({ ...p }));

  let exactIndex = new Map<string, number>();
  let titleIndex = new Map<string, number>(); // -1 = 동일 제목 자동수집 항목이 2건 이상이라 모호함
  let fuzzyTitleIndex = new Map<string, number>(); // -1 = 정규화 후 동일 제목이 2건 이상이라 모호함
  let aliasIndex = new Map<string, number>(); // manual 행의 aliasTitles -> 그 manual 행 인덱스

  const rebuildIndexes = () => {
    exactIndex = new Map();
    titleIndex = new Map();
    fuzzyTitleIndex = new Map();
    aliasIndex = new Map();
    merged.forEach((p, i) => {
      exactIndex.set(exactKey(p), i);
      if (p.source !== 'manual') {
        const tKey = titleKey(p);
        titleIndex.set(tKey, titleIndex.has(tKey) ? -1 : i);

        const fKey = normalizeTitleForFuzzyMatch(p.title);
        if (fKey.length >= MIN_FUZZY_TITLE_LEN) {
          fuzzyTitleIndex.set(fKey, fuzzyTitleIndex.has(fKey) ? -1 : i);
        }
      } else {
        for (const alias of p.aliasTitles ?? []) {
          aliasIndex.set(alias.trim(), i);
        }
      }
    });
  };
  rebuildIndexes();

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const aliasSkips: { manualTitle: string; incomingTitle: string }[] = [];

  for (const incomingProgram of incoming) {
    let targetIndex = exactIndex.get(exactKey(incomingProgram));
    let aliasMatchedManualTitle: string | undefined;

    if (targetIndex === undefined) {
      const aliasMatch = aliasIndex.get(titleKey(incomingProgram));
      if (aliasMatch !== undefined) {
        targetIndex = aliasMatch;
        aliasMatchedManualTitle = merged[aliasMatch].title;
      }
    }

    if (targetIndex === undefined) {
      const titleMatch = titleIndex.get(titleKey(incomingProgram));
      if (titleMatch !== undefined && titleMatch !== -1) {
        targetIndex = titleMatch;
      }
    }

    if (targetIndex === undefined) {
      const fKey = normalizeTitleForFuzzyMatch(incomingProgram.title);
      if (fKey.length >= MIN_FUZZY_TITLE_LEN) {
        const fuzzyMatch = fuzzyTitleIndex.get(fKey);
        if (fuzzyMatch !== undefined && fuzzyMatch !== -1) {
          targetIndex = fuzzyMatch;
        }
      }
    }

    if (targetIndex === undefined) {
      merged.push({ ...incomingProgram, collectedAt: incomingProgram.collectedAt ?? now.toISOString() });
      added += 1;
      rebuildIndexes();
      continue;
    }

    const current = merged[targetIndex];
    if (current.source === 'manual') {
      skipped += 1;
      if (aliasMatchedManualTitle !== undefined) {
        aliasSkips.push({ manualTitle: aliasMatchedManualTitle, incomingTitle: incomingProgram.title });
      }
      continue;
    }

    const { changed, next } = applyUpdates(current, incomingProgram);
    if (changed) {
      merged[targetIndex] = { ...next, collectedAt: now.toISOString() };
      updated += 1;
      rebuildIndexes();
    } else {
      skipped += 1;
    }
  }

  return { merged, added, updated, skipped, aliasSkips };
}
