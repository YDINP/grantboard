/**
 * statusBoard.ts 테스트.
 *
 * 발행 로직(publishStatusBoard 안쪽)은 StatusBoardDeps로 D1/디스코드 REST 호출을 전부 주입해
 * 막는다 — 실제 discord.com이나 D1에 절대 접근하지 않는다. syncStatusBoard(env)의 기본 호출부
 * (커맨드 핸들러들, 크론)는 이 deps 인자를 생략하므로 지금까지의 동작과 완전히 같다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { syncStatusBoard, buildStatusBoardDescription, DEBOUNCE_MS, type StatusBoardDeps } from './statusBoard.ts';
import type { BoardModel, ProgramView, ApplicationView } from '../../src/lib/board.ts';
import type { Program, Application } from '../../src/lib/board.ts';

function emptyBoard(): BoardModel {
  return {
    programs: [],
    applications: [],
    documents: [],
    events: [],
    summary: { nearest: null, activeCount: 0, docAlertCount: 0, overdueCount: 0 },
  };
}

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'prog-1',
    title: '테스트공고',
    organizer: '테스트기관',
    sourceUrl: 'https://example.com',
    category: '공모전',
    applyEnd: '2026-12-31',
    tags: [],
    source: 'manual',
    aliasTitles: [],
    ...overrides,
  };
}

function makeProgramView(overrides: Partial<ProgramView> = {}, programOverrides: Partial<Program> = {}): ProgramView {
  return {
    program: makeProgram(programOverrides),
    deadline: { daysLeft: 5, state: 'open' },
    startsIn: null,
    eligibility: { verdict: 'eligible', reasons: [] },
    applications: [],
    ...overrides,
  };
}

function makeApplication(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    programId: 'prog-1',
    status: '작성중',
    owner: 'AB',
    priority: 'mid',
    documentIds: [],
    ...overrides,
  };
}

function makeApplicationView(overrides: Partial<ApplicationView> = {}, appOverrides: Partial<Application> = {}): ApplicationView {
  const program = makeProgram({ title: '테스트공고' });
  return {
    application: makeApplication(appOverrides),
    program,
    deadline: { daysLeft: 5, state: 'open' },
    targetDaysLeft: null,
    overdueUnsubmitted: false,
    announceOverdue: false,
    docs: { total: 2, ready: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildStatusBoardDescription — 순수 함수, D1/네트워크 없이 검증
// ---------------------------------------------------------------------------

describe('buildStatusBoardDescription', () => {
  test('빈 보드는 각 섹션에 빈 상태 문구를 보여주고 달력 링크가 끝에 남는다', () => {
    const description = buildStatusBoardDescription(emptyBoard());
    assert.match(description, /진행 중인 지원건이 없습니다/);
    assert.match(description, /접수 중인데 아직 지원하지 않은 공고가 없습니다/);
    assert.match(description, /아직 결과가 나온 지원건이 없습니다/);
    assert.match(description, /📅 \[달력 보기\]/);
    assert.ok(description.length <= 4096);
  });

  test('섹션 하나가 8건을 넘으면 잘리고 "외 N건" 안내가 남는다', () => {
    const board = emptyBoard();
    board.programs = Array.from({ length: 20 }, (_, i) =>
      makeProgramView({}, { id: `prog-${i}`, title: `공고${i}` }),
    );
    const description = buildStatusBoardDescription(board);
    assert.match(description, /…외 12건 — \/공고 목록으로 전체 보기/);
    assert.ok(description.length <= 4096);
  });

  test('지원 불가 판정인 공고는 목록에서 빠지지 않고 취소선으로 흐리게 표시된다', () => {
    const board = emptyBoard();
    board.programs = [
      makeProgramView(
        { eligibility: { verdict: 'ineligible', reasons: ['지역 제한'] } },
        { title: '못지원공고' },
      ),
    ];
    const description = buildStatusBoardDescription(board);
    assert.match(description, /~~못지원공고~~ _\(지원 불가 판정\)_/);
  });

  test('접수예정(upcoming)·마감(closed) 공고는 "미지원" 섹션에 넣지 않는다', () => {
    const board = emptyBoard();
    board.programs = [
      makeProgramView({ deadline: { daysLeft: 10, state: 'upcoming' } }, { title: '예정공고' }),
      makeProgramView({ deadline: { daysLeft: -1, state: 'closed' } }, { title: '마감공고' }),
    ];
    const description = buildStatusBoardDescription(board);
    assert.doesNotMatch(description, /예정공고/);
    assert.doesNotMatch(description, /마감공고/);
    assert.match(description, /접수 중인데 아직 지원하지 않은 공고가 없습니다/);
  });

  test('극단적으로 큰 데이터(항목당 초장문)에서도 description은 4096자를 넘지 않고, 안내와 달력 링크가 남는다', () => {
    const board = emptyBoard();
    const longTitle = 'X'.repeat(400);
    // 상태 그룹마다 최대 8건까지 보이므로, 그룹 5개 × 8건 × 400자 초과 타이틀로 예산을 확실히 넘긴다.
    const statuses: Application['status'][] = ['검토중', '준비', '작성중', '제출완료', '서류통과'];
    board.applications = statuses.flatMap((status) =>
      Array.from({ length: 8 }, (_, i) => makeApplicationView({}, { id: `${status}-${i}`, status, owner: 'AB' })).map(
        (v) => ({ ...v, program: { ...v.program!, title: longTitle } }),
      ),
    );

    const description = buildStatusBoardDescription(board);
    assert.ok(description.length <= 4096, `description이 4096자를 넘었다: ${description.length}`);
    assert.match(description, /일부 생략됨/);
    assert.match(description, /📅 \[달력 보기\]/, '예산이 넘쳐도 달력 링크 줄은 반드시 남아야 한다');
  });
});

// ---------------------------------------------------------------------------
// syncStatusBoard — 발행 로직. deps를 전부 주입해 실네트워크/D1 접근을 막는다.
// ---------------------------------------------------------------------------

function fakeEnv(): Env {
  return {
    DB: {} as Env['DB'],
    DISCORD_APPLICATION_ID: 'app-123',
    DISCORD_PUBLIC_KEY: 'pub',
    DISCORD_BOT_TOKEN: 'bot-token-not-real',
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_CHANNEL_ID: 'channel-123',
  } as Env;
}

describe('syncStatusBoard', () => {
  test('저장된 메시지 id가 없으면 새로 만들고 id를 저장한다', async () => {
    const calls: string[] = [];
    let saved: any;
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => {
        calls.push('getBotState');
        return null;
      },
      setBotState: async (_db, key, value) => {
        calls.push('setBotState');
        assert.equal(key, 'status_board');
        saved = JSON.parse(value);
      },
      postChannelMessage: async () => {
        calls.push('postChannelMessage');
        return { ok: true, status: 200, messageId: 'msg-new' };
      },
      patchChannelMessage: async () => {
        calls.push('patchChannelMessage');
        return { ok: true, status: 200 };
      },
      now: () => 0,
      sleep: async () => {},
    };

    await syncStatusBoard(fakeEnv(), deps);

    assert.deepEqual(calls, ['getBotState', 'postChannelMessage', 'setBotState']);
    assert.equal(saved.channelId, 'channel-123');
    assert.equal(saved.messageId, 'msg-new');
    assert.equal(saved.pending, false);
    assert.equal(typeof saved.lastSyncAt, 'string');
  });

  test('저장된 메시지 id가 있으면 편집만 하고 새로 만들지 않는다', async () => {
    const calls: string[] = [];
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => JSON.stringify({ channelId: 'channel-123', messageId: 'msg-old' }),
      setBotState: async () => {
        calls.push('setBotState');
      },
      postChannelMessage: async () => {
        calls.push('postChannelMessage');
        return { ok: true, status: 200, messageId: 'msg-should-not-happen' };
      },
      patchChannelMessage: async (channelId, messageId) => {
        calls.push(`patchChannelMessage:${channelId}:${messageId}`);
        return { ok: true, status: 200 };
      },
      now: () => 0,
      sleep: async () => {},
    };

    await syncStatusBoard(fakeEnv(), deps);

    // postChannelMessage(새 메시지 생성)는 절대 불리면 안 된다. setBotState는 lastSyncAt을
    // 갱신하기 위해 성공한 편집 뒤에도 호출된다(다음 호출의 debounce 판단 기준이 되므로).
    assert.deepEqual(calls, ['patchChannelMessage:channel-123:msg-old', 'setBotState']);
  });

  test('편집이 404면(사람이 지운 경우) 새로 만들고 id를 갱신한다', async () => {
    const calls: string[] = [];
    let saved: any;
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => JSON.stringify({ channelId: 'channel-123', messageId: 'msg-deleted' }),
      setBotState: async (_db, key, value) => {
        calls.push('setBotState');
        assert.equal(key, 'status_board');
        saved = JSON.parse(value);
      },
      postChannelMessage: async () => {
        calls.push('postChannelMessage');
        return { ok: true, status: 200, messageId: 'msg-recreated' };
      },
      patchChannelMessage: async () => {
        calls.push('patchChannelMessage');
        return { ok: false, status: 404 };
      },
      now: () => 0,
      sleep: async () => {},
    };

    await syncStatusBoard(fakeEnv(), deps);

    assert.deepEqual(calls, ['patchChannelMessage', 'postChannelMessage', 'setBotState']);
    assert.equal(saved.channelId, 'channel-123');
    assert.equal(saved.messageId, 'msg-recreated');
  });

  test('편집이 404가 아닌 다른 이유(예: 403)로 실패하면 새 메시지를 만들지 않는다', async () => {
    const calls: string[] = [];
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => JSON.stringify({ channelId: 'channel-123', messageId: 'msg-old' }),
      setBotState: async () => {
        calls.push('setBotState');
      },
      postChannelMessage: async () => {
        calls.push('postChannelMessage');
        return { ok: true, status: 200, messageId: 'should-not-happen' };
      },
      patchChannelMessage: async () => {
        calls.push('patchChannelMessage');
        return { ok: false, status: 403 };
      },
      now: () => 0,
      sleep: async () => {},
    };

    await syncStatusBoard(fakeEnv(), deps);

    // postChannelMessage는 절대 불리면 안 된다(중복 메시지 방지). setBotState는 pending 플래그를
    // 풀어 다음 호출이 새 debounce 주기를 시작할 수 있게 하려고 호출된다.
    assert.deepEqual(calls, ['patchChannelMessage', 'setBotState']);
  });

  test('갱신 중 예외가 나도 syncStatusBoard 자체는 던지지 않는다', async () => {
    const deps: StatusBoardDeps = {
      loadBoard: async () => {
        throw new Error('D1 연결 실패(테스트로 주입한 오류)');
      },
      getBotState: async () => null,
      setBotState: async () => {},
      postChannelMessage: async () => ({ ok: true, status: 200, messageId: 'x' }),
      patchChannelMessage: async () => ({ ok: true, status: 200 }),
      now: () => 0,
      sleep: async () => {},
    };

    await assert.doesNotReject(syncStatusBoard(fakeEnv(), deps));
  });

  test('디스코드 API 호출이 전부 실패해도 예외가 새어나가지 않는다', async () => {
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => null,
      setBotState: async () => {},
      postChannelMessage: async () => ({ ok: false, status: 500 }),
      patchChannelMessage: async () => ({ ok: false, status: 500 }),
      now: () => 0,
      sleep: async () => {},
    };

    await assert.doesNotReject(syncStatusBoard(fakeEnv(), deps));
  });
});

// ---------------------------------------------------------------------------
// debounce — 편집 빈도 제한. now/sleep까지 가짜로 넣어 실제 30초를 기다리지 않고 검증한다.
// ---------------------------------------------------------------------------

/** board.summary.nearest 제목에 버전 마커를 심어, 최종 반영된 embed가 "어느 시점 데이터"인지 추적한다. */
function boardWithMarker(version: string): BoardModel {
  const board = emptyBoard();
  const view = makeProgramView({}, { title: `MARKER-${version}` });
  board.programs = [view];
  board.summary.nearest = view;
  return board;
}

/**
 * now()/sleep()까지 제어 가능한 테스트 전용 deps. sleep은 실제로 기다리지 않고, test가
 * releaseNextSleep()을 부를 때까지 멈춰 있는 진짜 Promise를 돌려준다 — "여러 호출이 재시도가
 * 깨어나기 전에 겹쳐 들어오는" 진짜 동시성 상황을 실시간 대기 없이 재현하기 위함이다.
 */
function makeControlledDeps(loadBoard: () => Promise<BoardModel>) {
  let clock = 0;
  let stateValue: string | null = null;
  const calls = { post: 0, patch: 0 };
  let lastEmbedDescription = '';
  const sleepQueue: Array<() => void> = [];

  const deps: StatusBoardDeps = {
    loadBoard: async () => loadBoard(),
    getBotState: async () => stateValue,
    setBotState: async (_db, _key, value) => {
      stateValue = value;
    },
    postChannelMessage: async (_channelId, _token, body: any) => {
      calls.post += 1;
      lastEmbedDescription = body.embeds[0].description;
      return { ok: true, status: 200, messageId: 'msg-1' };
    },
    patchChannelMessage: async (_channelId, _messageId, _token, body: any) => {
      calls.patch += 1;
      lastEmbedDescription = body.embeds[0].description;
      return { ok: true, status: 200 };
    },
    now: () => clock,
    sleep: () => new Promise<void>((resolve) => sleepQueue.push(resolve)),
  };

  return {
    deps,
    calls,
    setClock: (t: number) => {
      clock = t;
    },
    get lastEmbedDescription() {
      return lastEmbedDescription;
    },
    pendingSleepCount: () => sleepQueue.length,
    /** 대기 중인 sleep 중 가장 먼저 예약된 것을 깨운다. 먼저 시계를 목표 시각으로 옮긴다. */
    releaseNextSleep: (advanceClockTo: number) => {
      clock = advanceClockTo;
      const resolve = sleepQueue.shift();
      resolve?.();
    },
  };
}

/** 순수 async 체인(우리 fake들은 실제 I/O가 없다)이 다음 await 지점까지 진행하도록 마이크로태스크를 흘려보낸다. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('syncStatusBoard debounce', () => {
  test('30초 이내 겹쳐 들어온 여러 호출은 재시도를 딱 한 번만 예약하고, 편집도 한 번만 하며, 마지막 데이터를 반영한다', async () => {
    let version = 'v1';
    const h = makeControlledDeps(async () => boardWithMarker(version));
    const env = fakeEnv();

    // 최초 호출 — 메시지가 없으니 즉시 생성(디바운스 대상 아님). lastSyncAt = 0.
    await syncStatusBoard(env, h.deps);
    assert.equal(h.calls.post, 1);
    assert.equal(h.calls.patch, 0);

    // 30초 창 안에서 데이터가 바뀌며 연달아 3번 호출된다(예: /공고 추가를 연달아 실행).
    // 셋 다 첫 번째가 예약한 재시도(sleep)가 아직 깨어나기 전에 겹쳐 들어온다.
    h.setClock(1000);
    version = 'v2';
    const p1 = syncStatusBoard(env, h.deps); // 이 호출이 sleep을 예약한다(pending: true)
    await flushMicrotasks();

    h.setClock(2000);
    version = 'v3';
    const p2 = syncStatusBoard(env, h.deps); // pending이 이미 true라 재시도를 또 예약하지 않고 그냥 끝나야 한다
    await flushMicrotasks();

    h.setClock(3000);
    version = 'v4'; // 이게 이 창에서의 "마지막" 데이터다
    const p3 = syncStatusBoard(env, h.deps); // 역시 그냥 끝나야 한다
    await flushMicrotasks();

    assert.equal(h.pendingSleepCount(), 1, '재시도 sleep은 겹쳐 들어온 호출 수와 무관하게 딱 하나만 예약되어야 한다');

    // 디바운스 창이 닫히는 시점(최초 편집 + 30초)으로 시계를 옮기고 예약된 재시도를 깨운다.
    h.releaseNextSleep(DEBOUNCE_MS);
    await Promise.all([p1, p2, p3]);

    assert.equal(h.calls.patch, 1, '연속 호출 전체에서 실제 편집(디스코드 API 호출)은 한 번만 일어나야 한다');
    assert.match(h.lastEmbedDescription, /MARKER-v4/, '건너뛴 호출들 없이도 결국 최신(v4) 데이터가 반영되어야 한다 — 유실되면 버그다');
    assert.doesNotMatch(h.lastEmbedDescription, /MARKER-v1|MARKER-v2|MARKER-v3/);
  });

  test('디바운스 창이 지난 뒤 호출하면 매번 즉시 편집한다', async () => {
    let version = 'v1';
    const h = makeControlledDeps(async () => boardWithMarker(version));
    const env = fakeEnv();

    await syncStatusBoard(env, h.deps); // clock=0, 생성
    assert.equal(h.calls.patch, 0);

    h.setClock(DEBOUNCE_MS + 1);
    version = 'v2';
    await syncStatusBoard(env, h.deps); // 창이 지났으니 즉시 편집
    assert.equal(h.calls.patch, 1);
    assert.match(h.lastEmbedDescription, /MARKER-v2/);

    h.setClock(2 * DEBOUNCE_MS + 2);
    version = 'v3';
    await syncStatusBoard(env, h.deps); // 또 창이 지났으니 즉시 편집
    assert.equal(h.calls.patch, 2);
    assert.match(h.lastEmbedDescription, /MARKER-v3/);
  });

  test('/현황처럼 force가 true면 debounce를 무시하고 즉시 편집한다', async () => {
    let version = 'v1';
    const h = makeControlledDeps(async () => boardWithMarker(version));
    const env = fakeEnv();

    await syncStatusBoard(env, h.deps); // clock=0, 생성
    assert.equal(h.calls.patch, 0);

    // 디바운스 창 안(30초 이내)이지만 force: true이므로 즉시 반영돼야 한다.
    h.setClock(1000);
    version = 'v2';
    await syncStatusBoard(env, h.deps, { force: true });

    assert.equal(h.calls.patch, 1, 'force일 때는 즉시(재시도 예약 없이) 편집해야 한다');
    assert.match(h.lastEmbedDescription, /MARKER-v2/);
  });
});
