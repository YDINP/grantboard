/**
 * 공공데이터 자동수집 정규화/병합 순수 함수 모음. 네트워크 접근 절대 금지.
 * 실제 fetch는 scripts/collect.mjs에서만 하고, 이 파일의 함수를 import해서 쓴다.
 *
 * ⚠️ K-Startup Open API(getAnnouncementInformation01)의 정확한 응답 필드 키명은
 * 아직 서비스키가 없어 실호출로 확인하지 못했다. normalizeAnnouncement는 흔히 쓰이는
 * camelCase/snake_case 후보 키를 여러 개 시도하는 방식으로 방어적으로 작성했고,
 * 실호출 후 실제 키를 확인하면 아래 *_KEYS 배열 맨 앞에 실제 키를 추가할 것.
 * (파일 하단 "실호출 검증 필요 목록" 주석 참고)
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

// ── 후보 키 목록 (⚠️ 전부 미확인 — 실호출로 검증 필요) ──────────────────────
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
// ─────────────────────────────────────────────────────────────────────

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

/** title+applyEnd로부터 짧고 결정적인(같은 입력 -> 같은 출력) id suffix를 만든다. 원본에 안정적인 ID가 없을 때 쓴다. */
function deterministicIdSuffix(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 10);
}

/**
 * API 원본 항목(raw) 1건을 programs 스키마 형태로 변환한다.
 * 필수 필드(공고명, 마감일)를 찾지 못하면 program: null과 사유를 반환한다 — 예외를 던지지 않는다.
 * 매핑에 실패한 이유는 reason에 담겨 호출자(scripts/collect.mjs)가 경고로 남길 수 있다.
 */
export function normalizeAnnouncement(raw: unknown, options: NormalizeOptions = {}): NormalizeResult {
  const source = options.source ?? 'k-startup';
  const now = options.now ?? new Date();

  if (!raw || typeof raw !== 'object') {
    return { program: null, reason: '응답 항목이 객체가 아닙니다.' };
  }
  const r = raw as Record<string, unknown>;

  const title = pickString(r, TITLE_KEYS);
  if (!title) {
    return {
      program: null,
      reason: `공고명 필드를 찾지 못해 버림 (시도한 키: ${TITLE_KEYS.join(', ')})`,
    };
  }

  const applyEndRaw = pickString(r, APPLY_END_KEYS);
  const applyEnd = applyEndRaw ? normalizeDateStr(applyEndRaw) : null;
  if (!applyEnd) {
    return {
      program: null,
      reason: `"${title}" — 마감일 필드를 찾지 못했거나 형식을 인식할 수 없어 버림 (원본값: ${applyEndRaw ?? '없음'}, 시도한 키: ${APPLY_END_KEYS.join(', ')})`,
    };
  }

  const applyStartRaw = pickString(r, APPLY_START_KEYS);
  const applyStart = applyStartRaw ? (normalizeDateStr(applyStartRaw) ?? undefined) : undefined;

  const applyEndTimeRaw = pickString(r, APPLY_END_TIME_KEYS);
  const applyEndTime = applyEndTimeRaw && TIME_RE.test(applyEndTimeRaw) ? applyEndTimeRaw : undefined;

  const announceDateRaw = pickString(r, ANNOUNCE_DATE_KEYS);
  const announceDate = announceDateRaw ? (normalizeDateStr(announceDateRaw) ?? undefined) : undefined;

  const organizer = pickString(r, ORGANIZER_KEYS) ?? '기관명 미확인';
  const sourceUrl = pickString(r, URL_KEYS) ?? '#';
  const supportAmount = pickString(r, SUPPORT_AMOUNT_KEYS);

  const idRaw = pickString(r, ID_KEYS);
  const id = idRaw ? `k-startup-${idRaw}` : `k-startup-${deterministicIdSuffix(`${title}|${applyEnd}`)}`;

  return {
    program: {
      id,
      title,
      organizer,
      sourceUrl,
      // ⚠️ 미확인 — K-Startup 응답에 사업유형 분류 필드가 있다면 매핑해야 하지만
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
}

interface MergeOptions {
  now?: Date;
}

// 자동수집 병합 시 갱신 대상이 되는 필드. id/title/source/collectedAt은 병합 로직이 별도로 관리한다.
const UPDATABLE_FIELDS: (keyof ProgramRecord)[] = [
  'organizer',
  'sourceUrl',
  'category',
  'applyStart',
  'applyEnd',
  'applyEndTime',
  'announceDate',
  'supportAmount',
  'tags',
  'eligibility',
];

function exactKey(p: ProgramRecord): string {
  return `${p.title.trim()}|${p.applyEnd}`;
}

function titleKey(p: ProgramRecord): string {
  return p.title.trim();
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
 * 중복 판정은 두 단계다:
 * 1) 공고명+마감일이 완전히 같으면 같은 공고의 재수집으로 보고 다른 변경분(URL 등)만 갱신한다.
 * 2) 완전히 같은 조합이 없더라도, 자동수집 항목 중 공고명이 같은 게 정확히 하나 있으면
 *    "같은 공고인데 마감일이 연장/변경된 경우"로 보고 그 항목을 갱신한다(신규 추가하지 않음).
 *    단, 같은 제목의 자동수집 항목이 이미 여러 건이면(연례 반복 공고 등) 어느 것인지 모호하므로
 *    이 단계는 건너뛰고 신규 추가로 처리한다.
 *
 * `source: 'manual'`인 항목은 위 두 단계 어디서 매칭되든 절대 덮어쓰지 않고 skipped로만 센다.
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

  const rebuildIndexes = () => {
    exactIndex = new Map();
    titleIndex = new Map();
    merged.forEach((p, i) => {
      exactIndex.set(exactKey(p), i);
      if (p.source !== 'manual') {
        const tKey = titleKey(p);
        titleIndex.set(tKey, titleIndex.has(tKey) ? -1 : i);
      }
    });
  };
  rebuildIndexes();

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const incomingProgram of incoming) {
    let targetIndex = exactIndex.get(exactKey(incomingProgram));

    if (targetIndex === undefined) {
      const titleMatch = titleIndex.get(titleKey(incomingProgram));
      if (titleMatch !== undefined && titleMatch !== -1) {
        targetIndex = titleMatch;
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

  return { merged, added, updated, skipped };
}
