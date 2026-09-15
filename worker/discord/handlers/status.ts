/**
 * /상태 변경 — 3단계 흐름.
 * 1) 슬래시 커맨드 → (D1 읽기, defer) 공고 선택 드롭다운을 보여준다. **지원건이 없는 공고도
 *    포함한다** — 예전엔 board.applications에서 뽑아서 "아직 지원 안 한" 새 공고가 영영
 *    선택지에 안 떠서 손댈 방법이 없었다(등록은 되는데 그다음이 막히는 구멍).
 * 2) 공고 선택(MESSAGE_COMPONENT) → (DB 접근 없음, 즉시 응답) 상태 선택 드롭다운으로 메시지를 바꾼다.
 *    선택된 programId는 다음 단계 드롭다운의 custom_id에 실어 보낸다.
 * 3) 상태 선택(MESSAGE_COMPONENT) → (D1 쓰기, defer) 지원건이 있으면 상태만 갱신하고,
 *    없으면 ensureApplication으로 그 자리에서 새로 만든다.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { getProgram, upsertApplication } from '../../db/repo.ts';
import { ensureApplication } from '../ensureApplication.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, deferredUpdateResponse, updateMessageResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import { STATUS_CHOICES } from '../commands.ts';
import { programSelectOptionsWithApplicationStatus, sortProgramsByUrgency, paginate } from '../selectOptions.ts';
import { syncStatusBoard } from '../statusBoard.ts';
import { ComponentType, ButtonStyle } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';
import type { Application, ProgramView } from '../../../src/lib/board.ts';

/** 1단계: 공고 선택 드롭다운. D1에서 공고 목록을 읽어야 하므로 defer. */
export function handleStatusChangeCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondProgramSelect(interaction, env, 0));
  return deferredMessageResponse(true);
}

/** 25건이 넘는 공고 목록의 이전/다음 페이지 버튼. DB 접근이 있으므로 defer. */
export function handleStatusProgramPage(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const page = Number(decoded.params[0]) || 0;
  ctx.waitUntil(respondProgramSelect(interaction, env, page));
  return deferredUpdateResponse();
}

function buildProgramSelectMessage(views: readonly ProgramView[], page: number) {
  const { items, page: clampedPage, totalPages } = paginate(views, page);

  const components: unknown[] = [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.STRING_SELECT,
          custom_id: encodeCustomId('status', 'select-program'),
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
          custom_id: encodeCustomId('status', 'select-program-page', String(clampedPage - 1)),
          disabled: clampedPage <= 0,
        },
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: '다음 ▶',
          custom_id: encodeCustomId('status', 'select-program-page', String(clampedPage + 1)),
          disabled: clampedPage >= totalPages - 1,
        },
      ],
    });
  }

  return {
    content: '상태를 변경할 공고를 선택해 주세요. 지원건이 없는 공고를 고르면 새로 만듭니다.',
    components,
  };
}

async function respondProgramSelect(interaction: DiscordInteraction, env: Env, page: number): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    if (board.programs.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 공고가 없습니다. 먼저 /공고 추가로 공고를 등록해 주세요.'),
      });
      return;
    }

    // 마감 지난 공고도 빼지 않는다(결과를 나중에 기록해야 할 수 있음) — 대신 맨 아래로 보낸다.
    const views = sortProgramsByUrgency(board.programs);
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, buildProgramSelectMessage(views, page));
  } catch (err) {
    console.error('/상태 변경 1단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 공고 목록을 불러오는 중 오류가 발생했습니다.',
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
  const status = newStatus as Application['status'];

  try {
    // ensureApplication이 없으면 새로 만들어 준다 — 이때 초기 상태를 바로 사용자가 고른 값으로
    // 넣으므로, created가 true면 이 한 번으로 끝난다(따로 upsert할 필요 없음).
    const { application: base, created, ownerWasDefaulted } = await ensureApplication(env, interaction, programId, status);

    if (!created && base.status !== status) {
      const updated: Application = { ...base, status };
      await upsertApplication(env.DB, updated);
    }

    if (created) {
      const program = await getProgram(env.DB, programId);
      const ownerNote = ownerWasDefaulted
        ? `\n담당자를 '${base.owner}'로 임시 등록했습니다. 정확히 하려면 /나는으로 등록해 주세요.`
        : '';
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        embeds: [
          buildEmbed(
            '✅ 지원 시작됨',
            `**${program?.title ?? programId}** 공고에 새 지원건을 만들고 상태를 **${status}**로 설정했습니다.${ownerNote}`,
            'green',
          ),
        ],
        components: [],
      });
    } else {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        embeds: [buildEmbed('✅ 상태 변경됨', `${base.status} → **${status}**`, 'green')],
        components: [],
      });
    }

    await syncStatusBoard(env);
  } catch (err) {
    console.error('/상태 변경 3단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 상태 변경 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      components: [],
    });
  }
}
