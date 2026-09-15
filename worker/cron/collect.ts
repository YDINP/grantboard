/**
 * CRON_COLLECT(KST 08:00)가 부르는 진입점. 네트워크 호출은 collectSources.ts에, 정규화/병합
 * 순수 함수는 src/lib/collect.ts에 맡기고, 여기서는 D1 읽기/쓰기와 소스별 실패 격리만 한다.
 *
 * scripts/collect.mjs(로컬 수동 실행, data/programs.json 대상)와 로직 골격은 같지만
 * 쓰기 대상이 D1이라는 점만 다르다 — 네트워크/정규화 로직은 collectSources.ts를 공유해서
 * 두 벌로 짜지 않는다.
 */

import { listPrograms, upsertProgram } from '../db/repo.ts';
import { mergePrograms, type ProgramRecord } from '../../src/lib/collect.ts';
import { collectFromKstartup, collectFromBizinfo } from './collectSources.ts';
import type { Program } from '../db/types.ts';

export interface SourceOutcome {
  attempted: boolean;
  /** 서비스키가 없어 조용히 건너뛴 경우. failed와는 구분한다 — 에러가 아니다. */
  skippedNoKey: boolean;
  failed: boolean;
  count: number;
}

export interface CollectResult {
  kstartup: SourceOutcome;
  bizinfo: SourceOutcome;
  merge: { added: number; updated: number; skipped: number } | null;
  wrote: boolean;
}

function emptyOutcome(): SourceOutcome {
  return { attempted: false, skippedNoKey: false, failed: false, count: 0 };
}

/** ProgramRecord(src/lib/collect.ts) → Program(worker/db/types.ts). 필드 구조는 같지만
 * aliasTitles의 optional 여부만 다르다(정규화 결과는 항상 비어 있으므로 빈 배열로 채운다). */
function toWorkerProgram(record: ProgramRecord): Program {
  return {
    id: record.id,
    title: record.title,
    organizer: record.organizer,
    sourceUrl: record.sourceUrl,
    category: record.category,
    applyStart: record.applyStart,
    applyEnd: record.applyEnd,
    applyEndTime: record.applyEndTime,
    announceDate: record.announceDate,
    supportAmount: record.supportAmount,
    tags: record.tags,
    source: record.source,
    collectedAt: record.collectedAt,
    aliasTitles: record.aliasTitles ?? [],
    eligibility: record.eligibility as Program['eligibility'],
  };
}

export async function runCollect(env: Env): Promise<CollectResult> {
  const existing = await listPrograms(env.DB);

  const kstartup = emptyOutcome();
  let kstartupNormalized: ProgramRecord[] = [];
  if (env.DATA_GO_KR_KEY) {
    kstartup.attempted = true;
    try {
      kstartupNormalized = await collectFromKstartup(existing, env.DATA_GO_KR_KEY);
      kstartup.count = kstartupNormalized.length;
    } catch (err) {
      kstartup.failed = true;
      console.error(`[cron:collect:kstartup] API 호출 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    kstartup.skippedNoKey = true;
    console.log('[cron:collect:kstartup] DATA_GO_KR_KEY가 설정되지 않아 건너뜁니다(에러 아님).');
  }

  const bizinfo = emptyOutcome();
  let bizinfoNormalized: ProgramRecord[] = [];
  if (env.BIZINFO_CRTFC_KEY) {
    bizinfo.attempted = true;
    try {
      bizinfoNormalized = await collectFromBizinfo(existing, env.BIZINFO_CRTFC_KEY);
      bizinfo.count = bizinfoNormalized.length;
    } catch (err) {
      bizinfo.failed = true;
      console.error(`[cron:collect:bizinfo] API 호출 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    bizinfo.skippedNoKey = true;
    console.log('[cron:collect:bizinfo] BIZINFO_CRTFC_KEY가 설정되지 않아 건너뜁니다(에러 아님).');
  }

  const normalized = [...kstartupNormalized, ...bizinfoNormalized];

  if (kstartup.failed || bizinfo.failed) {
    console.error('[cron:collect] 일부 소스 수집이 실패했습니다 — 위 로그를 확인하세요(성공한 소스는 계속 반영됩니다).');
  }

  if (normalized.length === 0) {
    console.log('[cron:collect] 반영할 신규 수집 결과가 없어 D1은 건드리지 않고 종료합니다.');
    return { kstartup, bizinfo, merge: null, wrote: false };
  }

  // mergePrograms가 manual 우선/빈 응답 보호를 전부 처리한다 — 여기서 다시 판단하지 않는다.
  const { merged, added, updated, skipped, aliasSkips } = mergePrograms(existing, normalized);
  console.log(`[cron:collect] 병합 결과: 추가 ${added} / 갱신 ${updated} / 변경없음(스킵) ${skipped} / 총 ${merged.length}건`);
  for (const { manualTitle, incomingTitle } of aliasSkips) {
    console.log(`  - "${incomingTitle}" -> manual 행 "${manualTitle}"의 별칭으로 처리`);
  }

  let wrote = false;
  if (added === 0 && updated === 0) {
    console.log('[cron:collect] 변경 사항이 없어 D1 쓰기를 건너뜁니다.');
  } else {
    // manual 행은 절대 쓰지 않는다(mergePrograms가 이미 덮어쓰지 않은 채로 merged에 포함시켰다).
    // 변경 여부와 무관하게 자동수집 전체를 다시 upsert한다 — upsertProgram은 멱등하고,
    // 개별 행 단위로 "이번에 실제로 바뀐 것"만 추려내는 것보다 훨씬 단순하고 안전하다.
    const toWrite = merged.filter((p) => p.source !== 'manual');
    for (const program of toWrite) {
      await upsertProgram(env.DB, toWorkerProgram(program));
    }
    wrote = true;
    console.log(`[cron:collect] D1에 자동수집 ${toWrite.length}건 upsert 완료.`);
  }

  return { kstartup, bizinfo, merge: { added, updated, skipped }, wrote };
}
