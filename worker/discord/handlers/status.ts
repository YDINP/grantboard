/**
 * /상태 변경 — 3단계 흐름.
 * 1) 슬래시 커맨드 → (D1 읽기, defer) 공고 선택 드롭다운을 보여준다.
 * 2) 공고 선택(MESSAGE_COMPONENT) → (DB 접근 없음, 즉시 응답) 상태 선택 드롭다운으로 메시지를 바꾼다.
 *    선택된 programId는 다음 단계 드롭다운의 custom_id에 실어 보낸다.
 * 3) 상태 선택(MESSAGE_COMPONENT) → (D1 쓰기, defer) 해당 공고의 지원건 상태를 갱신한다.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { getApplicationByProgram, upsertApplication } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, deferredUpdateResponse, updateMessageResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import { STATUS_CHOICES } from '../commands.ts';
import { applicationSelectOptions } from '../selectOptions.ts';
import { syncStatusBoard } from '../statusBoard.ts';
import { ComponentType } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';
import type { Application } from '../../../src/lib/board.ts';

/** 1단계: 공고 선택 드롭다운. D1에서 지원건 목록을 읽어야 하므로 defer. */
export function handleStatusChangeCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondProgramSelect(interaction, env));
  return deferredMessageResponse(true);
}

async function respondProgramSelect(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    if (board.applications.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 지원건이 없습니다. 먼저 /공고 추가로 공고를 등록해 주세요.'),
      });
      return;
    }

    const options = applicationSelectOptions(board.applications, (v) => v.application.programId);

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '상태를 변경할 공고를 선택해 주세요.',
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.STRING_SELECT,
              custom_id: encodeCustomId('status', 'select-program'),
              placeholder: '공고 선택',
              options,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('/상태 변경 1단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 지원건 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
}

/** 2단계: 공고를 골랐으니 상태 드롭다운으로 교체한다. DB 접근이 필요 없어 즉시 응답한다. */
export function handleStatusProgramSelect(interaction: DiscordInteraction): Response {
  const programId = interaction.data?.values?.[0];
  if (!programId) {
    return updateMessageResponse('⚠️ 공고 선택 값을 읽을 수 없습니다. 다시 시도해 주세요.', { components: [] });
  }

  const options = STATUS_CHOICES.map((status) => ({ label: status, value: status }));
  return updateMessageResponse('변경할 상태를 선택해 주세요.', {
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.STRING_SELECT,
            custom_id: encodeCustomId('status', 'select-value', programId),
            placeholder: '상태 선택',
            options,
          },
        ],
      },
    ],
  });
}

/** 3단계: 상태를 골랐으니 D1에 반영한다. 쓰기이므로 defer. */
export function handleStatusValueSelect(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const programId = decoded.params[0];
  const newStatus = interaction.data?.values?.[0];
  ctx.waitUntil(applyStatusChange(interaction, env, programId, newStatus));
  return deferredUpdateResponse();
}

async function applyStatusChange(
  interaction: DiscordInteraction,
  env: Env,
  programId: string | undefined,
  newStatus: string | undefined,
): Promise<void> {
  if (!programId || !newStatus || !(STATUS_CHOICES as readonly string[]).includes(newStatus)) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /상태 변경을 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const application = await getApplicationByProgram(env.DB, programId);
    if (!application) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: '⚠️ 이 공고에 연결된 지원건을 찾을 수 없습니다.',
        components: [],
      });
      return;
    }

    const updated: Application = { ...application, status: newStatus as Application['status'] };
    await upsertApplication(env.DB, updated);

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('✅ 상태 변경됨', `${application.status} → **${newStatus}**`, 'green')],
      components: [],
    });
    await syncStatusBoard(env);
  } catch (err) {
    console.error('/상태 변경 3단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 상태 변경 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      components: [],
    });
  }
}
