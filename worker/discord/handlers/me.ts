/**
 * /나는 — 디스코드 계정 ↔ 담당자 이니셜 매핑을 등록한다.
 * /내마감이 이름 근사매칭 대신 이 매핑을 우선 쓰게 하기 위함이다(myDeadlines.ts 참고).
 */

import { setOwnerMapping } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse } from '../responses.ts';
import { buildEmbed } from '../embeds.ts';
import { ME_OWNER_OPTION } from '../commands.ts';
import { callerUserId } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';

const OWNER_MAX_LENGTH = 4;

export function handleMeCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(saveMapping(interaction, env));
  return deferredMessageResponse(true);
}

async function saveMapping(interaction: DiscordInteraction, env: Env): Promise<void> {
  const owner = interaction.data?.options?.find((o) => o.name === ME_OWNER_OPTION)?.value;
  const userId = callerUserId(interaction);

  if (typeof owner !== 'string' || !owner.trim()) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, { content: '⚠️ 이니셜을 입력해 주세요.' });
    return;
  }
  const trimmed = owner.trim();
  // Discord 옵션의 max_length로도 막히지만, 클라이언트가 다를 수 있어 서버에서도 스키마(owner.max(4))를 그대로 지킨다.
  if (trimmed.length > OWNER_MAX_LENGTH) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: `⚠️ 이니셜은 최대 ${OWNER_MAX_LENGTH}자입니다 (입력값: ${trimmed}, ${trimmed.length}자). 실명 대신 짧은 닉네임/이니셜을 써 주세요.`,
    });
    return;
  }
  if (!userId) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 디스코드 사용자 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    });
    return;
  }

  try {
    await setOwnerMapping(env.DB, userId, trimmed);
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed('✅ 등록됨', `이제부터 /내마감에서 **${trimmed}** 담당 항목을 정확히 찾아 드립니다.`, 'green'),
      ],
    });
  } catch (err) {
    console.error('/나는 처리 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 등록 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
