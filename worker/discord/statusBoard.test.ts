/**
 * statusBoard.ts 테스트.
 *
 * 발행 로직(publishStatusBoard 안쪽)은 StatusBoardDeps로 D1/디스코드 REST 호출을 전부 주입해
 * 막는다 — 실제 discord.com이나 D1에 절대 접근하지 않는다. syncStatusBoard(env)의 기본 호출부
 * (커맨드 핸들러들, 크론)는 이 deps 인자를 생략하므로 지금까지의 동작과 완전히 같다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { syncStatusBoard, buildStatusBoardDescription, type StatusBoardDeps } from './statusBoard.ts';
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
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => {
        calls.push('getBotState');
        return null;
      },
      setBotState: async (_db, key, value) => {
        calls.push(`setBotState:${key}:${value}`);
      },
      postChannelMessage: async () => {
        calls.push('postChannelMessage');
        return { ok: true, status: 200, messageId: 'msg-new' };
      },
      patchChannelMessage: async () => {
        calls.push('patchChannelMessage');
        return { ok: true, status: 200 };
      },
    };

    await syncStatusBoard(fakeEnv(), deps);

    assert.deepEqual(calls, ['getBotState', 'postChannelMessage', 'setBotState:status_board:{"channelId":"channel-123","messageId":"msg-new"}']);
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
    };

    await syncStatusBoard(fakeEnv(), deps);

    assert.deepEqual(calls, ['patchChannelMessage:channel-123:msg-old']);
  });

  test('편집이 404면(사람이 지운 경우) 새로 만들고 id를 갱신한다', async () => {
    const calls: string[] = [];
    const deps: StatusBoardDeps = {
      loadBoard: async () => emptyBoard(),
      getBotState: async () => JSON.stringify({ channelId: 'channel-123', messageId: 'msg-deleted' }),
      setBotState: async (_db, key, value) => {
        calls.push(`setBotState:${key}:${value}`);
      },
      postChannelMessage: async () => {
        calls.push('postChannelMessage');
        return { ok: true, status: 200, messageId: 'msg-recreated' };
      },
      patchChannelMessage: async () => {
        calls.push('patchChannelMessage');
        return { ok: false, status: 404 };
      },
    };

    await syncStatusBoard(fakeEnv(), deps);

    assert.deepEqual(calls, [
      'patchChannelMessage',
      'postChannelMessage',
      'setBotState:status_board:{"channelId":"channel-123","messageId":"msg-recreated"}',
    ]);
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
    };

    await syncStatusBoard(fakeEnv(), deps);

    assert.deepEqual(calls, ['patchChannelMessage']);
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
    };

    await assert.doesNotReject(syncStatusBoard(fakeEnv(), deps));
  });
});
