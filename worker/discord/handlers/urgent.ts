/**
 * /임박 — 오늘/3일 이내 마감, 내부마감 초과 미제출, 발표일 경과 미확인을 한 화면에.
 * D1 조회가 필요하므로 즉시 defer하고, ctx.waitUntil로 실제 조회/응답 편집을 이어간다.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse } from '../responses.ts';
import { buildEmbed, programLine, overdueApplicationLine, announceOverdueLine, emptyStateLine } from '../embeds.ts';
import type { DiscordInteraction } from '../types.ts';

export function handleUrgentCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondUrgent(interaction, env));
  return deferredMessageResponse(true);
}

async function respondUrgent(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    const deadlineSoon = board.programs.filter((v) => v.deadline.state === 'urgent');
    const overdueUnsubmitted = board.applications.filter((v) => v.overdueUnsubmitted);
    const announceOverdue = board.applications.filter((v) => v.announceOverdue);

    const sections: string[] = [];
    if (deadlineSoon.length > 0) {
      sections.push(`**🚨 오늘/3일 이내 마감**\n${deadlineSoon.map(programLine).join('\n')}`);
    }
    if (overdueUnsubmitted.length > 0) {
      sections.push(`**⚠️ 내부 마감 초과 미제출**\n${overdueUnsubmitted.map(overdueApplicationLine).join('\n')}`);
    }
    if (announceOverdue.length > 0) {
      sections.push(`**🔔 발표일 경과, 결과 확인 필요**\n${announceOverdue.map(announceOverdueLine).join('\n')}`);
    }

    const description = sections.length > 0 ? sections.join('\n\n') : emptyStateLine('임박한 마감이 없습니다.');
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('📋 마감 임박 현황', description, sections.length > 0 ? 'orange' : 'green')],
    });
  } catch (err) {
    console.error('/임박 처리 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 현황을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
