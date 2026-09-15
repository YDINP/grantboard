/**
 * /공고 추가, /공고 목록.
 *
 * "추가"는 모달 폼으로 즉시 응답한다(DB 접근 없음 → defer 불필요). 모달 제출(MODAL_SUBMIT)은
 * D1 쓰기가 있으므로 defer한다.
 * "목록"은 D1 읽기이므로 defer하고, 카테고리/상태 필터와 페이지 번호를 버튼 custom_id에
 * 인코딩해 이전/다음 페이지를 넘긴다.
 */

import { loadBoardModel } from '../loadBoard.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, deferredUpdateResponse, modalResponse } from '../responses.ts';
import { buildEmbed, programLine, emptyStateLine } from '../embeds.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import { CATEGORY_CHOICES, PROGRAM_SUBCOMMANDS } from '../commands.ts';
import { validateDateStr } from '../dateValidation.ts';
import { generateId } from '../idGen.ts';
import { ComponentType, TextInputStyle, ButtonStyle } from '../types.ts';
import type { DiscordInteraction, DiscordCommandOption } from '../types.ts';
import type { Program, ProgramView } from '../../../src/lib/board.ts';
import type { DeadlineState } from '../../../src/lib/schedule.ts';
import { upsertProgram } from '../../db/repo.ts';
import { syncStatusBoard } from '../statusBoard.ts';

const PAGE_SIZE = 8;
const MODAL_ID = encodeCustomId('programs', 'add-submit');

export function findSubcommand(options: DiscordCommandOption[] | undefined, name: string): DiscordCommandOption | undefined {
  return options?.find((o) => o.name === name);
}

export function optionValue(options: DiscordCommandOption[] | undefined, name: string): string | undefined {
  const opt = options?.find((o) => o.name === name);
  return typeof opt?.value === 'string' ? opt.value : undefined;
}

/** '/공고 추가' 서브커맨드 — 즉시 모달을 띄운다. */
export function handleProgramAddOpen(): Response {
  return modalResponse(MODAL_ID, '공고 추가', [
    textInputRow('title', '공고명', TextInputStyle.SHORT, true),
    textInputRow('organizer', '주관기관', TextInputStyle.SHORT, true),
    textInputRow('applyEnd', '마감일 (YYYY-MM-DD)', TextInputStyle.SHORT, true),
    textInputRow('sourceUrl', 'URL', TextInputStyle.SHORT, true),
    textInputRow('category', `카테고리 (${CATEGORY_CHOICES.join('/')})`, TextInputStyle.SHORT, true),
  ]);
}

function textInputRow(customId: string, label: string, style: number, required: boolean) {
  return {
    type: ComponentType.ACTION_ROW,
    components: [{ type: ComponentType.TEXT_INPUT, custom_id: customId, label, style, required }],
  };
}

function modalFieldValue(interaction: DiscordInteraction, customId: string): string {
  for (const row of interaction.data?.components ?? []) {
    const field = row.components.find((c) => c.custom_id === customId);
    if (field) return (field.value ?? '').trim();
  }
  return '';
}

/** 모달 제출 — D1 쓰기이므로 defer 후 검증·저장한다. */
export function handleProgramAddSubmit(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(saveNewProgram(interaction, env));
  return deferredMessageResponse(true);
}

async function saveNewProgram(interaction: DiscordInteraction, env: Env): Promise<void> {
  const title = modalFieldValue(interaction, 'title');
  const organizer = modalFieldValue(interaction, 'organizer');
  const applyEnd = modalFieldValue(interaction, 'applyEnd');
  const sourceUrl = modalFieldValue(interaction, 'sourceUrl');
  const category = modalFieldValue(interaction, 'category');

  const dateCheck = validateDateStr(applyEnd);
  if (!dateCheck.ok) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, { content: `⚠️ 마감일 — ${dateCheck.reason}` });
    return;
  }
  if (!(CATEGORY_CHOICES as readonly string[]).includes(category)) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: `⚠️ 카테고리는 ${CATEGORY_CHOICES.join(', ')} 중 하나여야 합니다 (입력값: ${category || '(빈 값)'}).`,
    });
    return;
  }

  const program: Program = {
    id: generateId(title),
    title,
    organizer,
    sourceUrl,
    category: category as Program['category'],
    applyEnd,
    tags: [],
    source: 'manual',
    aliasTitles: [],
  };

  try {
    await upsertProgram(env.DB, program);
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('✅ 공고 추가됨', `**${program.title}**\n마감 ${program.applyEnd} · ${program.organizer}`, 'green')],
    });
    // 응답은 이미 보냈다 — 현황판 갱신은 그 뒤에 이어서 하고, 실패해도 위 응답에 영향 없다(syncStatusBoard 내부에서 삼킴).
    await syncStatusBoard(env);
  } catch (err) {
    console.error('/공고 추가 저장 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}

function filterViews(views: ProgramView[], category: string, status: string): ProgramView[] {
  return views.filter(
    (v) => (!category || v.program.category === category) && (!status || v.deadline.state === (status as DeadlineState)),
  );
}

function buildListPage(
  views: ProgramView[],
  page: number,
  category: string,
  status: string,
): { content: string; components: unknown[] } {
  const totalPages = Math.max(1, Math.ceil(views.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageViews = views.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  const content =
    pageViews.length > 0 ? pageViews.map(programLine).join('\n\n') : emptyStateLine('조건에 맞는 공고가 없습니다.');
  const footer = `페이지 ${clampedPage + 1}/${totalPages} · 총 ${views.length}건`;

  const components = [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: '◀ 이전',
          custom_id: encodeCustomId('programs', 'list-page', String(clampedPage - 1), category, status),
          disabled: clampedPage <= 0,
        },
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: '다음 ▶',
          custom_id: encodeCustomId('programs', 'list-page', String(clampedPage + 1), category, status),
          disabled: clampedPage >= totalPages - 1,
        },
      ],
    },
  ];

  return { content: `${content}\n\n${footer}`, components };
}

/** '/공고 목록' 서브커맨드 — D1 읽기이므로 defer. */
export function handleProgramListCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const sub = findSubcommand(interaction.data?.options, PROGRAM_SUBCOMMANDS.LIST);
  const category = optionValue(sub?.options, '카테고리') ?? '';
  const status = optionValue(sub?.options, '상태') ?? '';
  ctx.waitUntil(respondProgramList(interaction, env, category, status));
  return deferredMessageResponse(true);
}

async function respondProgramList(interaction: DiscordInteraction, env: Env, category: string, status: string): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    const filtered = filterViews(board.programs, category, status);
    const { content, components } = buildListPage(filtered, 0, category, status);
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('📋 공고 목록', content, 'blue')],
      components,
    });
  } catch (err) {
    console.error('/공고 목록 처리 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 목록을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}

/** 공고 목록 이전/다음 페이지 버튼 클릭. */
export function handleProgramListPage(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const [pageStr = '0', category = '', status = ''] = decoded.params;
  ctx.waitUntil(updateProgramListPage(interaction, env, Number(pageStr) || 0, category, status));
  return deferredUpdateResponse();
}

async function updateProgramListPage(
  interaction: DiscordInteraction,
  env: Env,
  page: number,
  category: string,
  status: string,
): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    const filtered = filterViews(board.programs, category, status);
    const { content, components } = buildListPage(filtered, page, category, status);
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [buildEmbed('📋 공고 목록', content, 'blue')],
      components,
    });
  } catch (err) {
    console.error('/공고 목록 페이지 이동 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
}
