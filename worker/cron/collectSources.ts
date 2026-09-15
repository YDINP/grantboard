/**
 * K-Startup Open API(getAnnouncementInformation01) + 기업마당(bizinfo.go.kr) Open API 호출 로직.
 *
 * Worker(worker/cron/collect.ts)와 로컬 수동 실행 스크립트(scripts/collect.mjs)가 이 파일을
 * 공유한다 — 네트워크 호출/재시도/응답 파싱 로직을 두 벌로 유지하지 않기 위함이다.
 * D1이나 Workers 전용 타입(Env, D1Database 등)은 여기서 절대 참조하지 않는다 — 그래야 이 파일이
 * Node 스크립트에서도, Worker에서도 그대로 동작한다. 정규화/병합 순수 함수(src/lib/collect.ts)는
 * 그대로 재사용하고 여기서 다시 짜지 않는다.
 *
 * ⚠️ K-Startup/기업마당 응답 필드·엔드포인트 규격 관련 미확인 사항은 src/lib/collect.ts 상단
 * 주석 및 아래 각 상수 옆 주석을 참고할 것 — 실호출 검증 전까지는 전부 추정치다.
 */

import { normalizeAnnouncement, type ProgramRecord } from '../../src/lib/collect.ts';

// ⚠️ 미확인 — 데이터셋 15125364(K-Startup 사업공고정보) 활용신청 시 안내되는 실제 엔드포인트로
// 교체/확인할 것. 아래는 공공데이터포털의 통상적인 URL 규칙을 따른 추정값이다.
const KSTARTUP_API_ENDPOINT = 'https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01';
const KSTARTUP_PAGE_SIZE = 100;

// ⚠️ 미확인 — 기업마당 Open API 엔드포인트. 팀 리서치 결과이며 실호출로 검증되지 않았다.
const BIZINFO_API_ENDPOINT = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
const BIZINFO_PAGE_SIZE = 100;

const MAX_RETRIES = 3;
const MAX_PAGES = 200; // 무한루프 방지용 안전장치

function backoffMs(attempt: number): number {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 응답 본문 스니펫에 서비스키가 그대로 섞여 나오는 걸 막는다 — 공공데이터 오류 응답이 요청을 에코하는 경우가 있다. */
function scrubServiceKey(text: string, serviceKey: string | undefined): string {
  if (!serviceKey) return text;
  return text.split(serviceKey).join('***');
}

/** 로그에 서비스키를 노출하지 않도록 마스킹된 URL 문자열만 반환한다. */
function redactedUrl(url: URL, paramName: string): string {
  const clone = new URL(url.toString());
  if (clone.searchParams.has(paramName)) clone.searchParams.set(paramName, '***');
  return clone.toString();
}

/** fetch 실패/5xx는 지수 백오프로 최대 MAX_RETRIES회 재시도한다. 429는 즉시 중단한다(요청 한도 초과이므로 재시도해도 악화될 뿐). */
async function fetchJsonWithRetry(url: URL, serviceKey: string): Promise<unknown> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`네트워크 요청이 ${MAX_RETRIES}회 모두 실패했습니다: ${lastError.message}`);
    }

    if (res.status === 429) {
      // 로그에 요청 URL을 그대로 찍지 않는다 — serviceKey 쿼리 파라미터가 노출될 수 있다.
      throw new Error('API 요청 한도 초과(HTTP 429) — 재시도하지 않고 즉시 중단합니다.');
    }

    if (!res.ok) {
      lastError = new Error(`API가 HTTP ${res.status}를 반환했습니다.`);
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // type/dataType 파라미터를 json으로 넣어도 구형 규격 API는 종종 XML을 반환한다. 재시도해도
      // 나아지지 않는 설정 문제이므로 재시도하지 않고 바로 진단 가능한 메시지로 중단한다.
      const snippet = scrubServiceKey(text, serviceKey).slice(0, 200);
      throw new Error(
        `API 응답이 JSON이 아닙니다 — 파라미터나 엔드포인트 규격을 확인하세요. (응답 시작 부분: ${snippet})`,
      );
    }
  }
  throw lastError ?? new Error('알 수 없는 이유로 API 호출에 실패했습니다.');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let cur = value;
  for (const key of path) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[key];
  }
  return cur;
}

/**
 * 공공데이터포털 표준 응답은 흔히 response.body.items.item 형태이지만,
 * ⚠️ 미확인 — K-Startup 서비스가 이 규격을 그대로 따르는지 실호출로 확인 필요.
 * 여러 형태를 관대하게 시도한다.
 */
function extractItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const candidates = [
    getPath(data, ['response', 'body', 'items', 'item']),
    getPath(data, ['response', 'body', 'items']),
    getPath(data, ['data']),
    getPath(data, ['items']),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return [candidate];
  }
  return [];
}

function getTotalCount(data: unknown): number | undefined {
  const candidate = getPath(data, ['response', 'body', 'totalCount']);
  return typeof candidate === 'number' ? candidate : undefined;
}

/**
 * 기업마당 응답에서 항목 배열을 뽑는다. ⚠️ 미확인 — 실제 envelope 구조(jsonArray 등)는
 * 크리덴셜이 없어 검증하지 못했다. K-Startup과 같은 방식으로 여러 후보를 관대하게 시도한다.
 */
function extractBizinfoItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const candidates = [
    getPath(data, ['jsonArray']),
    getPath(data, ['result', 'jsonArray']),
    getPath(data, ['response', 'body', 'items', 'item']),
    getPath(data, ['data']),
    getPath(data, ['items']),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return [candidate];
  }
  return [];
}

/** ⚠️ 미확인 — 기업마당 응답의 총 건수 필드명. 없으면 undefined로 두고 "0건 응답"에만 의존한다. */
function getBizinfoTotalCount(data: unknown): number | undefined {
  const totCnt = getPath(data, ['totCnt']);
  if (typeof totCnt === 'number') return totCnt;
  const totalCount = getPath(data, ['totalCount']);
  if (typeof totalCount === 'number') return totalCount;
  const nested = getPath(data, ['result', 'totCnt']);
  return typeof nested === 'number' ? nested : undefined;
}

async function fetchAllAnnouncements(serviceKey: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const url = new URL(KSTARTUP_API_ENDPOINT);
    url.searchParams.set('serviceKey', serviceKey);
    // ⚠️ 미확인 — 구형 규격(pageNo/numOfRows)으로 가정. 신형 표준 API 규격(page/perPage)이 아니다.
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('numOfRows', String(KSTARTUP_PAGE_SIZE));
    // ⚠️ 미확인 — 구형 규격은 기본 응답이 XML이라 type=json으로 명시해야 한다고 가정.
    url.searchParams.set('type', 'json');

    console.log(`[collect:kstartup] 요청: ${redactedUrl(url, 'serviceKey')}`);
    const data = await fetchJsonWithRetry(url, serviceKey);
    const items = extractItems(data);
    all.push(...items);

    // 종료 조건은 "0건 응답" 또는 "totalCount 도달"만 본다. numOfRows가 서버에서 무시돼
    // PAGE_SIZE보다 적게 오는 경우(예: 강제로 10건씩만 주는 서버)가 있는데, 그걸 "마지막 페이지"로
    // 오인하면 나머지 페이지를 건너뛰고도 에러 없이 성공한 것처럼 보인다 — 그래서
    // `items.length < PAGE_SIZE`는 종료 조건에서 뺐다.
    const totalCount = getTotalCount(data);
    const reachedEnd = items.length === 0 || (totalCount !== undefined && all.length >= totalCount);
    if (reachedEnd) break;
  }
  return all;
}

/**
 * ⚠️ 미확인 — pageUnit/pageIndex 파라미터명, 페이지당 최대 건수, 총 건수 필드명 모두
 * 실호출 없이 리서치만으로 추정했다. K-Startup과 동일한 방어적 종료 조건(0건 응답 또는
 * totalCount 도달)을 쓴다.
 */
async function fetchAllBizinfo(crtfcKey: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
    const url = new URL(BIZINFO_API_ENDPOINT);
    url.searchParams.set('crtfcKey', crtfcKey);
    url.searchParams.set('dataType', 'json');
    url.searchParams.set('pageUnit', String(BIZINFO_PAGE_SIZE));
    url.searchParams.set('pageIndex', String(pageIndex));

    console.log(`[collect:bizinfo] 요청: ${redactedUrl(url, 'crtfcKey')}`);
    const data = await fetchJsonWithRetry(url, crtfcKey);
    const items = extractBizinfoItems(data);
    all.push(...items);

    const totalCount = getBizinfoTotalCount(data);
    const reachedEnd = items.length === 0 || (totalCount !== undefined && all.length >= totalCount);
    if (reachedEnd) break;
  }
  return all;
}

/** dropped 사유를 최대 20건까지 로그로 남긴다. 두 소스가 같은 포맷으로 로그를 남기게 공유한다. */
function logDropped(tag: string, dropped: string[]): void {
  if (dropped.length === 0) return;
  console.warn(`[${tag}] 제외된 항목 사유 (최대 20건 표시):`);
  for (const reason of dropped.slice(0, 20)) console.warn(`  - ${reason}`);
  if (dropped.length > 20) console.warn(`  ... 외 ${dropped.length - 20}건`);
}

/**
 * K-Startup을 호출해 정규화한다. 실패하면 예외를 던진다 — 호출자(runCollect/scripts/collect.mjs)가
 * 소스별로 독립적으로 잡아서 다른 소스 수집을 막지 않게 한다.
 */
export async function collectFromKstartup(
  existing: readonly ProgramRecord[],
  serviceKey: string,
): Promise<ProgramRecord[]> {
  const existingAutoCount = existing.filter((p) => p.source === 'k-startup').length;
  const rawItems = await fetchAllAnnouncements(serviceKey);

  // 수집 건수 이상 감지. 데이터를 지우거나 실패시키지는 않는다 — 그냥 사람이 로그에서 볼 수
  // 있게 뚜렷한 경고만 남긴다. 실제 대응(재시도/조사)은 사람이 판단한다.
  if (rawItems.length === 0) {
    console.warn('[collect:kstartup] ⚠️ 경고: API가 0건을 반환했습니다. 엔드포인트/파라미터 규격을 확인하세요.');
  } else if (existingAutoCount > 0 && rawItems.length < existingAutoCount * 0.5) {
    console.warn(
      `[collect:kstartup] ⚠️ 경고: 수집 건수(${rawItems.length}건)가 기존 자동수집 건수(${existingAutoCount}건) 대비 급감했습니다. 페이지네이션/파라미터 규격을 확인하세요.`,
    );
  }

  const normalized: ProgramRecord[] = [];
  const dropped: string[] = [];
  for (const raw of rawItems) {
    const { program, reason } = normalizeAnnouncement(raw, { source: 'k-startup' });
    if (program) normalized.push(program);
    else dropped.push(reason ?? '알 수 없는 사유');
  }

  console.log(
    `[collect:kstartup] 수집 ${rawItems.length}건 / 정규화 성공 ${normalized.length}건 / 매핑 실패로 제외 ${dropped.length}건`,
  );
  logDropped('collect:kstartup', dropped);

  return normalized;
}

/** 기업마당을 호출해 정규화한다. 실패 시 예외를 던진다 — collectFromKstartup과 동일한 계약. */
export async function collectFromBizinfo(
  existing: readonly ProgramRecord[],
  crtfcKey: string,
): Promise<ProgramRecord[]> {
  const existingAutoCount = existing.filter((p) => p.source === 'bizinfo').length;
  const rawItems = await fetchAllBizinfo(crtfcKey);

  if (rawItems.length === 0) {
    console.warn('[collect:bizinfo] ⚠️ 경고: API가 0건을 반환했습니다. 엔드포인트/파라미터 규격을 확인하세요.');
  } else if (existingAutoCount > 0 && rawItems.length < existingAutoCount * 0.5) {
    console.warn(
      `[collect:bizinfo] ⚠️ 경고: 수집 건수(${rawItems.length}건)가 기존 자동수집 건수(${existingAutoCount}건) 대비 급감했습니다. 페이지네이션/파라미터 규격을 확인하세요.`,
    );
  }

  const normalized: ProgramRecord[] = [];
  const dropped: string[] = [];
  for (const raw of rawItems) {
    const { program, reason } = normalizeAnnouncement(raw, { source: 'bizinfo' });
    if (program) normalized.push(program);
    else dropped.push(reason ?? '알 수 없는 사유');
  }

  console.log(
    `[collect:bizinfo] 수집 ${rawItems.length}건 / 정규화 성공 ${normalized.length}건 / 매핑 실패로 제외 ${dropped.length}건`,
  );
  logDropped('collect:bizinfo', dropped);

  return normalized;
}
