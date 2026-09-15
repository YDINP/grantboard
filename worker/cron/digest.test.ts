/**
 * sendDigest(worker/cron/digest.ts) 테스트.
 * D1은 worker/discord/myDeadlinesFallback.test.ts와 같은 방식의 최소 FakeD1로 대체한다.
 * 네트워크(디스코드 채널 POST)는 globalThis.fetch를 목으로 바꿔 가로챈다 — 실네트워크 호출 없음.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendDigest } from './digest.ts';

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

/** 오늘(2026-09-15 KST) 기준 마감이 임박한 공고 하나 — buildDigest가 null이 아닌 메시지를 만들게 한다. */
function urgentTables(): Tables {
  const tables = emptyTables();
  tables.programs = [
    {
      id: 'prog-urgent',
      title: '긴급마감공고',
      organizer: '테스트기관',
      source_url: 'https://example.com/urgent',
      category: '공모전',
      apply_start: null,
      apply_end: '2026-09-17',
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

const NOW = new Date('2026-09-15T00:00:00+09:00');

describe('sendDigest', () => {
  test('보낼 게 없으면(buildDigest가 null) 전송을 시도하지 않는다', async (t) => {
    let fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    });

    const result = await sendDigest(fakeEnv(emptyTables()), { now: NOW });

    assert.equal(result.sent, false);
    assert.equal(result.message, null);
    assert.equal(fetchCalls, 0);
  });

  test('dryRun이면 보낼 내용이 있어도 실제 전송은 하지 않는다', async (t) => {
    let fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    });

    const result = await sendDigest(fakeEnv(urgentTables()), { dryRun: true, now: NOW });

    assert.equal(result.sent, false);
    assert.ok(result.message, '조립은 되어야 한다(로그로 확인할 수 있게)');
    assert.match(result.message ?? '', /긴급마감공고/);
    assert.equal(fetchCalls, 0);
  });

  test('전송할 내용이 있으면 채널에 봇 토큰으로 POST한다', async (t) => {
    const bodies: unknown[] = [];
    const requestInits: (RequestInit | undefined)[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      requestInits.push(init);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });

    const result = await sendDigest(fakeEnv(urgentTables()), { now: NOW });

    assert.equal(result.sent, true);
    assert.equal(bodies.length, 1);
    assert.match((bodies[0] as { content: string }).content, /긴급마감공고/);

    const headers = requestInits[0]?.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bot /);
    assert.ok(headers['User-Agent'], 'User-Agent 헤더가 없으면 Cloudflare가 빈 본문 403으로 막는다');
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

    const result = await sendDigest(fakeEnv(urgentTables()), { now: NOW });

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

    await sendDigest(fakeEnv(urgentTables()), { now: NOW });

    assert.ok(!logs.some((l) => l.includes(REAL_TOKEN)), '봇 토큰이 로그 문자열에 노출되면 안 된다');
  });
});
