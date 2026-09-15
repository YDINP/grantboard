/**
 * /서류 연결 — 서류 ↔ 지원건 연결/해제. 이미 연결돼 있으면 해제, 아니면 연결(토글).
 * 1) 슬래시 커맨드 → (D1 읽기, defer) 서류 선택 드롭다운.
 * 2) 서류 선택(MESSAGE_COMPONENT) → (D1 읽기, defer) **공고** 선택 드롭다운으로 교체.
 *    지원건이 아니라 공고 단위로 고르게 한다 — 예전엔 board.applications에서 뽑아서 아직
 *    지원 안 한 공고엔 서류를 연결할 방법이 없었다(등록만 되고 손댈 수 없는 구멍, /상태 변경과
 *    같은 종류). 선택된 documentId는 다음 단계 custom_id에 실어 보낸다.
 * 3) 공고 선택(MESSAGE_COMPONENT) → (D1 읽기+쓰기, defer) 지원건이 없으면 ensureApplication으로
 *    만들고(초기 상태 '검토중'), documentIds에 추가/제거한다.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { listDocuments, upsertApplication } from '../../db/repo.ts';
import { ensureApplication } from '../ensureApplication.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { syncStatusBoard } from '../statusBoard.ts';
import { deferredMessageResponse, deferredUpdateResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { documentSelectOptions, programSelectOptionsWithApplicationStatus, sortProgramsByUrgency, paginate } from '../selectOptions.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import { ComponentType, ButtonStyle } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';
import type { Application, ProgramView } from '../../../src/lib/board.ts';

/** 지원건이 없어 새로 만들 때 쓰는 초기 상태. 사용자가 고르는 값이 아니라 워크플로 첫 단계로 둔다. */
const DEFAULT_INITIAL_STATUS: Application['status'] = '검토중';

export function handleDocumentLinkCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondDocumentSelect(interaction, env));
  return deferredMessageResponse(true);
}

async function respondDocumentSelect(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    if (board.documents.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 서류가 없습니다. 먼저 /서류 추가로 등록해 주세요.'),
      });
      return;
    }

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '연결/해제할 서류를 선택해 주세요.',
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.STRING_SELECT,
              custom_id: encodeCustomId('documents', 'link-select-doc'),
              placeholder: '서류 선택',
              options: documentSelectOptions(board.documents),
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('/서류 연결 1단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 서류 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
}

/** 2단계: 서류를 골랐으니 공고 드롭다운으로 교체한다. 공고 목록도 D1 읽기라 defer. */
export function handleDocumentLinkSelectDoc(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const documentId = interaction.data?.values?.[0];
  ctx.waitUntil(respondProgramSelect(interaction, env, documentId, 0));
  return deferredUpdateResponse();
}

/** 25건이 넘는 공고 목록의 이전/다음 페이지 버튼. documentId는 params[0]에 실려 계속 전달된다. */
export function handleDocumentLinkProgramPage(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const documentId = decoded.params[0];
  const page = Number(decoded.params[1]) || 0;
  ctx.waitUntil(respondProgramSelect(interaction, env, documentId, page));
  return deferredUpdateResponse();
}

function buildProgramSelectMessage(views: readonly ProgramView[], documentId: string, page: number) {
  const { items, page: clampedPage, totalPages } = paginate(views, page);

  const components: unknown[] = [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.STRING_SELECT,
          custom_id: encodeCustomId('documents', 'link-select-program', documentId),
          placeholder: `공고 선택 (${clampedPage + 1}/${totalPages}페이지)`,
          options: programSelectOptionsWithApplicationStatus(items),
        },
      ],
    },
  ];

  if (totalPages > 1) {
    components.push({
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: '◀ 이전',
          custom_id: encodeCustomId('documents', 'link-program-page', documentId, String(clampedPage - 1)),
          disabled: clampedPage <= 0,
        },
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: '다음 ▶',
          custom_id: encodeCustomId('documents', 'link-program-page', documentId, String(clampedPage + 1)),
          disabled: clampedPage >= totalPages - 1,
        },
      ],
    });
  }

  return {
    content: '연결/해제할 공고를 선택해 주세요. 지원건이 없으면 새로 만듭니다. 이미 연결되어 있으면 해제됩니다.',
    components,
  };
}

async function respondProgramSelect(interaction: DiscordInteraction, env: Env, documentId: string | undefined, page: number): Promise<void> {
  if (!documentId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /서류 연결을 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const board = await loadBoardModel(env.DB);
    if (board.programs.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 공고가 없습니다.'),
        components: [],
      });
      return;
    }

    const views = sortProgramsByUrgency(board.programs);
    await editOriginalResponse(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      buildProgramSelectMessage(views, documentId, page),
    );
  } catch (err) {
    console.error('/서류 연결 2단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 공고 목록을 불러오는 중 오류가 발생했습니다.',
      components: [],
    });
  }
}

/** 3단계: 공고를 골랐으니(지원건이 없으면 새로 만들고) documentIds를 갱신한다. D1 쓰기라 defer. */
export function handleDocumentLinkSelectProgram(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const documentId = decoded.params[0];
  const programId = interaction.data?.values?.[0];
  ctx.waitUntil(applyLinkToggle(interaction, env, documentId, programId));
  return deferredUpdateResponse();
}

async function applyLinkToggle(
  interaction: DiscordInteraction,
  env: Env,
  documentId: string | undefined,
  programId: string | undefined,
): Promise<void> {
  if (!documentId || !programId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /서류 연결을 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const documents = await listDocuments(env.DB);
    const document = documents.find((d) => d.id === documentId);
    if (!document) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: '⚠️ 서류를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.',
        components: [],
      });
      return;
    }

    // ensureApplication이 없으면 새로 만들어 준다 — 방금 만든 지원건이면 documentIds가 항상
    // 빈 배열이므로 아래 토글은 무조건 "연결"이 된다.
    const { application, created, ownerWasDefaulted } = await ensureApplication(env, interaction, programId, DEFAULT_INITIAL_STATUS);

    const wasLinked = application.documentIds.includes(documentId);
    const documentIds = wasLinked
      ? application.documentIds.filter((id) => id !== documentId)
      : [...application.documentIds, documentId];
    const updated: Application = { ...application, documentIds };
    await upsertApplication(env.DB, updated);

    const action = wasLinked ? '해제' : '연결';
    const createdNote = created
      ? `\n지원건이 없어 새로 만들었습니다(상태: ${DEFAULT_INITIAL_STATUS}).${ownerWasDefaulted ? ` 담당자는 '${application.owner}'로 임시 등록했습니다 — 정확히 하려면 /나는으로 등록해 주세요.` : ''}`
      : '';
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed(`✅ ${action}됨`, `**${document.name}** ↔ 공고(${programId})${createdNote}`, 'green')],
      components: [],
    });
    await syncStatusBoard(env);
  } catch (err) {
    console.error('/서류 연결 3단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 연결 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      components: [],
    });
  }
}
