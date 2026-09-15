/**
 * 인터랙션 응답 JSON을 만드는 공통 헬퍼. 여기서 만든 값은 전부
 * `new Response(JSON.stringify(...), { headers: { 'content-type': 'application/json' } })`로
 * 감싸 그대로 반환할 수 있는 인터랙션 응답 바디(type + data)다.
 */

import { InteractionResponseType, MessageFlags } from './types.ts';
import type { DiscordEmbed } from './embeds.ts';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** PING에 대한 PONG. */
export function pongResponse(): Response {
  return jsonResponse({ type: InteractionResponseType.PONG });
}

/** 즉시 채널에 메시지로 응답한다. ephemeral=true면 호출자에게만 보인다. */
export function messageResponse(
  content: string | null,
  opts: { embeds?: DiscordEmbed[]; components?: unknown[]; ephemeral?: boolean } = {},
): Response {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: content ?? undefined,
      embeds: opts.embeds,
      components: opts.components,
      flags: opts.ephemeral ? MessageFlags.EPHEMERAL : undefined,
    },
  });
}

/** 에러를 호출자에게만 보이는 짧은 메시지로 응답한다. 스택트레이스는 절대 포함하지 않는다. */
export function errorMessageResponse(userFacingMessage: string): Response {
  return messageResponse(`⚠️ ${userFacingMessage}`, { ephemeral: true });
}

/** D1 조회/쓰기가 3초를 넘길 수 있는 커맨드용. 이후 discordApi.editOriginalResponse로 실제 내용을 채운다. */
export function deferredMessageResponse(ephemeral = true): Response {
  return jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: ephemeral ? MessageFlags.EPHEMERAL : undefined },
  });
}

/** 컴포넌트(버튼/셀렉트) 클릭 후 원본 메시지를 즉시 갱신한다(DB 접근 없이 빠르게 끝날 때). */
export function updateMessageResponse(
  content: string | null,
  opts: { embeds?: DiscordEmbed[]; components?: unknown[] } = {},
): Response {
  return jsonResponse({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { content: content ?? undefined, embeds: opts.embeds, components: opts.components },
  });
}

/** 컴포넌트 클릭 후 D1 쓰기가 필요해 지연시킬 때. 이후 discordApi.editOriginalResponse로 갱신한다. */
export function deferredUpdateResponse(): Response {
  return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
}

export function modalResponse(customId: string, title: string, components: unknown[]): Response {
  return jsonResponse({
    type: InteractionResponseType.MODAL,
    data: { custom_id: customId, title, components },
  });
}
