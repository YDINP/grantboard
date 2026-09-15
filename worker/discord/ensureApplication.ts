/**
 * "공고는 등록됐는데 지원건이 없어서 아무 커맨드로도 손댈 수 없는" 구멍을 막는 공용 통로.
 *
 * /공고 추가는 공고만 만들고 지원건은 만들지 않는다 — 그래서 방금 등록한 공고는 지원건 기반
 * 선택지(예: 기존 /상태 변경, /서류 연결)에 영영 나타나지 않았다. 이 함수는 지원건이 있으면
 * 그대로 돌려주고, 없으면 그 자리에서 만든다. /상태 변경·/서류 연결이 공유해서 쓴다.
 */

import { getApplicationByProgram, getOwnerByDiscordUser, upsertApplication } from '../db/repo.ts';
import { generateId } from './idGen.ts';
import { callerUserId } from './types.ts';
import type { DiscordInteraction } from './types.ts';
import type { Application, ApplicationStatus } from '../../src/lib/board.ts';

/** owner 매핑이 없을 때 쓰는 자리표시자. applications.owner의 4자 제한을 지킨다. */
export const DEFAULT_OWNER = '미정';

export interface EnsureApplicationResult {
  application: Application;
  /** 이번 호출에서 새로 만들었는지. false면 기존 지원건을 그대로 돌려준 것이다. */
  created: boolean;
  /** 새로 만들면서 담당자를 호출자 매핑 대신 DEFAULT_OWNER로 채웠는지. */
  ownerWasDefaulted: boolean;
}

/**
 * programId에 연결된 지원건을 찾고, 없으면 새로 만든다.
 * 새로 만들 때 owner는 호출자의 /나는 매핑(getOwnerByDiscordUser)을 우선 쓰고, 없으면
 * DEFAULT_OWNER로 채운다 — 호출자는 ownerWasDefaulted를 보고 "/나는으로 등록하라"는 안내를
 * 덧붙일지 결정하면 된다. priority 등 나머지 필드는 스키마 기본값을 쓴다.
 */
export async function ensureApplication(
  env: Env,
  interaction: DiscordInteraction,
  programId: string,
  initialStatus: ApplicationStatus,
): Promise<EnsureApplicationResult> {
  const existing = await getApplicationByProgram(env.DB, programId);
  if (existing) {
    return { application: existing, created: false, ownerWasDefaulted: false };
  }

  const userId = callerUserId(interaction);
  const mappedOwner = userId ? await getOwnerByDiscordUser(env.DB, userId) : null;
  const owner = mappedOwner ?? DEFAULT_OWNER;

  const application: Application = {
    id: generateId(programId),
    programId,
    status: initialStatus,
    owner,
    priority: 'mid',
    documentIds: [],
  };
  await upsertApplication(env.DB, application);

  return { application, created: true, ownerWasDefaulted: !mappedOwner };
}
