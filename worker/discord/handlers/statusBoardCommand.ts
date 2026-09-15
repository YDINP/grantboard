/**
 * /현황 — 현황판(statusBoard.ts)을 수동으로 즉시 갱신하고, 그 메시지로 가는 바로가기를 안내한다.
 * 실제 조립/발행 로직은 전부 statusBoard.ts가 한다 — 여기서는 호출 + 링크 안내만 한다.
 */

import { syncStatusBoard, getStatusBoardState } from '../statusBoard.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse } from '../responses.ts';
import type { DiscordInteraction } from '../types.ts';

export function handleStatusBoardCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondStatusBoard(interaction, env));
  return deferredMessageResponse(true);
}

async function respondStatusBoard(interaction: DiscordInteraction, env: Env): Promise<void> {
  // syncStatusBoard는 내부에서 모든 실패를 삼킨다(console.error만 남김) — 여기서 별도 try/catch가 필요 없다.
  await syncStatusBoard(env);

  const state = await getStatusBoardState(env);
  if (!state) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 현황판을 갱신하는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
    return;
  }

  const jumpLink = `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${state.channelId}/${state.messageId}`;
  await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
    content: `✅ 현황판을 갱신했습니다. [바로가기](${jumpLink})`,
  });
}
