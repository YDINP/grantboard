/**
 * 자동 갱신되는 현황판 — 채널의 메시지 하나를 계속 편집한다(새로 올리지 않는다).
 * 데이터를 바꾸는 모든 커맨드 뒤(programs.ts/programsDelete.ts/status.ts/documentsAdd.ts/
 * documentsComplete.ts/documentsLink.ts)와 크론(worker-core 담당)에서 syncStatusBoard(env)를 부른다.
 *
 * 날짜·자격·만료 판정은 전부 loadBoard.ts(→ src/lib/board.ts)에 위임한다 — 여기서는 그 결과를
 * 사람이 읽는 embed 텍스트로 조립하기만 한다.
 *
 * ⚠️ 편집 빈도 제한(debounce): 마지막 성공 편집으로부터 DEBOUNCE_MS 안에 다시 불리면 즉시
 * 편집하지 않고, 창이 닫히는 시점에 최신 데이터로 한 번 더 반영되도록 예약만 한다(자세한 건
 * schedulePendingRetry 참고). 건너뛴 변경이 유실되는 일은 없다. /현황(수동 갱신)만 force로
 * 이 제한을 무시한다.
 *
 * ⚠️ 이 함수는 절대 예외를 밖으로 던지지 않는다. 호출자(각 커맨드 핸들러)는 이미 사용자에게
 * 원래 응답을 보낸 뒤라, 현황판 갱신이 실패해도 그 응답에 영향을 주면 안 된다.
 */

import { loadBoardModel } from './loadBoard.ts';
import { getBotState, setBotState } from '../db/repo.ts';
import { postChannelMessage, patchChannelMessage, type ChannelMessageResult } from './discordApi.ts';
import { TONE_COLOR, TONE_EMOJI, emptyStateLine } from './embeds.ts';
import { formatDday, isLinkable, DEADLINE_TONE } from '../../src/lib/format.ts';
import { ACTIVE_STATUSES, type BoardModel, type ApplicationView, type ProgramView } from '../../src/lib/board.ts';
import type { DeadlineState } from '../../src/lib/schedule.ts';
import type { DiscordEmbed } from './embeds.ts';

/**
 * 프로덕션 Worker 자신의 달력 페이지. 크론/커맨드 어디서 불릴지 몰라 request.url에서 뽑을 수 없다.
 * worker/cron/digest.ts(다이제스트 하단 링크)도 이 값을 그대로 가져다 쓴다 — 두 곳에 따로 적으면
 * 배포 도메인이 바뀔 때 한쪽만 고치고 잊어버리기 쉽다.
 */
export const CALENDAR_URL = 'https://grantboard.benclaude-toss.workers.dev/calendar';

const STATE_KEY = 'status_board';
const EMBED_DESCRIPTION_LIMIT = 4096;
/** 목록형 섹션 하나(상태 그룹 하나 포함)당 보여줄 최대 항목 수. 넘으면 "외 N건" 안내로 접는다. */
const MAX_ITEMS_PER_GROUP = 8;
const MORE_NOTICE_SUFFIX = '/공고 목록으로 전체 보기';

/**
 * 메시지 편집 최소 간격. 실무 권고(30~60초에 한 번)의 아래쪽을 택했다 — 봇 토큰 전체 기준
 * 초당 50요청이 상한이라 이 값 자체가 429를 막는 건 아니지만, 짧은 시간에 편집이 몰려
 * "현황판이 조용히 낡는" 상황(429 → 반영 안 됨)을 피하기 위한 자체 제한이다.
 */
export const DEBOUNCE_MS = 30_000;

/**
 * "재시도가 예약됨"(pending) 표시가 죽은 채로 영원히 남는 것을 막는 안전장치.
 * ctx.waitUntil 안에서 재시도가 sleep 중일 때 isolate가 회수되면 pending을 풀 코드가 아예
 * 실행되지 못할 수 있다 — 그때 이 나이 제한보다 오래된 pending은 "죽은 예약"으로 보고 무시한다.
 *
 * DEBOUNCE_MS보다 충분히 크게 잡았다: 지금 상수 관계(PENDING_TTL_MS > DEBOUNCE_MS)에서는
 * lastSyncAt 기준 elapsed가 이 나이 제한보다 먼저 DEBOUNCE_MS를 넘어 publishNow로 직행하며
 * pending을 지우므로, 정상 흐름만으로는 이 TTL이 실제로 발동할 일이 없다. 그래도 남겨두는 건
 * ①DEBOUNCE_MS가 나중에 이 값보다 커지도록 바뀌거나 ②D1 상태가 어떤 이유로든(수동 조작,
 * 버그, 시계 이상) 어긋나는 경우의 방어선이기 때문이다 — "정상 흐름에서 안 걸린다"가
 * "없어도 된다"는 뜻은 아니다.
 */
export const PENDING_TTL_MS = 120_000;

export interface StatusBoardState {
  channelId: string;
  messageId: string;
  /** ISO 8601. 마지막으로 실제 편집/생성에 성공한 시각 — debounce 판단 기준. */
  lastSyncAt?: string;
  /** debounce로 건너뛴 뒤 "창이 닫히면 한 번 더 시도"가 이미 예약되어 있는지. 중복 예약 방지용. */
  pending?: boolean;
  /** ISO 8601. pending이 true로 세워진 시각. PENDING_TTL_MS를 넘으면 죽은 예약으로 간주한다. */
  pendingSince?: string;
}

/** pending이 세워져 있고, 그 나이가 PENDING_TTL_MS 이내면 "아직 살아있는 예약"이다. */
function isPendingAlive(state: StatusBoardState, now: number): boolean {
  if (!state.pending || !state.pendingSince) return false;
  return now - Date.parse(state.pendingSince) <= PENDING_TTL_MS;
}

// ---------------------------------------------------------------------------
// 텍스트 조립 (순수 함수 — env/DB 없이 BoardModel만으로 테스트할 수 있다)
// ---------------------------------------------------------------------------

/** KST 자정 판정(schedule.ts)과 같은 +9h 이동 방식을 쓰되, 이건 '판정'이 아니라 표시용 시각 포맷이다. */
function formatKstTimestamp(date: Date): string {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} KST`;
}

function truncateList<T>(items: readonly T[], max: number, formatItem: (item: T) => string): string[] {
  if (items.length <= max) return items.map(formatItem);
  const shown = items.slice(0, max).map(formatItem);
  shown.push(`…외 ${items.length - max}건 — ${MORE_NOTICE_SUFFIX}`);
  return shown;
}

function buildSummaryLine(board: BoardModel): string {
  const nearest = board.summary.nearest;
  const nearestText = nearest ? `${nearest.program.title} ${formatDday(nearest.deadline.daysLeft)}` : '없음';
  return (
    `가장 임박: **${nearestText}** · 진행중 ${board.summary.activeCount}건 · ` +
    `서류 경고 ${board.summary.docAlertCount}건 · 내부마감 초과 ${board.summary.overdueCount}건`
  );
}

function progressLine(v: ApplicationView): string {
  const title = v.program?.title ?? '(공고 정보 없음)';
  const dday = v.deadline ? formatDday(v.deadline.daysLeft) : '마감 미확인';
  return `${title} · ${dday} · ${v.application.owner} · 서류 ${v.docs.ready}/${v.docs.total}`;
}

function buildActiveApplicationsSection(board: BoardModel): string {
  const groups: string[] = [];
  for (const status of ACTIVE_STATUSES) {
    const group = board.applications.filter((v) => v.application.status === status);
    if (group.length === 0) continue;
    const items = truncateList(group, MAX_ITEMS_PER_GROUP, progressLine);
    groups.push(`__${status} (${group.length})__\n${items.join('\n')}`);
  }
  return groups.length > 0 ? groups.join('\n\n') : emptyStateLine('진행 중인 지원건이 없습니다.');
}

/** '접수 중'의 기준 — deadlineState가 urgent/soon/open일 때만. upcoming(아직 시작 전)/closed는 뺀다. */
function isAcceptingNow(state: DeadlineState): boolean {
  return state === 'urgent' || state === 'soon' || state === 'open';
}

/** 지원 불가 판정이어도 목록에서 빼지 않는다 — 취소선 + 사유로 "흐리게"만 표시한다. */
function unappliedLine(v: ProgramView): string {
  const dday = formatDday(v.deadline.daysLeft);
  const link = isLinkable(v.program.sourceUrl) ? `\n   ${v.program.sourceUrl}` : '';
  if (v.eligibility.verdict === 'ineligible') {
    return `⬜ ~~${v.program.title}~~ _(지원 불가 판정)_ · ${dday}${link}`;
  }
  const emoji = TONE_EMOJI[DEADLINE_TONE[v.deadline.state]];
  return `${emoji} **${v.program.title}** · ${dday} · ${v.program.organizer}${link}`;
}

function buildUnappliedSection(board: BoardModel): string {
  const candidates = board.programs.filter((v) => isAcceptingNow(v.deadline.state) && v.applications.length === 0);
  if (candidates.length === 0) return emptyStateLine('접수 중인데 아직 지원하지 않은 공고가 없습니다.');
  return truncateList(candidates, MAX_ITEMS_PER_GROUP, unappliedLine).join('\n');
}

function resultLine(v: ApplicationView): string {
  const title = v.program?.title ?? '(공고 정보 없음)';
  const emoji = v.application.status === '최종선정' ? '🏆' : '📪';
  return `${emoji} ${title} — ${v.application.status} (${v.application.owner})`;
}

function buildResultsSection(board: BoardModel): string {
  const results = board.applications.filter((v) => v.application.status === '최종선정' || v.application.status === '탈락');
  if (results.length === 0) return emptyStateLine('아직 결과가 나온 지원건이 없습니다.');
  return truncateList(results, MAX_ITEMS_PER_GROUP, resultLine).join('\n');
}

/**
 * description 전체를 조립한다. 달력 링크 줄은 잘리지 않도록 예산을 먼저 떼어 두고,
 * 본문이 그 예산을 넘으면 "일부 생략됨" 안내로 잘라낸다(섹션별 truncateList로도 못 줄인
 * 극단적인 경우를 위한 안전망).
 */
export function buildStatusBoardDescription(board: BoardModel): string {
  const trailer = `\n\n📅 [달력 보기](${CALENDAR_URL})`;
  const budget = EMBED_DESCRIPTION_LIMIT - trailer.length;

  const sections = [
    buildSummaryLine(board),
    `**📌 진행 중인 지원건**\n${buildActiveApplicationsSection(board)}`,
    `**🆕 접수 중인데 아직 지원 안 한 공고**\n${buildUnappliedSection(board)}`,
    `**🏁 결과 나온 것**\n${buildResultsSection(board)}`,
  ];
  let body = sections.join('\n\n');
  if (body.length > budget) {
    const notice = '\n\n…(내용이 많아 일부 생략됨) — /공고 목록, /내마감으로 전체 보기';
    body = body.slice(0, Math.max(0, budget - notice.length)) + notice;
  }
  return body + trailer;
}

export function buildStatusBoardEmbed(board: BoardModel, now: Date = new Date()): DiscordEmbed {
  return {
    title: '📊 GrantBoard 현황 (자동 갱신)',
    description: buildStatusBoardDescription(board),
    color: TONE_COLOR.blue,
    footer: { text: `마지막 갱신: ${formatKstTimestamp(now)}` },
  };
}

// ---------------------------------------------------------------------------
// 발행 (D1 + 디스코드 REST 호출)
// ---------------------------------------------------------------------------

function parseState(raw: string | null): StatusBoardState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StatusBoardState>;
    if (typeof parsed.channelId === 'string' && typeof parsed.messageId === 'string') {
      return {
        channelId: parsed.channelId,
        messageId: parsed.messageId,
        lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : undefined,
        pending: parsed.pending === true,
        pendingSince: typeof parsed.pendingSince === 'string' ? parsed.pendingSince : undefined,
      };
    }
  } catch {
    // 손상된 상태는 없는 것으로 치고 아래에서 새로 만든다.
  }
  return null;
}

/**
 * 실제 D1/디스코드 호출과 시간/지연을 주입 가능하게 만든 의존성. 기본값은 진짜 구현이라
 * syncStatusBoard(env) 한 인자 호출만으로 지금까지와 동일하게 동작한다 — 테스트에서만
 * now/sleep까지 가짜로 넣어 실제 30초를 기다리지 않고 debounce 분기를 검증한다.
 */
export interface StatusBoardDeps {
  loadBoard: typeof loadBoardModel;
  getBotState: typeof getBotState;
  setBotState: typeof setBotState;
  postChannelMessage: typeof postChannelMessage;
  patchChannelMessage: typeof patchChannelMessage;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDeps: StatusBoardDeps = {
  loadBoard: loadBoardModel,
  getBotState,
  setBotState,
  postChannelMessage,
  patchChannelMessage,
  now: () => Date.now(),
  sleep: realSleep,
};

/** /현황 커맨드가 갱신 직후 "바로가기" 링크를 만들 때 쓴다. */
export async function getStatusBoardState(env: Env, deps: StatusBoardDeps = defaultDeps): Promise<StatusBoardState | null> {
  return parseState(await deps.getBotState(env.DB, STATE_KEY));
}

async function persistState(env: Env, deps: StatusBoardDeps, state: StatusBoardState): Promise<void> {
  await deps.setBotState(env.DB, STATE_KEY, JSON.stringify(state));
}

/**
 * 실제로 embed를 다시 조립해 채널 메시지를 만들거나 편집한다. 항상 **호출 시점의 최신 데이터**를
 * 다시 읽는다 — debounce로 건너뛰었다가 뒤늦게 이 함수를 부를 때도 그 사이에 바뀐 내용이
 * 반영되게 하려는 것이다(건너뛴 시점의 낡은 스냅샷을 들고 있지 않는다).
 */
async function publishNow(env: Env, deps: StatusBoardDeps, state: StatusBoardState | null): Promise<void> {
  const board = await deps.loadBoard(env.DB);
  const embed = buildStatusBoardEmbed(board);
  const now = deps.now();

  if (state?.channelId && state.messageId) {
    const edited: ChannelMessageResult = await deps.patchChannelMessage(state.channelId, state.messageId, env.DISCORD_BOT_TOKEN, {
      embeds: [embed],
    });
    if (edited.ok) {
      await persistState(env, deps, { channelId: state.channelId, messageId: state.messageId, lastSyncAt: new Date(now).toISOString(), pending: false });
      return;
    }
    if (edited.status !== 404) {
      // 404가 아니면(권한 회수 등) 원인을 알 수 없으니 새 메시지를 또 만들지 않는다 —
      // 그러면 진짜 원인은 안 고쳐지고 채널에 현황판만 계속 쌓인다. pending만 풀어서
      // 다음 호출이 새 debounce 주기를 시작할 수 있게 한다.
      console.error(`현황판 메시지 편집 실패: status=${edited.status}`);
      await persistState(env, deps, { ...state, pending: false });
      return;
    }
    // 404 — 사람이 메시지를 지웠다. 아래에서 새로 만든다.
  }

  const created = await deps.postChannelMessage(env.DISCORD_CHANNEL_ID, env.DISCORD_BOT_TOKEN, { embeds: [embed] });
  if (!created.ok || !created.messageId) {
    console.error(`현황판 메시지 생성 실패: status=${created.status}`);
    if (state) await persistState(env, deps, { ...state, pending: false });
    return;
  }
  await persistState(env, deps, {
    channelId: env.DISCORD_CHANNEL_ID,
    messageId: created.messageId,
    lastSyncAt: new Date(now).toISOString(),
    pending: false,
  });
}

/**
 * debounce 창 안에서 건너뛴 호출을 대신해 "창이 닫히는 시점"에 한 번 더 시도를 예약한다.
 * 호출 시점에 이미 살아있는 예약이 있는지는 호출자(syncStatusBoard)가 isPendingAlive로 먼저
 * 걸러준다 — 여기 도착했다는 건 "예약이 없거나(정상), 있었지만 죽었다(TTL 초과, 복구)"는 뜻이라
 * 무조건 새로 예약한다. 재시도가 실행될 때는 그 시점의 최신 데이터를 다시 읽으므로, 그 사이에
 * 들어온 마지막 변경까지 전부 반영된다.
 */
async function schedulePendingRetry(env: Env, deps: StatusBoardDeps, state: StatusBoardState): Promise<void> {
  const now = deps.now();
  const lastSyncEpoch = state.lastSyncAt ? Date.parse(state.lastSyncAt) : now;
  const fireAt = lastSyncEpoch + DEBOUNCE_MS;

  await persistState(env, deps, { ...state, pending: true, pendingSince: new Date(now).toISOString() });
  await deps.sleep(Math.max(0, fireAt - deps.now()));

  // 잠든 사이 다른 호출이 이미 이 시점 이후로 갱신을 끝냈으면 중복 발행하지 않는다.
  const latest = parseState(await deps.getBotState(env.DB, STATE_KEY));
  const latestSyncEpoch = latest?.lastSyncAt ? Date.parse(latest.lastSyncAt) : 0;
  if (latestSyncEpoch >= fireAt) return;

  await publishNow(env, deps, latest);
}

/**
 * 현황판을 최신 상태로 맞춘다. 데이터를 바꾸는 모든 커맨드 뒤와 크론에서 부른다.
 *
 * 마지막 성공 편집으로부터 DEBOUNCE_MS(30초) 안에 다시 불리면 즉시 편집하지 않고
 * schedulePendingRetry로 넘긴다 — 짧은 시간에 편집이 몰려 429를 맞고 현황판이 조용히
 * 낡는 것을 막기 위함이다. 단, 건너뛴 변경은 절대 유실되지 않는다: 창이 닫히는 시점에
 * 예약된 재시도가 그때의 최신 데이터로 한 번 더 반영한다.
 *
 * ⚠️ 이미 예약된 재시도가 PENDING_TTL_MS를 넘겨도 살아있지 않으면(isolate 회수 등으로
 * 죽은 예약) 죽은 것으로 보고 무시하고 즉시 새로 예약한다 — pending이 영구히 stuck 상태로
 * 남아 현황판이 조용히 멈추는 것을 막기 위함이다.
 *
 * opts.force가 true면(예: /현황 수동 갱신) debounce를 완전히 무시하고 즉시 반영한다 —
 * 사람이 명시적으로 새로고침을 요청한 것이기 때문이다.
 *
 * 무엇이 실패하든(D1 조회, 디스코드 API) 여기서 삼키고 console.error만 남긴다 — 호출자의
 * 원래 응답에 영향을 주지 않기 위함이다.
 */
export async function syncStatusBoard(env: Env, deps: StatusBoardDeps = defaultDeps, opts: { force?: boolean } = {}): Promise<void> {
  try {
    const state = parseState(await deps.getBotState(env.DB, STATE_KEY));
    const now = deps.now();

    if (!opts.force && state?.lastSyncAt) {
      const elapsed = now - Date.parse(state.lastSyncAt);
      if (elapsed < DEBOUNCE_MS) {
        if (isPendingAlive(state, now)) {
          return; // 이미 살아있는 예약이 있다 — 중복 예약하지 않는다.
        }
        await schedulePendingRetry(env, deps, state);
        return;
      }
    }

    await publishNow(env, deps, state);
  } catch (err) {
    console.error('현황판 갱신 실패', err instanceof Error ? err.message : String(err));
  }
}
