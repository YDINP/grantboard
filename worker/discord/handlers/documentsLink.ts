/**
 * /서류 연결 — 서류 ↔ 지원건 연결/해제. 이미 연결돼 있으면 해제, 아니면 연결(토글).
 * 1) 슬래시 커맨드 → (D1 읽기, defer) 서류 선택 드롭다운.
 * 2) 서류 선택(MESSAGE_COMPONENT) → (D1 읽기, defer) 지원건 선택 드롭다운으로 교체.
 *    선택된 documentId는 다음 단계 custom_id에 실어 보낸다.
 * 3) 지원건 선택(MESSAGE_COMPONENT) → (D1 읽기+쓰기, defer) documentIds에 추가/제거.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { listDocuments, listApplications, upsertApplication } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { syncStatusBoard } from '../statusBoard.ts';
import { deferredMessageResponse, deferredUpdateResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { documentSelectOptions, applicationSelectOptions } from '../selectOptions.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import { ComponentType } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';
import type { Application } from '../../../src/lib/board.ts';

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

/** 2단계: 서류를 골랐으니 지원건 드롭다운으로 교체한다. 지원건 목록도 D1 읽기라 defer. */
export function handleDocumentLinkSelectDoc(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const documentId = interaction.data?.values?.[0];
  ctx.waitUntil(respondApplicationSelect(interaction, env, documentId));
  return deferredUpdateResponse();
}

async function respondApplicationSelect(interaction: DiscordInteraction, env: Env, documentId: string | undefined): Promise<void> {
  if (!documentId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /서류 연결을 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const board = await loadBoardModel(env.DB);
    if (board.applications.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 지원건이 없습니다.'),
        components: [],
      });
      return;
    }

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '연결/해제할 지원건을 선택해 주세요. 이미 연결되어 있으면 해제됩니다.',
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.STRING_SELECT,
              custom_id: encodeCustomId('documents', 'link-select-app', documentId),
              placeholder: '지원건 선택',
              options: applicationSelectOptions(board.applications, (v) => v.application.id),
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('/서류 연결 2단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 지원건 목록을 불러오는 중 오류가 발생했습니다.',
      components: [],
    });
  }
}

/** 3단계: 지원건을 골랐으니 documentIds를 갱신한다. D1 쓰기라 defer. */
export function handleDocumentLinkSelectApp(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const documentId = decoded.params[0];
  const applicationId = interaction.data?.values?.[0];
  ctx.waitUntil(applyLinkToggle(interaction, env, documentId, applicationId));
  return deferredUpdateResponse();
}

async function applyLinkToggle(
  interaction: DiscordInteraction,
  env: Env,
  documentId: string | undefined,
  applicationId: string | undefined,
): Promise<void> {
  if (!documentId || !applicationId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /서류 연결을 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const [documents, applications] = await Promise.all([listDocuments(env.DB), listApplications(env.DB)]);
    const document = documents.find((d) => d.id === documentId);
    const application = applications.find((a) => a.id === applicationId);
    if (!document || !application) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: '⚠️ 서류 또는 지원건을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.',
        components: [],
      });
      return;
    }

    const wasLinked = application.documentIds.includes(documentId);
    const documentIds = wasLinked
      ? application.documentIds.filter((id) => id !== documentId)
      : [...application.documentIds, documentId];
    const updated: Application = { ...application, documentIds };
    await upsertApplication(env.DB, updated);

    const action = wasLinked ? '해제' : '연결';
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed(`✅ ${action}됨`, `**${document.name}** ↔ 지원건(${application.programId})`, 'green')],
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
