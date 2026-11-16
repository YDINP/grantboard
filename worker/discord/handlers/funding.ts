/**
 * /자금 현황, /자금 설정.
 *
 * 왜 별도 커맨드인가: 기존 보드는 마감일 축 하나로 돌아간다. 돈은 성격이 다르면 비교가 안 되고
 * (상금 300만원과 융자 300만원은 같은 값이 아니다), support_amount는 자유 문장이라 더할 수 없었다.
 * 집계 규칙 자체는 src/lib/funding.ts에 있고 이 파일은 표시만 한다.
 *
 * `/자금 설정`은 2단계다. 성격·금액을 슬래시 옵션으로 먼저 받고(그래서 모달 5칸 제약과 무관하다),
 * 대상 공고는 드롭다운으로 고른다. 입력값은 드롭다운 custom_id에 실어 보낸다 —
 * 디스코드가 인터랙션 사이 상태를 보관해주지 않기 때문이다(customId.ts 머리말 참고).
 *
 * 채널 라우팅 코드를 따로 두지 않은 이유: 슬래시 커맨드 응답은 호출한 채널에 뜬다.
 * 자금 전용 채널에서 /자금을 치면 그 채널에 뜨므로 env에 채널 ID를 하나 더 둘 필요가 없다.
 * (크론 알림은 공고 마감 알림이라 기존 DISCORD_CHANNEL_ID 그대로가 맞다.)
 */

import { loadBoardModel } from '../loadBoard.ts';
import { getProgram, upsertProgram } from '../../db/repo.ts';
import { editOriginalResponse } from '../discordApi.ts';
import { deferredMessageResponse, deferredUpdateResponse, errorMessageResponse } from '../responses.ts';
import { buildEmbed, emptyStateLine } from '../embeds.ts';
import { encodeCustomId, decodeCustomId } from '../customId.ts';
import {
  FUNDING_TYPES,
  FUNDING_SUBCOMMANDS,
  FUNDING_TYPE_OPTION,
  FUNDING_AMOUNT_OPTION,
  FUNDING_BURDEN_OPTION,
} from '../commands.ts';
import { programSelectOptions, sortProgramsByUrgency, paginate } from '../selectOptions.ts';
import { findSubcommand, optionValue } from './programs.ts';
import { ComponentType, ButtonStyle } from '../types.ts';
import type { DiscordInteraction } from '../types.ts';
import type { ProgramView } from '../../../src/lib/board.ts';
import {
  reachableViews,
  summarizeFunding,
  formatKrw,
  type FundingType,
  type Funding,
} from '../../../src/lib/funding.ts';

// ---------------------------------------------------------------------------
// /자금 현황
// ---------------------------------------------------------------------------

export function handleFundingViewCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(respondFundingView(interaction, env));
  return deferredMessageResponse(true);
}

async function respondFundingView(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    const reachable = reachableViews(board.programs);
    const summary = summarizeFunding(reachable);

    if (reachable.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        embeds: [
          buildEmbed(
            '💰 지금 노릴 수 있는 자금',
            emptyStateLine('마감 전인 공고가 없습니다. 먼저 /공고 추가로 공고를 등록해 주세요.'),
            'gray',
          ),
        ],
      });
      return;
    }

    const lines: string[] = [];
    lines.push(
      summary.buckets.length > 0
        ? `합계 **${formatKrw(summary.netKrw)}** · 금액이 적힌 ${countedTotal(summary.buckets)}건 기준`
        : '아직 자금 성격이 입력된 공고가 없습니다.',
    );

    if (summary.buckets.length > 0) {
      lines.push('');
      for (const bucket of summary.buckets) {
        const counted = bucket.countedCount === bucket.count ? `${bucket.count}건` : `${bucket.count}건 중 ${bucket.countedCount}건 집계`;
        lines.push(`**${bucket.type}** ${formatKrw(bucket.netKrw)} · ${counted}`);
      }
    }

    // 빠진 것을 반드시 같이 보여준다 — 합계만 보면 "이게 전부"로 읽히고, 그 오해가
    // 자금 계획을 과소평가로 몰아간다. 집계에서 빠진 이유를 건수로 드러낸다.
    const gaps: string[] = [];
    if (summary.unknownAmountCount > 0) {
      gaps.push(`금액 미기입 ${summary.unknownAmountCount}건 — 합계에 빠져 있습니다`);
    }
    if (summary.unclassifiedCount > 0) {
      gaps.push(`성격 미분류 ${summary.unclassifiedCount}건 — \`/자금 설정\`으로 분류하세요`);
    }
    if (gaps.length > 0) {
      lines.push('');
      lines.push(gaps.map((g) => `⚠️ ${g}`).join('\n'));
    }

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed(
          '💰 지금 노릴 수 있는 자금',
          lines.join('\n'),
          summary.netKrw > 0 ? 'green' : 'gray',
          '마감된 공고와 자격 미달(명백한 부적격)은 제외. 자기부담금을 뺀 실수령 추정액입니다.',
        ),
      ],
    });
  } catch (err) {
    console.error('/자금 현황 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 자금 현황을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}

function countedTotal(buckets: readonly { countedCount: number }[]): number {
  return buckets.reduce((sum, b) => sum + b.countedCount, 0);
}

// ---------------------------------------------------------------------------
// /자금 설정 — 1단계: 입력값 검증 후 공고 드롭다운
// ---------------------------------------------------------------------------

/** 만원 단위 입력을 원으로 바꾼다. 쉼표는 허용, 그 외 문자는 거부. */
export function parseAmountMan(raw: string | undefined): { ok: true; krw?: number } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true }; // 미입력 = 금액 모름. 0이 아니다.
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+$/.test(cleaned)) {
    return { ok: false, reason: `금액은 만원 단위 숫자로만 입력해 주세요 (입력값: ${raw}).` };
  }
  return { ok: true, krw: Number(cleaned) * 10_000 };
}

export function parseBurdenPct(raw: string | undefined): { ok: true; pct?: number } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true };
  const cleaned = raw.replace(/%/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, reason: `자기부담 비율은 0~100 사이 숫자로 입력해 주세요 (입력값: ${raw}).` };
  }
  const pct = Number(cleaned);
  if (pct > 100) return { ok: false, reason: `자기부담 비율이 100%를 넘습니다 (입력값: ${raw}).` };
  return { ok: true, pct };
}

export function handleFundingSetCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const sub = findSubcommand(interaction.data?.options, FUNDING_SUBCOMMANDS.SET);
  const type = optionValue(sub?.options, FUNDING_TYPE_OPTION);
  const amountRaw = optionValue(sub?.options, FUNDING_AMOUNT_OPTION);
  const burdenRaw = optionValue(sub?.options, FUNDING_BURDEN_OPTION);

  if (!type || !(FUNDING_TYPES as readonly string[]).includes(type)) {
    return errorMessageResponse(`성격은 ${FUNDING_TYPES.join(', ')} 중 하나여야 합니다 (입력값: ${type || '(빈 값)'}).`);
  }
  const amount = parseAmountMan(amountRaw);
  if (!amount.ok) return errorMessageResponse(amount.reason);
  const burden = parseBurdenPct(burdenRaw);
  if (!burden.ok) return errorMessageResponse(burden.reason);

  // 금액이 없는데 자기부담만 있으면 계산할 대상이 없다 — 조용히 무시하지 않고 알려준다.
  if (amount.krw === undefined && burden.pct !== undefined) {
    return errorMessageResponse('자기부담 비율만으로는 실수령액을 계산할 수 없습니다. 금액도 함께 입력해 주세요.');
  }

  const packed = packFunding(type as FundingType, amount.krw, burden.pct);
  ctx.waitUntil(respondProgramSelect(interaction, env, 0, packed));
  return deferredMessageResponse(true);
}

/**
 * 입력값을 custom_id에 실을 문자열로 묶는다. custom_id는 100바이트 제한이라 짧게 유지한다 —
 * 금액은 만원 단위 그대로, 미입력은 빈 문자열로 둔다.
 */
function packFunding(type: FundingType, krw: number | undefined, pct: number | undefined): string[] {
  return [type, krw === undefined ? '' : String(krw / 10_000), pct === undefined ? '' : String(pct)];
}

function unpackFunding(params: readonly string[]): Funding | null {
  const [type = '', manStr = '', pctStr = ''] = params;
  if (!(FUNDING_TYPES as readonly string[]).includes(type)) return null;
  const funding: Funding = { type: type as FundingType };
  if (manStr !== '') funding.amountKrw = Number(manStr) * 10_000;
  if (pctStr !== '') funding.selfBurdenPct = Number(pctStr);
  return funding;
}

function buildProgramSelectMessage(views: readonly ProgramView[], page: number, packed: readonly string[]) {
  const { items, page: clampedPage, totalPages } = paginate(views, page);

  const components: unknown[] = [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.STRING_SELECT,
          custom_id: encodeCustomId('funding', 'select-program', ...packed),
          placeholder: `공고 선택 (${clampedPage + 1}/${totalPages}페이지)`,
          options: programSelectOptions(items),
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
          custom_id: encodeCustomId('funding', 'select-program-page', String(clampedPage - 1), ...packed),
          disabled: clampedPage <= 0,
        },
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: '다음 ▶',
          custom_id: encodeCustomId('funding', 'select-program-page', String(clampedPage + 1), ...packed),
          disabled: clampedPage >= totalPages - 1,
        },
      ],
    });
  }

  const funding = unpackFunding(packed);
  const amountText =
    funding?.amountKrw === undefined ? '금액 미입력' : formatKrw(funding.amountKrw);
  const burdenText = funding?.selfBurdenPct === undefined ? '' : ` · 자기부담 ${funding.selfBurdenPct}%`;
  return {
    content: `자금 정보를 넣을 공고를 선택해 주세요.\n입력값: **${funding?.type ?? '?'}** · ${amountText}${burdenText}`,
    components,
  };
}

async function respondProgramSelect(
  interaction: DiscordInteraction,
  env: Env,
  page: number,
  packed: readonly string[],
): Promise<void> {
  try {
    const board = await loadBoardModel(env.DB);
    if (board.programs.length === 0) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: emptyStateLine('등록된 공고가 없습니다. 먼저 /공고 추가로 공고를 등록해 주세요.'),
      });
      return;
    }
    // 마감 지난 공고도 남긴다 — 지난 회차에 금액을 기록해두면 다음 회차 판단에 쓸 수 있다.
    // 집계에서는 src/lib/funding.ts의 reachableViews가 알아서 뺀다.
    const views = sortProgramsByUrgency(board.programs);
    await editOriginalResponse(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      buildProgramSelectMessage(views, page, packed),
    );
  } catch (err) {
    console.error('/자금 설정 1단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 공고 목록을 불러오는 중 오류가 발생했습니다.',
    });
  }
}

/** 페이지 버튼. DB 읽기가 있으므로 defer. */
export function handleFundingProgramPage(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const [pageStr = '0', ...packed] = decoded.params;
  ctx.waitUntil(respondProgramSelect(interaction, env, Number(pageStr) || 0, packed));
  return deferredUpdateResponse();
}

// ---------------------------------------------------------------------------
// /자금 설정 — 2단계: 공고 선택 → D1 쓰기
// ---------------------------------------------------------------------------

export function handleFundingProgramSelect(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  const programId = interaction.data?.values?.[0];
  ctx.waitUntil(applyFunding(interaction, env, programId, decoded.params));
  return deferredUpdateResponse();
}

async function applyFunding(
  interaction: DiscordInteraction,
  env: Env,
  programId: string | undefined,
  packed: readonly string[],
): Promise<void> {
  const funding = unpackFunding(packed);
  if (!programId || !funding) {
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 잘못된 선택입니다. /자금 설정을 다시 실행해 주세요.',
      components: [],
    });
    return;
  }

  try {
    const program = await getProgram(env.DB, programId);
    if (!program) {
      await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
        content: '⚠️ 그 공고를 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.',
        components: [],
      });
      return;
    }

    const before = program.funding;
    await upsertProgram(env.DB, { ...program, funding });

    const amountText = funding.amountKrw === undefined ? '금액 미입력' : formatKrw(funding.amountKrw);
    const burdenText = funding.selfBurdenPct === undefined ? '' : `\n자기부담 ${funding.selfBurdenPct}%`;
    // 덮어쓴 경우엔 이전 값을 같이 보여준다 — 손으로 넣은 금액을 모르고 지우는 일을 막는다.
    const prevText =
      before === undefined
        ? ''
        : `\n\n이전 값: ${before.type} · ${before.amountKrw === undefined ? '금액 미입력' : formatKrw(before.amountKrw)}`;

    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      embeds: [
        buildEmbed(
          '✅ 자금 정보 저장됨',
          `**${program.title}**\n${funding.type} · ${amountText}${burdenText}${prevText}`,
          'green',
        ),
      ],
      components: [],
    });
  } catch (err) {
    console.error('/자금 설정 2단계 실패', err instanceof Error ? err.message : String(err));
    await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: '⚠️ 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      components: [],
    });
  }
}
