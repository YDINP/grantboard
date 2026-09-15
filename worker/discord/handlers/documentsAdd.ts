/**
 * /서류 추가 — 모달로 서류명·종류·발급일·유효일수를 받아 등록한다.
 * 모달을 띄우는 것 자체는 DB 접근이 없어 즉시 응답하고, 제출(MODAL_SUBMIT)은 D1 쓰기라 defer한다.
 */

import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, modalResponse } from '../responses.ts';
import { buildEmbed } from '../embeds.ts';
import { encodeCustomId } from '../customId.ts';
import { validateDateStr } from '../dateValidation.ts';
import { generateId } from '../idGen.ts';
import { DOCUMENT_KIND_CHOICES } from '../commands.ts';
import { ComponentType, TextInputStyle } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';
import type { Document } from '../../../src/lib/board.ts';
import { upsertDocument } from '../../db/repo.ts';

const MODAL_ID = encodeCustomId('documents', 'add-submit');

function textInputRow(customId: string, label: string, required: boolean) {
  return {
    type: ComponentType.ACTION_ROW,
    components: [{ type: ComponentType.TEXT_INPUT, custom_id: customId, label, style: TextInputStyle.SHORT, required }],
  };
}

function modalFieldValue(interaction: DiscordInteraction, customId: string): string {
  for (const row of interaction.data?.components ?? []) {
    const field = row.components.find((c) => c.custom_id === customId);
    if (field) return (field.value ?? '').trim();
  }
  return '';
}

/** '/서류 추가' 서브커맨드 — 즉시 모달을 띄운다. */
export function handleDocumentAddOpen(): Response {
  return modalResponse(MODAL_ID, '서류 추가', [
    textInputRow('name', '서류명', true),
    textInputRow('kind', `종류 (${DOCUMENT_KIND_CHOICES.join('/')})`, true),
    textInputRow('issuedAt', '발급일 (YYYY-MM-DD, 선택)', false),
    textInputRow('validityDays', '유효일수 (숫자, 선택)', false),
  ]);
}

/** 모달 제출 — D1 쓰기이므로 defer 후 검증·저장한다. */
export function handleDocumentAddSubmit(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(saveNewDocument(interaction, env));
  return deferredMessageResponse(true);
}

async function saveNewDocument(interaction: DiscordInteraction, env: Env): Promise<void> {
  const name = modalFieldValue(interaction, 'name');
  const kind = modalFieldValue(interaction, 'kind');
  const issuedAt = modalFieldValue(interaction, 'issuedAt');
  const validityDaysRaw = modalFieldValue(interaction, 'validityDays');

  if (!name) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, { content: '⚠️ 서류명을 입력해 주세요.' });
    return;
  }
  if (!(DOCUMENT_KIND_CHOICES as readonly string[]).includes(kind)) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: `⚠️ 종류는 ${DOCUMENT_KIND_CHOICES.join(', ')} 중 하나여야 합니다 (입력값: ${kind || '(빈 값)'}).`,
    });
    return;
  }
  // 발급일은 입력이 있을 때만 검증한다(선택 필드) — 빈 값은 "발급일 미확인"으로 그냥 둔다.
  if (issuedAt) {
    const dateCheck = validateDateStr(issuedAt);
    if (!dateCheck.ok) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, { content: `⚠️ 발급일 — ${dateCheck.reason}` });
      return;
    }
  }
  let validityDays: number | undefined;
  if (validityDaysRaw) {
    const parsed = Number(validityDaysRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: `⚠️ 유효일수는 1 이상의 정수여야 합니다 (입력값: ${validityDaysRaw}).`,
      });
      return;
    }
    validityDays = parsed;
  }

  const document: Document = {
    id: generateId(name),
    name,
    kind: kind as Document['kind'],
    reusable: true,
    issuedAt: issuedAt || undefined,
    validityDays,
    ready: false,
  };

  try {
    await upsertDocument(env.DB, document);
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('✅ 서류 등록됨', `**${document.name}** · ${document.kind}`, 'green')],
    });
  } catch (err) {
    console.error('/서류 추가 저장 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
