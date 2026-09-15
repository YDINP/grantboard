/**
 * /일정 — 날짜순 타임라인. D1 읽기이므로 defer. 조립 로직은 전부 scheduleTimeline.ts(순수 함수)에
 * 있다 — 여기서는 옵션을 읽고, D1에서 board를 불러와 필터링한 뒤 결과가 비었을 때의 이유
 * (데이터가 아예 없음 / 필터에 안 걸림)만 구분해서 안내한다.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse } from '../responses.ts';
import { emptyStateLine } from '../embeds.ts';
import { CALENDAR_URL } from '../statusBoard.ts';
import {
  filterEventsForSchedule,
  buildTimelineEmbed,
  DEFAULT_SCHEDULE_SCOPE,
  SCHEDULE_SCOPES,
  type ScheduleScope,
} from '../scheduleTimeline.ts';
import { SCHEDULE_SCOPE_OPTION, SCHEDULE_OWNER_OPTION } from '../commands.ts';
import { optionValue } from './programs.ts';
import type { DiscordInteraction } from '../types.ts';

function isScheduleScope(value: string | undefined): value is ScheduleScope {
  return (SCHEDULE_SCOPES as readonly string[]).includes(value ?? '');
}

export function handleScheduleCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const scopeOption = optionValue(interaction.data?.options, SCHEDULE_SCOPE_OPTION);
  const scope: ScheduleScope = isScheduleScope(scopeOption) ? scopeOption : DEFAULT_SCHEDULE_SCOPE;
  const owner = optionValue(interaction.data?.options, SCHEDULE_OWNER_OPTION);
  ctx.waitUntil(respondSchedule(interaction, env, scope, owner));
  return deferredMessageResponse(true);
}

async function respondSchedule(interaction: DiscordInteraction, env: Env, scope: ScheduleScope, owner: string | undefined): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);

    if (board.events.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 일정이 없습니다. 먼저 /공고 추가로 공고를 등록해 주세요.'),
      });
      return;
    }

    const today = new Date();
    const filtered = filterEventsForSchedule(board.events, scope, owner, today);

    if (filtered.length === 0) {
      const ownerNote = owner ? ` · 담당 "${owner}"` : '';
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine(
          `"${scope}"${ownerNote} 조건에 맞는 일정이 없습니다. 범위를 "전체"로 넓혀 보세요.\n📅 [달력 보기](${CALENDAR_URL})`,
        ),
      });
      return;
    }

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildTimelineEmbed(filtered, today)],
    });
  } catch (err) {
    console.error('/일정 처리 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 일정을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
