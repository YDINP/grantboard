/**
 * /내마감 — 호출자가 담당(owner)인 진행 중 지원건만 마감순으로 보여준다.
 *
 * /나는으로 등록한 디스코드 유저ID↔owner 매핑이 있으면 그걸 정확히 쓰고, 없을 때만
 * ownerMatch.ts의 이름 근사매칭으로 폴백한다 — 폴백 결과는 "부정확할 수 있다"는 걸
 * 반드시 사용자에게 보여준다(조용히 근사매칭만 쓰면 틀려도 알 수가 없다).
 */

import { loadBoardModel } from '../loadBoard.ts';
import { isActiveStatus } from '../../../src/lib/board.ts';
import { getOwnerByDiscordUser } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse } from '../responses.ts';
import { buildEmbed, myApplicationLine, emptyStateLine } from '../embeds.ts';
import { matchesOwner } from '../ownerMatch.ts';
import { callerDisplayName, callerUserId, type DiscordInteraction } from '../types.ts';
import type { ApplicationView } from '../../../src/lib/board.ts';

const APPROX_MATCH_NOTICE = '이름으로 근사 매칭한 결과라 정확하지 않을 수 있습니다. /나는으로 등록하면 정확해집니다.';

export function handleMyDeadlinesCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondMyDeadlines(interaction, env));
  return deferredMessageResponse(true);
}

async function respondMyDeadlines(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    const caller = callerDisplayName(interaction);
    const userId = callerUserId(interaction);
    const mappedOwner = userId ? await getOwnerByDiscordUser(env.DB, userId) : null;

    const isMine = (v: ApplicationView) =>
      mappedOwner ? v.application.owner === mappedOwner : matchesOwner(v.application.owner, caller);

    const mine = board.applications
      .filter((v) => isActiveStatus(v.application.status) && isMine(v))
      .sort((a, b) => (a.deadline?.daysLeft ?? Infinity) - (b.deadline?.daysLeft ?? Infinity));

    const displayName = mappedOwner ?? caller;
    const description =
      mine.length > 0
        ? mine.map(myApplicationLine).join('\n\n')
        : emptyStateLine(`"${displayName}" 담당으로 매칭되는 진행 중 지원건이 없습니다.`);

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed(
          `🙋 ${displayName}님의 마감 현황`,
          description,
          mine.length > 0 ? 'blue' : 'green',
          mappedOwner ? undefined : APPROX_MATCH_NOTICE,
        ),
      ],
    });
  } catch (err) {
    console.error('/내마감 처리 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 마감 현황을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
