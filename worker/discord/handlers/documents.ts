/**
 * /서류 목록 — 서류 준비 현황(전체 대비 준비완료 수)과 만료/만료 임박 서류 목록.
 * (다른 서류 서브커맨드는 handlers/documentsAdd.ts / documentsComplete.ts / documentsLink.ts에 있다.)
 */

import { loadBoardModel } from '../loadBoard.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse } from '../responses.ts';
import { buildEmbed, documentLine, emptyStateLine } from '../embeds.ts';
import type { DiscordInteraction } from '../types.ts';

export function handleDocumentListCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondDocumentList(interaction, env));
  return deferredMessageResponse(true);
}

async function respondDocumentList(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    const total = board.documents.length;
    const ready = board.documents.filter((v) => v.document.ready).length;
    const alerts = board.documents.filter((v) => v.expiry.state === 'expired' || v.expiry.state === 'expiring');

    const summary = `준비완료 ${ready}/${total}건`;
    const alertBlock =
      alerts.length > 0
        ? `**만료됨 / 만료 임박**\n${alerts.map(documentLine).join('\n\n')}`
        : emptyStateLine('만료되었거나 임박한 서류가 없습니다.');

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('📄 서류 준비 현황', `${summary}\n\n${alertBlock}`, alerts.length > 0 ? 'orange' : 'green')],
    });
  } catch (err) {
    console.error('/서류 목록 처리 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 서류 현황을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
