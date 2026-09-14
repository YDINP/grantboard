#!/usr/bin/env node
/**
 * K-Startup Open API(getAnnouncementInformation01) + 기업마당(bizinfo.go.kr) Open API를
 * 호출해 data/programs.json을 갱신한다.
 * 네트워크 호출은 이 파일에서만 한다 — 정규화/병합 로직(src/lib/collect.ts)은 순수 함수로 유지한다.
 *
 * 사용법:
 *   DATA_GO_KR_KEY=발급받은키 node scripts/collect.mjs
 *   DATA_GO_KR_KEY=발급받은키 BIZINFO_CRTFC_KEY=발급받은키 node scripts/collect.mjs
 *   node scripts/collect.mjs --dry-run                # 파일에 쓰지 않고 요약만 출력
 *   node scripts/collect.mjs --source=kstartup         # K-Startup만 실행 (kstartup|bizinfo|all, 기본 all)
 *
 * 소스별 독립 실행: 한 소스의 서비스키가 없거나 호출이 실패해도 다른 소스의 수집은 계속
 * 진행한다. BIZINFO_CRTFC_KEY가 없으면 기업마당만 건너뛴다(경고 로그만 남기고 전체를
 * 실패시키지 않는다). DATA_GO_KR_KEY가 없으면(또는 호출이 실패하면) 실패로 취급해 로그를
 * 남기고 종료코드에 반영하지만, 역시 기업마당 수집은 막지 않는다. 두 소스 모두 실행되지
 * 못했을 때만(--source로 제외됐거나 키가 둘 다 없을 때) 아무 것도 하지 않고 명확히 실패로
 * 종료한다.
 *
 * ⚠️ 이 스크립트의 API 파라미터명/응답 구조(fetchAllAnnouncements/fetchAllBizinfo,
 * extractItems/extractBizinfoItems 내부)는 서비스키가 없어 실호출로 검증하지 못한 추측이다.
 * "미확인"이라고 표시한 부분은 실제 키를 받은 뒤 반드시 실호출로 확인하고 고칠 것.
 *
 * ⚠️ K-Startup 엔드포인트(KSTARTUP_API_ENDPOINT)는 공공데이터포털 구형 규격
 * (apis.data.go.kr/B552735/...)이라, 파라미터도 구형 규격(pageNo/numOfRows/type=json)으로
 * 가정해 맞춰뒀다. 표준 데이터포털 신형 규격(page/perPage/returnType 등)이 아니다 — 실호출로
 * 실제 응답을 받아본 뒤 구형 가정이 맞는지 반드시 확인할 것.
 *
 * ⚠️ 기업마당 엔드포인트(BIZINFO_API_ENDPOINT)와 파라미터(crtfcKey/dataType/pageUnit/
 * pageIndex)는 팀 리서치 결과를 바탕으로 한 추정이며 실호출로 검증되지 않았다. 일일 호출
 * 한도도 미확인이다.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAnnouncement, mergePrograms } from '../src/lib/collect.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'programs.json');

// ⚠️ 미확인 — 데이터셋 15125364(K-Startup 사업공고정보) 활용신청 시 안내되는 실제 엔드포인트로
// 교체/확인할 것. 아래는 공공데이터포털의 통상적인 URL 규칙을 따른 추정값이다.
const KSTARTUP_API_ENDPOINT = 'https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01';
const KSTARTUP_PAGE_SIZE = 100;

// ⚠️ 미확인 — 기업마당 Open API 엔드포인트. 팀 리서치 결과이며 실호출로 검증되지 않았다.
const BIZINFO_API_ENDPOINT = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
const BIZINFO_PAGE_SIZE = 100;

const MAX_RETRIES = 3;
const MAX_PAGES = 200; // 무한루프 방지용 안전장치

const SOURCE_CHOICES = ['kstartup', 'bizinfo', 'all'];

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const sourceArg = argv.find((a) => a.startsWith('--source='));
  let source = 'all';
  if (sourceArg) {
    const value = sourceArg.slice('--source='.length);
    if (!SOURCE_CHOICES.includes(value)) {
      console.error(`[collect] 오류: 알 수 없는 --source 값 "${value}" (${SOURCE_CHOICES.join('|')} 중 하나여야 합니다)`);
      process.exit(1);
    }
    source = value;
  }
  return { dryRun, source };
}

function backoffMs(attempt) {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 응답 본문 스니펫에 서비스키가 그대로 섞여 나오는 걸 막는다 — 공공데이터 오류 응답이 요청을 에코하는 경우가 있다. */
function scrubServiceKey(text, serviceKey) {
  if (!serviceKey) return text;
  return text.split(serviceKey).join('***');
}

/** fetch 실패/5xx는 지수 백오프로 최대 MAX_RETRIES회 재시도한다. 429는 즉시 중단한다(요청 한도 초과이므로 재시도해도 악화될 뿐). */
async function fetchJsonWithRetry(url, serviceKey) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      lastError = err;
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

/**
 * 공공데이터포털 표준 응답은 흔히 response.body.items.item 형태이지만,
 * ⚠️ 미확인 — K-Startup 서비스가 이 규격을 그대로 따르는지 실호출로 확인 필요.
 * 여러 형태를 관대하게 시도한다.
 */
function extractItems(data) {
  if (Array.isArray(data)) return data;
  const candidates = [data?.response?.body?.items?.item, data?.response?.body?.items, data?.data, data?.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return [candidate];
  }
  return [];
}

function getTotalCount(data) {
  const candidate = data?.response?.body?.totalCount;
  return typeof candidate === 'number' ? candidate : undefined;
}

/**
 * 기업마당 응답에서 항목 배열을 뽑는다. ⚠️ 미확인 — 실제 envelope 구조(jsonArray 등)는
 * 크리덴셜이 없어 검증하지 못했다. K-Startup과 같은 방식으로 여러 후보를 관대하게 시도한다.
 */
function extractBizinfoItems(data) {
  if (Array.isArray(data)) return data;
  const candidates = [data?.jsonArray, data?.result?.jsonArray, data?.response?.body?.items?.item, data?.data, data?.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return [candidate];
  }
  return [];
}

/** ⚠️ 미확인 — 기업마당 응답의 총 건수 필드명. 없으면 undefined로 두고 "0건 응답"에만 의존한다. */
function getBizinfoTotalCount(data) {
  const candidate = data?.totCnt ?? data?.totalCount ?? data?.result?.totCnt;
  return typeof candidate === 'number' ? candidate : undefined;
}

/** 로그에 서비스키를 노출하지 않도록 마스킹된 URL 문자열만 반환한다. */
function redactedUrl(url, paramName) {
  const clone = new URL(url.toString());
  if (clone.searchParams.has(paramName)) clone.searchParams.set(paramName, '***');
  return clone.toString();
}

async function fetchAllAnnouncements(serviceKey) {
  const all = [];
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
async function fetchAllBizinfo(crtfcKey) {
  const all = [];
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
function logDropped(tag, dropped) {
  if (dropped.length === 0) return;
  console.warn(`[${tag}] 제외된 항목 사유 (최대 20건 표시):`);
  for (const reason of dropped.slice(0, 20)) console.warn(`  - ${reason}`);
  if (dropped.length > 20) console.warn(`  ... 외 ${dropped.length - 20}건`);
}

async function collectFromKstartup(existing, serviceKey) {
  const existingAutoCount = existing.filter((p) => p.source === 'k-startup').length;
  const rawItems = await fetchAllAnnouncements(serviceKey);

  // 수집 건수 이상 감지. 데이터를 지우거나 실패시키지는 않는다 — 그냥 사람이 워크플로 로그에서
  // 볼 수 있게 뚜렷한 경고만 남긴다. 실제 대응(재시도/조사)은 사람이 판단한다.
  if (rawItems.length === 0) {
    console.warn('[collect:kstartup] ⚠️ 경고: API가 0건을 반환했습니다. 엔드포인트/파라미터 규격을 확인하세요.');
  } else if (existingAutoCount > 0 && rawItems.length < existingAutoCount * 0.5) {
    console.warn(
      `[collect:kstartup] ⚠️ 경고: 수집 건수(${rawItems.length}건)가 기존 자동수집 건수(${existingAutoCount}건) 대비 급감했습니다. 페이지네이션/파라미터 규격을 확인하세요.`,
    );
  }

  const normalized = [];
  const dropped = [];
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

async function collectFromBizinfo(existing, crtfcKey) {
  const existingAutoCount = existing.filter((p) => p.source === 'bizinfo').length;
  const rawItems = await fetchAllBizinfo(crtfcKey);

  if (rawItems.length === 0) {
    console.warn('[collect:bizinfo] ⚠️ 경고: API가 0건을 반환했습니다. 엔드포인트/파라미터 규격을 확인하세요.');
  } else if (existingAutoCount > 0 && rawItems.length < existingAutoCount * 0.5) {
    console.warn(
      `[collect:bizinfo] ⚠️ 경고: 수집 건수(${rawItems.length}건)가 기존 자동수집 건수(${existingAutoCount}건) 대비 급감했습니다. 페이지네이션/파라미터 규격을 확인하세요.`,
    );
  }

  const normalized = [];
  const dropped = [];
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

async function main() {
  const { dryRun, source } = parseArgs(process.argv.slice(2));
  const runKstartup = source === 'all' || source === 'kstartup';
  const runBizinfo = source === 'all' || source === 'bizinfo';

  const existingRaw = await readFile(DATA_PATH, 'utf-8');
  const existing = JSON.parse(existingRaw);

  let kstartupNormalized = [];
  let kstartupAttempted = false;
  let kstartupFailed = false;

  if (runKstartup) {
    const serviceKey = process.env.DATA_GO_KR_KEY;
    if (!serviceKey) {
      console.error('[collect:kstartup] 오류: DATA_GO_KR_KEY 환경변수가 설정되지 않았습니다.');
      console.error(
        '  data.go.kr에서 "K-Startup 사업공고정보"(데이터셋 15125364) 활용신청 후 발급받은 서비스키를',
      );
      console.error('  DATA_GO_KR_KEY 환경변수로 설정하고 다시 실행하세요. (README.md "자동 수집 설정" 참고)');
      console.error('  (K-Startup 수집은 건너뜁니다. 다른 소스가 있으면 계속 진행합니다.)');
      kstartupFailed = true;
    } else {
      kstartupAttempted = true;
      try {
        kstartupNormalized = await collectFromKstartup(existing, serviceKey);
      } catch (err) {
        console.error(`[collect:kstartup] API 호출 실패: ${err.message}`);
        kstartupFailed = true;
      }
    }
  } else {
    console.log('[collect] --source 옵션에 의해 K-Startup 수집을 건너뜁니다.');
  }

  let bizinfoNormalized = [];
  let bizinfoAttempted = false;
  let bizinfoFailed = false;

  if (runBizinfo) {
    const crtfcKey = process.env.BIZINFO_CRTFC_KEY;
    if (!crtfcKey) {
      console.warn(
        '[collect:bizinfo] BIZINFO_CRTFC_KEY 환경변수가 설정되지 않아 기업마당 수집을 건너뜁니다. (다른 소스는 계속 진행합니다)',
      );
    } else {
      bizinfoAttempted = true;
      try {
        bizinfoNormalized = await collectFromBizinfo(existing, crtfcKey);
      } catch (err) {
        console.error(`[collect:bizinfo] API 호출 실패: ${err.message}`);
        bizinfoFailed = true;
      }
    }
  } else {
    console.log('[collect] --source 옵션에 의해 기업마당 수집을 건너뜁니다.');
  }

  if (!kstartupAttempted && !bizinfoAttempted) {
    console.error('[collect] 실행할 수 있는 소스가 없습니다 (서비스키 미설정 등). 아무 작업도 하지 않고 종료합니다.');
    process.exitCode = 1;
    return;
  }

  const normalized = [...kstartupNormalized, ...bizinfoNormalized];

  const { merged, added, updated, skipped, aliasSkips } = mergePrograms(existing, normalized);
  console.log(`[collect] 병합 결과: 추가 ${added} / 갱신 ${updated} / 변경없음(스킵) ${skipped} / 총 ${merged.length}건`);
  if (aliasSkips.length > 0) {
    console.log('[collect] alias 매칭으로 스킵된 항목(수동 입력이 우선, 덮어쓰지 않음):');
    for (const { manualTitle, incomingTitle } of aliasSkips) {
      console.log(`  - "${incomingTitle}" -> manual 행 "${manualTitle}"의 별칭으로 처리`);
    }
  }

  const anyHardFailure = kstartupFailed || bizinfoFailed;

  if (dryRun) {
    console.log('[collect] --dry-run 모드: 파일에 쓰지 않았습니다.');
  } else if (added === 0 && updated === 0) {
    console.log('[collect] 변경 사항이 없어 파일을 쓰지 않습니다.');
  } else {
    await writeFile(DATA_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
    console.log(`[collect] ${path.relative(process.cwd(), DATA_PATH)} 갱신 완료.`);
  }

  if (anyHardFailure) {
    console.error('[collect] 일부 소스 수집이 실패했습니다 — 위 로그를 확인하세요. (성공한 소스의 수집분은 반영됨)');
    process.exitCode = 1;
  }
}

main();
