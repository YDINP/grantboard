#!/usr/bin/env node
/**
 * K-Startup Open API(getAnnouncementInformation01) + 기업마당(bizinfo.go.kr) Open API를
 * 호출해 data/programs.json을 갱신한다.
 *
 * 네트워크 호출/재시도/응답 파싱(fetchAllAnnouncements 등)은 worker/cron/collectSources.ts에
 * 있다 — Worker의 CRON_COLLECT(worker/cron/collect.ts, D1 대상)와 이 스크립트(파일 대상)가
 * 같은 코드를 공유한다. 정규화/병합 로직(src/lib/collect.ts)은 그 아래에서 순수 함수로 유지된다.
 * 이 파일이 하는 일은 파일 읽기/쓰기와 CLI 인자 처리뿐이다.
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
 * ⚠️ API 파라미터명/응답 구조 관련 미확인 사항은 worker/cron/collectSources.ts 상단 주석을
 * 참고할 것. 실제 키를 받은 뒤 반드시 실호출로 확인하고 고칠 것.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePrograms } from '../src/lib/collect.ts';
import { collectFromKstartup, collectFromBizinfo } from '../worker/cron/collectSources.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'programs.json');

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
