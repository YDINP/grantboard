/**
 * sendDeadlineTomorrow(worker/cron/deadlineTomorrow.ts) 테스트.
 * D1/네트워크 목킹은 worker/cron/digest.test.ts와 같은 방식(FakeD1 + globalThis.fetch mock).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendDeadlineTomorrow } from './deadlineTomorrow.ts';
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

/** 오늘(2026-09-15 KST) 기준 applyEnd가 내일(D-1)인 공고 하나. applyEndTime은 인자로 받는다. */
function tomorrowTables(applyEnd: string, applyEndTime: string | null = '16:00'): Tables {
  const tables = emptyTables();
  tables.programs = [
    {
      id: 'prog-tomorrow',
      title: '내일마감공고',
      organizer: '테스트기관',
      source_url: 'https://example.com/tomorrow',
      category: '공모전',
      apply_start: null,
      apply_end: applyEnd,
      apply_end_time: applyEndTime,
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

const NOW = new Date('2026-09-15T12:00:00+09:00'); // KST 2026-09-15 12:00
const TOMORROW = '2026-09-16'; // 내일(D-1)
const TODAY_DEADLINE = '2026-09-15'; // 오늘(D-day) — 이 알림 대상이 아니다
const DAY_AFTER_TOMORROW = '2026-09-17'; // 모레(D-2) — 이 알림 대상이 아니다

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

describe('sendDeadlineTomorrow', () => {
  test('내일 마감인 건이 없으면 전송을 시도하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDeadlineTomorrow(fakeEnv(emptyTables()), { now: NOW });

    assert.equal(result.sent, false);
    assert.equal(result.message, null);
    assert.equal(calls.length, 0);
  });

  test('오늘(D-day) 마감만 있으면 전송하지 않는다 — 그건 08:30 다이제스트 몫이다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TODAY_DEADLINE)), { now: NOW });

    assert.equal(result.sent, false);
    assert.equal(calls.length, 0);
  });

  test('모레(D-2) 마감만 있으면 전송하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDeadlineTomorrow(fakeEnv(tomorrowTables(DAY_AFTER_TOMORROW)), { now: NOW });

    assert.equal(result.sent, false);
    assert.equal(calls.length, 0);
  });

  test('제출완료 건만 있으면(할 일 없음) 내일 마감이어도 전송하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const tables = tomorrowTables(TOMORROW);
    tables.applications = [
      {
        id: 'app-1',
        program_id: 'prog-tomorrow',
        status: '제출완료',
        owner: 'K',
        priority: 'mid',
        target_submit_date: null,
        submitted_at: '2026-09-14',
        result_at: null,
        document_ids: null,
        note: null,
      },
    ];
    const result = await sendDeadlineTomorrow(fakeEnv(tables), { now: NOW });

    assert.equal(result.sent, false);
    assert.equal(calls.length, 0);
  });

  test('dryRun이면 보낼 내용이 있어도 실제 전송은 하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW)), { dryRun: true, now: NOW });

    assert.equal(result.sent, false);
    assert.ok(result.message, '조립은 되어야 한다(로그로 확인할 수 있게)');
    assert.match(result.message ?? '', /내일마감공고/);
    assert.equal(calls.length, 0);
  });

  test('내일 마감 대상이 있으면 항상 @here로 부른다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW)), { now: NOW });

    assert.equal(result.sent, true);
    const messageCall = calls[0];
    assert.equal(messageCall?.body?.content, '@here');
    assert.deepEqual(messageCall?.body?.allowed_mentions, { parse: ['everyone'] });
  });

  test('embed 색은 항상 빨강(TONE_COLOR.red)이다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW)), { now: NOW });

    const embed = (calls[0]?.body?.embeds as Array<{ color: number }>)[0];
    assert.equal(embed.color, TONE_COLOR.red);
  });

  test('applyEndTime이 있으면 마감 시각을 그대로 보여준다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW, '16:00')), { now: NOW });

    const embed = (calls[0]?.body?.embeds as Array<{ description: string }>)[0];
    assert.match(embed.description, /내일 16:00 마감/);
  });

  test('applyEndTime이 없으면 "마감 시각 미확인"을 눈에 띄게 표시한다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW, null)), { now: NOW });

    const embed = (calls[0]?.body?.embeds as Array<{ description: string }>)[0];
    assert.match(embed.description, /마감 시각 미확인/);
  });

  test('공고 원문 링크와 하단 달력 링크가 항상 포함된다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW)), { now: NOW });

    const embed = (calls[0]?.body?.embeds as Array<{ description: string }>)[0];
    assert.match(embed.description, /https:\/\/example\.com\/tomorrow/, '공고 원문 링크가 있어야 한다');
    assert.match(
      embed.description,
      /https:\/\/grantboard\.benclaude-toss\.workers\.dev\/calendar/,
      '달력 링크가 항상 있어야 한다',
    );
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

    const result = await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW)), { now: NOW });

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

    await sendDeadlineTomorrow(fakeEnv(tomorrowTables(TOMORROW)), { now: NOW });

    assert.ok(!logs.some((l) => l.includes(REAL_TOKEN)), '봇 토큰이 로그 문자열에 노출되면 안 된다');
  });
});
