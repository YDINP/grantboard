/**
 * sendDeadlineClosed(worker/cron/deadlineClosed.ts) 테스트.
 * D1(programs/applications/documents/team_profile)은 worker/cron/deadlineTomorrow.test.ts와 같은
 * 방식의 FakeD1로 대체한다. bot_state(커서)는 DeadlineClosedDeps로 주입하는 in-memory map으로
 * 대체한다 — statusBoard.ts의 DI 패턴을 따른다. 네트워크는 globalThis.fetch mock으로 가로챈다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendDeadlineClosed, type DeadlineClosedDeps } from './deadlineClosed.ts';
import { TONE_COLOR } from '../discord/embeds.ts';

type Row = Record<string, unknown>;

interface Tables {
  programs: Row[];
  applications: Row[];
  documents: Row[];
  team_profile: Row[];
}

class FakeStatement {
  private sql: string;
  private tables: Tables;

  constructor(sql: string, tables: Tables) {
    this.sql = sql;
    this.tables = tables;
  }
  bind(): this {
    return this;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows() as T[] };
  }
  async first<T>(): Promise<T | null> {
    return (this.rows()[0] as T) ?? null;
  }
  private rows(): Row[] {
    if (this.sql.includes('FROM programs')) return this.tables.programs;
    if (this.sql.includes('FROM applications')) return this.tables.applications;
    if (this.sql.includes('FROM documents')) return this.tables.documents;
    if (this.sql.includes('FROM team_profile')) return this.tables.team_profile;
    throw new Error(`FakeD1: 지원하지 않는 쿼리(테스트에 새 쿼리를 추가해야 함): ${this.sql}`);
  }
}

class FakeD1 {
  private tables: Tables;
  constructor(tables: Tables) {
    this.tables = tables;
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.tables);
  }
  async batch(stmts: FakeStatement[]): Promise<Array<{ results: unknown[] }>> {
    return Promise.all(stmts.map((s) => s.all()));
  }
}

function emptyTables(): Tables {
  return {
    programs: [],
    applications: [],
    documents: [],
    team_profile: [
      {
        id: 1,
        has_business_registration: 0,
        business_registered_at: null,
        incorporated_at: null,
        founder_birth_year: null,
        region: '서울',
      },
    ],
  };
}

/** applyEnd가 주어진 공고 하나. applications는 비어있다(unapplied). */
function tablesWithProgram(id: string, applyEnd: string): Tables {
  const tables = emptyTables();
  tables.programs = [
    {
      id,
      title: `${id}-공고`,
      organizer: '테스트기관',
      source_url: `https://example.com/${id}`,
      category: '공모전',
      apply_start: null,
      apply_end: applyEnd,
      apply_end_time: null,
      announce_date: null,
      support_amount: null,
      source: 'manual',
      collected_at: null,
      eligibility: null,
      tags: null,
      alias_titles: null,
    },
  ];
  return tables;
}

function addApplication(tables: Tables, programId: string, status: string, owner = 'K'): void {
  tables.applications.push({
    id: `app-${programId}-${status}`,
    program_id: programId,
    status,
    owner,
    priority: 'mid',
    target_submit_date: null,
    submitted_at: null,
    result_at: null,
    document_ids: null,
    note: null,
  });
}

const REAL_TOKEN = 'bot-token-should-never-appear-in-any-log-abc123';

function fakeEnv(tables: Tables): Env {
  return {
    DB: new FakeD1(tables) as unknown as Env['DB'],
    DISCORD_APPLICATION_ID: 'app-123',
    DISCORD_PUBLIC_KEY: 'pk',
    DISCORD_BOT_TOKEN: REAL_TOKEN,
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_CHANNEL_ID: 'channel-123',
  } as Env;
}

/** getBotState/setBotState를 in-memory map으로 대체한 deps. */
function fakeDeps(initialCursor: string | null = null): { deps: DeadlineClosedDeps; store: { cursor: string | null } } {
  const store = { cursor: initialCursor };
  const deps: DeadlineClosedDeps = {
    getBotState: async (_db, key) => {
      assert.equal(key, 'closureAnnouncedThrough');
      return store.cursor;
    },
    setBotState: async (_db, key, value) => {
      assert.equal(key, 'closureAnnouncedThrough');
      store.cursor = value;
    },
  };
  return { deps, store };
}

// today = 2026-09-15 KST 09:00.
const NOW = new Date('2026-09-15T09:00:00+09:00');
const TODAY_STR = '2026-09-15';
const CLOSURE_TODAY = '2026-09-14'; // applyEnd → closureDate(=+1) = 오늘
const CLOSURE_FUTURE = '2026-09-20'; // 아직 안 지남

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

function mockDiscordFetch(t: import('node:test').TestContext, opts: { messageStatus?: number } = {}): { calls: Call[] } {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: u, body });
    return new Response(JSON.stringify({ id: 'msg-123' }), { status: opts.messageStatus ?? 200 });
  });
  return { calls };
}

describe('sendDeadlineClosed', () => {
  test('오늘 마감통지일이 된 공고가 없으면 전송하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const { deps } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(emptyTables()), { now: NOW }, deps);

    assert.equal(result.sent, false);
    assert.equal(result.message, null);
    assert.equal(calls.length, 0);
  });

  test('최초 실행(커서 null)은 오늘 마감통지분만 알리고 과거를 쏟지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const tables = tablesWithProgram('p-today', CLOSURE_TODAY);
    // 훨씬 예전에 마감된 공고도 하나 섞어 둔다 — 최초 실행이 이걸 쏟아내면 안 된다.
    tables.programs.push({
      id: 'p-old',
      title: 'p-old-공고',
      organizer: '테스트기관',
      source_url: 'https://example.com/p-old',
      category: '공모전',
      apply_start: null,
      apply_end: '2026-01-01',
      apply_end_time: null,
      announce_date: null,
      support_amount: null,
      source: 'manual',
      collected_at: null,
      eligibility: null,
      tags: null,
      alias_titles: null,
    });
    const { deps } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

    assert.equal(result.sent, true);
    assert.match(result.message ?? '', /p-today-공고/);
    assert.doesNotMatch(result.message ?? '', /p-old-공고/);
  });

  test('두 번 연속 실행하면 두 번째는 침묵한다(중복 방지)', async (t) => {
    mockDiscordFetch(t);
    const tables = tablesWithProgram('p-today', CLOSURE_TODAY);
    const { deps } = fakeDeps(null);

    const first = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);
    const second = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

    assert.equal(first.sent, true);
    assert.equal(second.sent, false);
    assert.equal(second.message, null);
  });

  test('알릴 게 없어도 커서는 오늘로 전진한다', async (t) => {
    mockDiscordFetch(t);
    const { deps, store } = fakeDeps(null);
    await sendDeadlineClosed(fakeEnv(emptyTables()), { now: NOW }, deps);

    assert.equal(store.cursor, TODAY_STR);
  });

  test('전송 성공 시에는 커서가 오늘로 전진한다', async (t) => {
    mockDiscordFetch(t);
    const { deps, store } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { now: NOW }, deps);

    assert.equal(result.sent, true);
    assert.equal(store.cursor, TODAY_STR);
  });

  test('전송이 재시도 끝에 최종 실패하면 커서를 전진시키지 않는다(유실 방지)', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('server error', { status: 500 }));
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    const { deps, store } = fakeDeps(null);

    const result = await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { now: NOW }, deps);

    assert.equal(result.sent, false);
    assert.equal(store.cursor, null, '전송 실패면 커서는 그대로 null이어야 한다');
  });

  test('전송 실패로 커서가 안 넘어간 날의 공고는 다음 실행에서 다시 대상에 포함된다(따라잡기)', async (t) => {
    // 첫 실행: 전송이 실패해 커서가 전진하지 않는다.
    t.mock.method(globalThis, 'fetch', async () => new Response('server error', { status: 500 }));
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    const { deps, store } = fakeDeps(null);
    const tables = tablesWithProgram('p-1', CLOSURE_TODAY);

    const failed = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);
    assert.equal(failed.sent, false);
    assert.equal(store.cursor, null);

    // 다음 실행(같은 날 재시도 또는 다음 날): 이번엔 전송이 성공한다. 커서가 안 넘어갔으므로
    // p-1이 여전히 대상에 남아 있어야 한다.
    t.mock.restoreAll();
    mockDiscordFetch(t);
    const retried = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

    assert.equal(retried.sent, true);
    assert.match(retried.message ?? '', /p-1-공고/, '실패했던 공고가 재시도에서 다시 대상에 포함돼야 한다');
    assert.equal(store.cursor, TODAY_STR);
  });

  test('누락된 날 따라잡기 — 커서가 며칠 전이면 그 사이 전부 알린다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const tables = tablesWithProgram('p-1', '2026-09-11'); // closureDate 09-12
    tables.programs.push(
      { ...tables.programs[0]!, id: 'p-2', title: 'p-2-공고', source_url: 'https://example.com/p-2', apply_end: '2026-09-12' }, // closureDate 09-13
      { ...tables.programs[0]!, id: 'p-3', title: 'p-3-공고', source_url: 'https://example.com/p-3', apply_end: '2026-09-13' }, // closureDate 09-14
      { ...tables.programs[0]!, id: 'p-4', title: 'p-4-공고', source_url: 'https://example.com/p-4', apply_end: CLOSURE_TODAY }, // closureDate 09-15(오늘)
    );
    const { deps } = fakeDeps('2026-09-11'); // 3일 전까지만 알렸었다
    const result = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

    assert.equal(result.sent, true);
    for (const id of ['p-1-공고', 'p-2-공고', 'p-3-공고', 'p-4-공고']) {
      assert.match(result.message ?? '', new RegExp(id), `${id}가 포함돼야 한다`);
    }
    assert.equal(calls.length, 1, '따라잡기라도 메시지는 한 번만 보낸다');
  });

  test('아직 마감 전인 공고는 알리지 않는다', async (t) => {
    mockDiscordFetch(t);
    const { deps } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-future', CLOSURE_FUTURE)), { now: NOW }, deps);

    assert.equal(result.sent, false);
  });

  describe('지원 상태 3분류', () => {
    test('제출 이후 상태(제출완료 등)가 있으면 ✅ 제출완료로 표시', async (t) => {
      mockDiscordFetch(t);
      const tables = tablesWithProgram('p-1', CLOSURE_TODAY);
      addApplication(tables, 'p-1', '제출완료');
      const { deps } = fakeDeps(null);
      const result = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

      assert.match(result.message ?? '', /✅ \*\*p-1-공고\*\* · 9\/14 마감 · 제출완료/);
    });

    test('지원건이 전부 제출 전 단계면 ⛔ 미제출(상태)로 표시', async (t) => {
      mockDiscordFetch(t);
      const tables = tablesWithProgram('p-1', CLOSURE_TODAY);
      addApplication(tables, 'p-1', '작성중');
      const { deps } = fakeDeps(null);
      const result = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

      assert.match(result.message ?? '', /⛔ \*\*p-1-공고\*\* · 9\/14 마감 · 미제출\(작성중\)/);
    });

    test('지원건이 없으면 ⚪ 미지원으로 표시', async (t) => {
      mockDiscordFetch(t);
      const tables = tablesWithProgram('p-1', CLOSURE_TODAY);
      const { deps } = fakeDeps(null);
      const result = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

      assert.match(result.message ?? '', /⚪ \*\*p-1-공고\*\* · 9\/14 마감 · 미지원/);
    });
  });

  test('담당자가 있으면 · 담당 형식으로 덧붙인다', async (t) => {
    mockDiscordFetch(t);
    const tables = tablesWithProgram('p-1', CLOSURE_TODAY);
    addApplication(tables, 'p-1', '작성중', 'YD');
    const { deps } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

    assert.match(result.message ?? '', /담당 YD/);
  });

  test('페이로드에 @here/@everyone 문자열이 없고 멘션이 비어 있다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const { deps } = fakeDeps(null);
    await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { now: NOW }, deps);

    const body = calls[0]?.body;
    assert.deepEqual(body?.allowed_mentions, { parse: [] });
    assert.doesNotMatch(JSON.stringify(body), /@here|@everyone/);
  });

  test('알릴 게 없으면 post를 아예 호출하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const { deps } = fakeDeps(null);
    await sendDeadlineClosed(fakeEnv(emptyTables()), { now: NOW }, deps);

    assert.equal(calls.length, 0);
  });

  test('dryRun이면 보낼 내용이 있어도 실제 전송하지 않고 커서도 건드리지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const { deps, store } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { dryRun: true, now: NOW }, deps);

    assert.equal(result.sent, false);
    assert.ok(result.message, '조립은 되어야 한다(로그로 확인할 수 있게)');
    assert.equal(calls.length, 0);
    assert.equal(store.cursor, null, 'dry-run은 커서를 전진시키지 않는다');
  });

  test('embed 색은 항상 중립색(TONE_COLOR.neutral)이다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const { deps } = fakeDeps(null);
    await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { now: NOW }, deps);

    const embed = (calls[0]?.body?.embeds as Array<{ color: number }>)[0];
    assert.equal(embed.color, TONE_COLOR.neutral);
  });

  test('제목에 건수가 들어간다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const tables = tablesWithProgram('p-1', CLOSURE_TODAY);
    tables.programs.push({ ...tables.programs[0]!, id: 'p-2', title: 'p-2-공고', source_url: 'https://example.com/p-2' });
    const { deps } = fakeDeps(null);
    await sendDeadlineClosed(fakeEnv(tables), { now: NOW }, deps);

    const embed = (calls[0]?.body?.embeds as Array<{ title: string }>)[0];
    assert.equal(embed.title, '📕 마감된 공고 — 2건');
  });

  test('전송 실패 시 재시도하고, 최종 실패는 console.error로 남긴다', async (t) => {
    let fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      return new Response('server error', { status: 500 });
    });
    const errors: string[] = [];
    t.mock.method(console, 'error', (msg: string) => {
      errors.push(msg);
    });
    t.mock.method(console, 'warn', () => {});

    const { deps } = fakeDeps(null);
    const result = await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { now: NOW }, deps);

    assert.equal(result.sent, false);
    assert.equal(fetchCalls, 3, '3회 재시도해야 한다');
    assert.ok(
      errors.some((e) => e.includes('디스코드 전송') && e.includes('실패')),
      '최종 실패가 console.error로 명확히 남아야 한다',
    );
  });

  test('토큰은 성공/실패 어느 로그에도 나타나지 않는다', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('server error', { status: 500 }));
    const logs: string[] = [];
    t.mock.method(console, 'error', (msg: string) => {
      logs.push(msg);
    });
    t.mock.method(console, 'warn', (msg: string) => {
      logs.push(msg);
    });
    t.mock.method(console, 'log', (msg: string) => {
      logs.push(msg);
    });

    const { deps } = fakeDeps(null);
    await sendDeadlineClosed(fakeEnv(tablesWithProgram('p-1', CLOSURE_TODAY)), { now: NOW }, deps);

    assert.ok(!logs.some((l) => l.includes(REAL_TOKEN)), '봇 토큰이 로그 문자열에 노출되면 안 된다');
  });
});
