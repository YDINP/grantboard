/**
 * /공고 삭제 — 되돌릴 수 없는 작업이므로 반드시 확인 버튼을 거친다.
 * 1) 슬래시 커맨드 → (D1 읽기, defer) 공고 선택 드롭다운.
 * 2) 공고 선택(MESSAGE_COMPONENT) → (D1 읽기, defer) "이 공고 + 딸린 지원건 N건을 지웁니다" 확인 화면.
 * 3) 확인/취소 버튼 → 확인이면 (D1 쓰기, defer) 실제 삭제, 취소면 즉시 응답.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { getProgram, deleteProgram } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, deferredUpdateResponse, updateMessageResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { programSelectOptions } from '../selectOptions.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import { ComponentType, ButtonStyle } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';

export function handleProgramDeleteCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondProgramSelect(interaction, env));
  return deferredMessageResponse(true);
}

async function respondProgramSelect(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    if (board.programs.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 공고가 없습니다.'),
      });
      return;
    }

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '삭제할 공고를 선택해 주세요. 다음 단계에서 한 번 더 확인합니다.',
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.STRING_SELECT,
              custom_id: encodeCustomId('programs', 'delete-select-program'),
              placeholder: '공고 선택',
              options: programSelectOptions(board.programs),
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('/공고 삭제 1단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 공고 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
}

/** 2단계: 공고를 골랐으니 "무엇이 지워지는지" 보여주고 확인/취소 버튼을 낸다. */
export function handleProgramDeleteSelect(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const programId = interaction.data?.values?.[0];
  ctx.waitUntil(respondConfirmation(interaction, env, programId));
  return deferredUpdateResponse();
}

async function respondConfirmation(interaction: DiscordInteraction, env: Env, programId: string | undefined): Promise<void> {
  if (!programId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /공고 삭제를 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const board = await loadBoardModel(env.DB);
    const view = board.programs.find((v) => v.program.id === programId);
    if (!view) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: '⚠️ 공고를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.',
        components: [],
      });
      return;
    }

    const appCount = view.applications.length;
    const warning =
      appCount > 0
        ? `딸린 지원현황 **${appCount}건**도 함께 삭제됩니다.`
        : '연결된 지원현황은 없습니다.';

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed(
          '⚠️ 삭제 확인',
          `**${view.program.title}**\n${warning}\n\n**되돌릴 수 없습니다.** 계속하시겠습니까?`,
          'red',
        ),
      ],
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.DANGER,
              label: '삭제 확인',
              custom_id: encodeCustomId('programs', 'delete-confirm', programId),
            },
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.SECONDARY,
              label: '취소',
              custom_id: encodeCustomId('programs', 'delete-cancel'),
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('/공고 삭제 2단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 확인 화면을 준비하는 중 오류가 발생했습니다.',
      components: [],
    });
  }
}

/** 3a단계: 확인 버튼 — 실제로 삭제하고 무엇이 지워졌는지 정확히 보고한다. */
export function handleProgramDeleteConfirm(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const programId = decoded.params[0];
  ctx.waitUntil(executeDelete(interaction, env, programId));
  return deferredUpdateResponse();
}

async function executeDelete(interaction: DiscordInteraction, env: Env, programId: string | undefined): Promise<void> {
  if (!programId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 요청입니다. /공고 삭제를 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const program = await getProgram(env.DB, programId);
    const result = await deleteProgram(env.DB, programId);
    const title = program?.title ?? programId;

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed(
          '🗑️ 삭제 완료',
          `**${title}** 공고를 삭제했습니다. 함께 삭제된 지원현황: **${result.deletedApplications}건**`,
          'gray',
        ),
      ],
      components: [],
    });
  } catch (err) {
    console.error('/공고 삭제 3단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 삭제 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      components: [],
    });
  }
}

/** 3b단계: 취소 버튼 — DB 접근 없이 즉시 응답한다. */
export function handleProgramDeleteCancel(): Response {
  return updateMessageResponse('삭제를 취소했습니다.', { components: [] });
}
