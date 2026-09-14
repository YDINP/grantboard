#!/usr/bin/env node
/**
 * K-Startup Open API(getAnnouncementInformation01)를 호출해 data/programs.json을 갱신한다.
 * 네트워크 호출은 이 파일에서만 한다 — 정규화/병합 로직(src/lib/collect.ts)은 순수 함수로 유지한다.
 *
 * 사용법:
 *   DATA_GO_KR_KEY=발급받은키 node scripts/collect.mjs
 *   DATA_GO_KR_KEY=발급받은키 node scripts/collect.mjs --dry-run   # 파일에 쓰지 않고 요약만 출력
 *
 * ⚠️ 이 스크립트의 API 파라미터명/응답 구조(fetchAllAnnouncements, extractItems 내부)는
 * 서비스키가 없어 실호출로 검증하지 못한 추측이다. 아래 주석에 "미확인"이라고 표시한 부분은
 * 실제 키를 받은 뒤 반드시 실호출로 확인하고 고칠 것.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAnnouncement, mergePrograms } from '../src/lib/collect.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'programs.json');

// ⚠️ 미확인 — 데이터셋 15125364(K-Startup 사업공고정보) 활용신청 시 안내되는 실제 엔드포인트로
// 교체/확인할 것. 아래는 공공데이터포털의 통상적인 URL 규칙을 따른 추정값이다.
const API_ENDPOINT = 'https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01';
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const MAX_PAGES = 200; // 무한루프 방지용 안전장치

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function backoffMs(attempt) {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch 실패/5xx는 지수 백오프로 최대 MAX_RETRIES회 재시도한다. 429는 즉시 중단한다(요청 한도 초과이므로 재시도해도 악화될 뿐). */
async function fetchJsonWithRetry(url) {
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

    return res.json();
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

/** 로그에 serviceKey를 노출하지 않도록 마스킹된 URL 문자열만 반환한다. */
function redactedUrl(url) {
  const clone = new URL(url.toString());
  if (clone.searchParams.has('serviceKey')) clone.searchParams.set('serviceKey', '***');
  return clone.toString();
}

async function fetchAllAnnouncements(serviceKey) {
  const all = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set('serviceKey', serviceKey);
    // ⚠️ 미확인 — 페이지 번호/페이지당 건수 파라미터명이 다를 수 있다(예: pageNo/perPage vs page/numOfRows).
    url.searchParams.set('page', String(pageNo));
    url.searchParams.set('perPage', String(PAGE_SIZE));
    // ⚠️ 미확인 — 응답 형식을 json으로 지정하는 파라미터명이 다를 수 있다.
    url.searchParams.set('returnType', 'json');

    console.log(`[collect] 요청: ${redactedUrl(url)}`);
    const data = await fetchJsonWithRetry(url);
    const items = extractItems(data);
    all.push(...items);

    const totalCount = getTotalCount(data);
    const reachedEnd = items.length === 0 || (totalCount !== undefined && all.length >= totalCount) || items.length < PAGE_SIZE;
    if (reachedEnd) break;
  }
  return all;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const serviceKey = process.env.DATA_GO_KR_KEY;
  if (!serviceKey) {
    console.error('[collect] 오류: DATA_GO_KR_KEY 환경변수가 설정되지 않았습니다.');
    console.error(
      '  data.go.kr에서 "K-Startup 사업공고정보"(데이터셋 15125364) 활용신청 후 발급받은 서비스키를',
    );
    console.error('  DATA_GO_KR_KEY 환경변수로 설정하고 다시 실행하세요. (README.md "자동 수집 설정" 참고)');
    process.exitCode = 1;
    return;
  }

  let rawItems;
  try {
    rawItems = await fetchAllAnnouncements(serviceKey);
  } catch (err) {
    console.error(`[collect] API 호출 실패: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const normalized = [];
  const dropped = [];
  for (const raw of rawItems) {
    const { program, reason } = normalizeAnnouncement(raw);
    if (program) normalized.push(program);
    else dropped.push(reason ?? '알 수 없는 사유');
  }

  console.log(`[collect] 수집 ${rawItems.length}건 / 정규화 성공 ${normalized.length}건 / 매핑 실패로 제외 ${dropped.length}건`);
  if (dropped.length > 0) {
    console.warn('[collect] 제외된 항목 사유 (최대 20건 표시):');
    for (const reason of dropped.slice(0, 20)) console.warn(`  - ${reason}`);
    if (dropped.length > 20) console.warn(`  ... 외 ${dropped.length - 20}건`);
  }

  const existingRaw = await readFile(DATA_PATH, 'utf-8');
  const existing = JSON.parse(existingRaw);

  const { merged, added, updated, skipped } = mergePrograms(existing, normalized);
  console.log(`[collect] 병합 결과: 추가 ${added} / 갱신 ${updated} / 변경없음(스킵) ${skipped} / 총 ${merged.length}건`);

  if (dryRun) {
    console.log('[collect] --dry-run 모드: 파일에 쓰지 않았습니다.');
    return;
  }

  if (added === 0 && updated === 0) {
    console.log('[collect] 변경 사항이 없어 파일을 쓰지 않습니다.');
    return;
  }

  await writeFile(DATA_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  console.log(`[collect] ${path.relative(process.cwd(), DATA_PATH)} 갱신 완료.`);
}

main();
