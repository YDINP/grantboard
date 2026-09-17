/**
 * CRON_DEADLINE_CLOSED(KST 09:00)가 부르는 진입점. "마감됐다"는 사실을 공고당 딱 한 번만
 * 알린다. worker/cron/deadlineTomorrow.ts와 구조를 맞춘다: 무엇을 담을지(selectDeadlineClosed)는
 * 순수 함수(src/lib/deadlineClosed.ts)에 맡기고, 여기서는 Discord embed 조립 + D1 읽기/쓰기 +
 * 채널 전송(재시도 포함)만 한다.
 *
 * 마감 지난 공고는 이후 계속 마감 상태이므로, "오늘 딱 한 번"만 알리려면 bot_state에 KST 날짜
 * 커서(closureAnnouncedThrough)를 둬야 한다. 이 커서를 읽고/전진시키는 책임이 이 모듈에 있다 —
 * src/lib/deadlineClosed.ts는 커서를 받아 필터링만 할 뿐 쓰지 않는다.
 */

import { loadAll } from '../db/repo.ts';
import { getBotState, setBotState } from '../db/repo.ts';
import {
  selectDeadlineClosed,
  type ClosedProgramItem,
  type ClosureCategory,
} from '../../src/lib/deadlineClosed.ts';
import { isLinkable } from '../../src/lib/format.ts';
import { kstDateParts, toDateStr } from '../../src/lib/schedule.ts';
import { isPreSubmitStatus, type ApplicationView } from '../../src/lib/board.ts';
import { postChannelMessage } from '../discord/discordApi.ts';
import { TONE_COLOR, type DiscordEmbed } from '../discord/embeds.ts';
import { CALENDAR_URL } from '../discord/statusBoard.ts';

const MAX_RETRIES = 3;
/** Discord embed description 상한(4096자). 다른 cron 모듈들과 같은 값 — 플랫폼 제약이지
 *  공유하는 상수는 아니라서 따로 둔다. */
const EMBED_DESCRIPTION_LIMIT = 4096;

/** bot_state에 저장하는 KST 날짜 커서 키. 값은 'YYYY-MM-DD' 하나뿐인 불투명 문자열이다(JSON 아님) —
 *  repo(getBotState/setBotState)는 이 값을 파싱하지 않고 그대로 왕복시킨다. */
const CURSOR_KEY = 'closureAnnouncedThrough';

function backoffMs(attempt: number): number {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** owner 필드를 가진 항목 목록에서 중복 없는 담당자 표시 문자열을 만든다. 비어 있으면 null(표시 안 함). */
function ownersOf(items: { application: { owner: string } }[]): string | null {
  if (items.length === 0) return null;
  return [...new Set(items.map((i) => i.application.owner))].join(', ');
}

/** 'YYYY-MM-DD' → 'M/D'. */
function shortDate(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** unsubmitted 항목에서 "미제출(상태)" 괄호 안에 보여줄 상태 목록. 제출 전 단계만, 중복 없이. */
function preSubmitStatusLabel(applications: ApplicationView[]): string {
  const statuses = [...new Set(applications.filter((v) => isPreSubmitStatus(v.application.status)).map((v) => v.application.status))];
  return statuses.join(', ');
}

const CATEGORY_PREFIX: Record<ClosureCategory, string> = {
  submitted: '✅',
  unsubmitted: '⛔',
  unapplied: '⚪',
};

function categoryLabel(item: ClosedProgramItem): string {
  switch (item.category) {
    case 'submitted':
      return '제출완료';
    case 'unsubmitted':
      return `미제출(${preSubmitStatusLabel(item.view.applications)})`;
    case 'unapplied':
      return '미지원';
  }
}

function deadlineClosedLine(item: ClosedProgramItem): string {
  const { view } = item;
  const owners = ownersOf(view.applications);
  const ownerSuffix = owners ? ` · 담당 ${owners}` : '';
  const link = isLinkable(view.program.sourceUrl) ? `\n   ${view.program.sourceUrl}` : '';
  return `${CATEGORY_PREFIX[item.category]} **${view.program.title}** · ${shortDate(view.program.applyEnd)} 마감 · ${categoryLabel(item)}${ownerSuffix}${link}`;
}

/**
 * 마감 통지 embed를 조립한다. 색은 항상 중립(TONE_COLOR.neutral) — 이미 지난 일이라 급하다는
 * 신호(빨강/주황)를 줄 이유가 없다. 정보 전달용 알림이다.
 */
export function buildDeadlineClosedEmbed(items: ClosedProgramItem[]): DiscordEmbed {
  const body = items.map(deadlineClosedLine).join('\n\n');
  const trailer = `\n\n📅 [달력에서 전체 보기](${CALENDAR_URL})`;
  const budget = EMBED_DESCRIPTION_LIMIT - trailer.length;
  const truncated =
    body.length > budget ? body.slice(0, Math.max(0, budget - '\n\n…(내용이 많아 일부 생략됨)'.length)) + '\n\n…(내용이 많아 일부 생략됨)' : body;

  return {
    title: `📕 마감된 공고 — ${items.length}건`,
    description: truncated + trailer,
    color: TONE_COLOR.neutral,
  };
}

/**
 * 최대 MAX_RETRIES회 지수 백오프로 재시도한다. 최종 실패해도 예외를 던지지 않는다 —
 * 알림 전송 실패는 크론 전체를 죽일 이유가 아니다. 대신 console.error로 명확히 남긴다.
 */
async function sendWithRetry(
  channelId: string,
  botToken: string,
  payload: Record<string, unknown>,
): Promise<{ sent: boolean }> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await postChannelMessage(channelId, botToken, payload);
    if (result.ok) return { sent: true };

    lastStatus = result.status;
    if (attempt < MAX_RETRIES) {
      console.warn(
        `[cron:deadlineClosed] 디스코드 전송 실패(시도 ${attempt}/${MAX_RETRIES}, status=${result.status}) — ${backoffMs(attempt)}ms 후 재시도합니다.`,
      );
      await sleep(backoffMs(attempt));
    }
  }
  console.error(
    `[cron:deadlineClosed] 디스코드 전송이 ${MAX_RETRIES}회 재시도 후에도 실패했습니다(마지막 status=${lastStatus}). 알림이 나가지 않았습니다 — 확인이 필요합니다.`,
  );
  return { sent: false };
}

/**
 * getBotState/setBotState를 주입 가능하게 만든 의존성. 기본값은 진짜 구현이라
 * sendDeadlineClosed(env) 한 인자 호출만으로 지금까지와 동일하게 동작한다 — statusBoard.ts의
 * DI 패턴을 따른다. 테스트에서는 D1 없이 커서를 in-memory로 목킹하기 위해 이걸 갈아 끼운다.
 */
export interface DeadlineClosedDeps {
  getBotState: typeof getBotState;
  setBotState: typeof setBotState;
}

const defaultDeps: DeadlineClosedDeps = { getBotState, setBotState };

export interface SendDeadlineClosedOptions {
  /** true면 embed를 조립·로그만 하고 실제 전송은 하지 않는다. worker/cron/digest.ts의
   *  CRON_DRY_RUN과 같은 스위치를 공유한다(.dev.vars 전용, wrangler secret/vars에 넣지 않는다).
   *  dry-run은 커서(bot_state)도 건드리지 않는다 — "확정"이 아닌 확인용 실행이 실제 운영의
   *  중복 방지 상태를 조용히 바꿔버리면 안 되기 때문이다. */
  dryRun?: boolean;
  now?: Date;
}

export interface SendDeadlineClosedResult {
  /** 실제로 전송했는지. dry-run이거나 마감 통지 대상이 없거나 전송이 최종 실패하면 false. */
  sent: boolean;
  /** 조립된 embed의 본문(description). 보낼 게 없으면 null(오늘 마감통지일이 된 공고가 없는 날). */
  message: string | null;
}

export async function sendDeadlineClosed(
  env: Env,
  options: SendDeadlineClosedOptions = {},
  deps: DeadlineClosedDeps = defaultDeps,
): Promise<SendDeadlineClosedResult> {
  const today = options.now ?? new Date();
  const { year, month, day } = kstDateParts(today);
  const todayStr = toDateStr(year, month, day);

  const cursor = await deps.getBotState(env.DB, CURSOR_KEY);
  const { programs, applications, documents, profile } = await loadAll(env.DB);
  const items = selectDeadlineClosed(programs, applications, documents, profile, today, cursor);

  if (items.length === 0) {
    // 알릴 게 없으면 잃을 게 없다 — 전송할 것도 없으니 커서를 바로 오늘로 전진시킨다.
    // 안 그러면 "조용한 날"이 쌓여 다음에 알릴 때 간격이 벌어진다. dry-run은 예외다(아래 참고).
    if (!options.dryRun) {
      await deps.setBotState(env.DB, CURSOR_KEY, todayStr);
    }
    console.log(
      `[cron:deadlineClosed] 오늘 마감통지일이 된 공고가 없습니다 — 전송하지 않습니다. (cursor: ${cursor ?? 'null(최초)'} → ${options.dryRun ? cursor ?? 'null(최초, dry-run이라 유지)' : todayStr})`,
    );
    return { sent: false, message: null };
  }

  const embed = buildDeadlineClosedEmbed(items);

  if (options.dryRun) {
    console.log(`[cron:deadlineClosed] CRON_DRY_RUN — 대상 ${items.length}건. 조립된 embed를 전송하지 않고 로그로만 남깁니다(커서 미전진).`);
    console.log(JSON.stringify(embed));
    return { sent: false, message: embed.description ?? null };
  }

  // 이미 지난 일이라 지금 당장 할 수 있는 행동이 없다 — @here/@everyone 둘 다 절대 쓰지 않는다.
  const payload: Record<string, unknown> = {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };

  const { sent } = await sendWithRetry(env.DISCORD_CHANNEL_ID, env.DISCORD_BOT_TOKEN, payload);

  // 커서는 "정확히 한 번(exactly-once)" 통지를 약속한다 — 그래서 전송이 실제로 성공했을 때만
  // 전진시킨다. 먼저 전진시키고 나중에 전송하면(과거에 그렇게 짜여 있었다) 디스코드 장애·봇
  // 토큰 만료·채널 삭제 등으로 MAX_RETRIES를 다 소진했을 때 커서는 이미 오늘을 가리키고 있어서
  // 이 공고들은 영원히 다시 통지되지 않는다 — 아무 로그도 남기지 않는 "조용한 유실"이다.
  // 반대로 여기서 sent가 true인데 setBotState 자체가 실패하면(D1 순간 장애 등) 다음 날 실행이
  // 같은 공고를 한 번 더 통지할 수 있다 — 그건 "중복"이라 눈에 띈다("어제도 왔는데?"). 실패의
  // 두 방향(조용한 유실 vs 눈에 띄는 중복) 중 하나만 고를 수 있다면 항상 눈에 띄는 쪽을 고른다.
  // ⚠️ 이 순서를 "중복이 나니 되돌리자"며 앞으로 옮기지 말 것 — 그 순간 유실 버그가 부활한다.
  if (sent) {
    await deps.setBotState(env.DB, CURSOR_KEY, todayStr);
  }

  return { sent, message: embed.description ?? null };
}
