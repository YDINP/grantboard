/**
 * /서류 완료 — 서류를 선택해 준비 완료(ready) 여부를 토글한다.
 * 1) 슬래시 커맨드 → (D1 읽기, defer) 서류 선택 드롭다운.
 * 2) 서류 선택(MESSAGE_COMPONENT) → (D1 읽기+쓰기, defer) ready를 뒤집어 저장.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { listDocuments, upsertDocument } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, deferredUpdateResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { documentSelectOptions } from '../selectOptions.ts';
import { encodeCustomId } from '../customId.ts';
import { ComponentType } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';

export function handleDocumentCompleteCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
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
      content: '준비 완료 여부를 바꿀 서류를 선택해 주세요.',
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.STRING_SELECT,
              custom_id: encodeCustomId('documents', 'toggle-select'),
              placeholder: '서류 선택',
              options: documentSelectOptions(board.documents),
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('/서류 완료 1단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 서류 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
}

export function handleDocumentToggleSelect(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const documentId = interaction.data?.values?.[0];
  ctx.waitUntil(applyToggle(interaction, env, documentId));
  return deferredUpdateResponse();
}

async function applyToggle(interaction: DiscordInteraction, env: Env, documentId: string | undefined): Promise<void> {
  if (!documentId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /서류 완료를 다시 실행해 주세요.',
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

    const updated = { ...document, ready: !document.ready };
    await upsertDocument(env.DB, updated);

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed(
          '✅ 준비 상태 변경됨',
          `**${document.name}** — ${updated.ready ? '준비완료' : '준비중'}으로 변경했습니다.`,
          'green',
        ),
      ],
      components: [],
    });
  } catch (err) {
    console.error('/서류 완료 2단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 상태 변경 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      components: [],
    });
  }
}
