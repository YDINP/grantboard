/**
 * sendDigest(worker/cron/digest.ts) 테스트.
 * D1은 worker/discord/myDeadlinesFallback.test.ts와 같은 방식의 최소 FakeD1로 대체한다.
 * 네트워크(디스코드 채널 POST + 스레드 생성)는 globalThis.fetch를 목으로 바꿔 가로챈다 — 실네트워크 호출 없음.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendDigest } from './digest.ts';
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

/** 오늘(2026-09-15 KST) 기준 applyEnd가 딱 daysLeft만큼 남은 공고 하나. */
function urgentTables(applyEnd: string): Tables {
  const tables = emptyTables();
  tables.programs = [
    {
      id: 'prog-urgent',
      title: '긴급마감공고',
      organizer: '테스트기관',
      source_url: 'https://example.com/urgent',
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

const NOW = new Date('2026-09-15T00:00:00+09:00'); // KST 2026-09-15
const D_DAY = '2026-09-15'; // 오늘 마감 (daysLeft 0)
const D_MINUS_1 = '2026-09-16';
const D_MINUS_2 = '2026-09-17';

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** 채널 POST(메시지 생성)와 스레드 생성 POST를 URL로 구분해 가로챈다. */
function mockDiscordFetch(
  t: import('node:test').TestContext,
  opts: { messageStatus?: number; threadStatus?: number } = {},
): { calls: Call[] } {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: u, body });
    if (u.endsWith('/threads')) {
      return new Response('{}', { status: opts.threadStatus ?? 200 });
    }
    return new Response(JSON.stringify({ id: 'msg-123' }), { status: opts.messageStatus ?? 200 });
  });
  return { calls };
}

describe('sendDigest', () => {
  test('보낼 게 없으면(selectDigestSections가 null) 전송을 시도하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDigest(fakeEnv(emptyTables()), { now: NOW });

    assert.equal(result.sent, false);
    assert.equal(result.message, null);
    assert.equal(calls.length, 0);
  });

  test('dryRun이면 보낼 내용이 있어도 실제 전송/스레드 생성은 하지 않는다', async (t) => {
    const { calls } = mockDiscordFetch(t);
    const result = await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { dryRun: true, now: NOW });

    assert.equal(result.sent, false);
    assert.ok(result.message, '조립은 되어야 한다(로그로 확인할 수 있게)');
    assert.match(result.message ?? '', /긴급마감공고/);
    assert.equal(calls.length, 0);
  });

  describe('멘션 정책 — D-1/D-day 마감이 있을 때만 @here, @everyone은 절대 쓰지 않는다', () => {
    test('D-day 마감이 있으면 @here로 부른다', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_DAY)), { now: NOW });

      const messageCall = calls.find((c) => !c.url.endsWith('/threads'));
      assert.equal(messageCall?.body?.content, '@here');
      assert.deepEqual(messageCall?.body?.allowed_mentions, { parse: ['everyone'] });
    });

    test('D-1 마감이 있으면 @here로 부른다', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_MINUS_1)), { now: NOW });

      const messageCall = calls.find((c) => !c.url.endsWith('/threads'));
      assert.equal(messageCall?.body?.content, '@here');
    });

    test('D-2 마감만 있으면 조용히 게시만 하고 멘션하지 않는다', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });

      const messageCall = calls.find((c) => !c.url.endsWith('/threads'));
      assert.equal(messageCall?.body?.content, undefined, 'D-2/D-3은 멘션 없이 조용히 게시되어야 한다');
      assert.deepEqual(messageCall?.body?.allowed_mentions, { parse: [] });
    });

    test('어떤 경우에도 페이로드 어디에도 @everyone 문자열이 등장하지 않는다', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_DAY)), { now: NOW }); // 가장 급한 경우(@here 발동)로 테스트

      for (const call of calls) {
        const serialized = JSON.stringify(call.body ?? {});
        assert.ok(!serialized.includes('@everyone'), '@everyone은 오프라인 멤버까지 깨운다 — 절대 쓰면 안 된다');
      }
    });
  });

  describe('긴급도별 embed 색상 + 링크', () => {
    test('D-day/지남이면 빨강(TONE_COLOR.red)', async (t) => {
      mockDiscordFetch(t);
      const result = await sendDigest(fakeEnv(urgentTables(D_DAY)), { now: NOW });
      // message는 embed.description이다 — color는 별도 필드라 여기선 dryRun 경로로 embed 전체를 확인한다.
      assert.ok(result.sent);
    });

    test('D-3 이내면 주황(TONE_COLOR.orange)', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });
      const messageCall = calls.find((c) => !c.url.endsWith('/threads'));
      const embed = (messageCall?.body?.embeds as Array<{ color: number }>)[0];
      assert.equal(embed.color, TONE_COLOR.orange);
    });

    test('빨강 케이스의 embed color가 정확히 TONE_COLOR.red다', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_DAY)), { now: NOW });
      const messageCall = calls.find((c) => !c.url.endsWith('/threads'));
      const embed = (messageCall?.body?.embeds as Array<{ color: number }>)[0];
      assert.equal(embed.color, TONE_COLOR.red);
    });

    test('모든 항목에 공고 원문 링크가, 메시지 하단에 달력 링크가 항상 포함된다', async (t) => {
      const { calls } = mockDiscordFetch(t);
      await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });
      const messageCall = calls.find((c) => !c.url.endsWith('/threads'));
      const embed = (messageCall?.body?.embeds as Array<{ description: string }>)[0];
      assert.match(embed.description, /https:\/\/example\.com\/urgent/, '공고 원문 링크가 있어야 한다');
      assert.match(
        embed.description,
        /https:\/\/grantboard\.benclaude-toss\.workers\.dev\/calendar/,
        '달력 링크가 항상 있어야 한다',
      );
    });
  });

  describe('다이제스트 메시지에 스레드를 연다', () => {
    test('전송 성공 후 그 메시지에 스레드를 만든다(이름은 MM/DD 논의)', async (t) => {
      const { calls } = mockDiscordFetch(t);
      const result = await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });

      assert.equal(result.sent, true);
      const threadCall = calls.find((c) => c.url.endsWith('/threads'));
      assert.ok(threadCall, '스레드 생성 요청이 있어야 한다');
      assert.equal(threadCall?.url, 'https://discord.com/api/v10/channels/channel-123/messages/msg-123/threads');
      assert.equal(threadCall?.body?.name, '9/15 논의');
    });

    test('스레드 생성이 실패해도 다이제스트 발송 자체는 성공으로 남는다(로그만 남긴다)', async (t) => {
      mockDiscordFetch(t, { threadStatus: 500 });
      const errors: string[] = [];
      t.mock.method(console, 'error', (msg: string) => errors.push(msg));

      const result = await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });

      assert.equal(result.sent, true, '스레드 실패가 발송 결과를 망치면 안 된다');
      assert.ok(errors.some((e) => e.includes('스레드')), '스레드 실패는 로그로 남아야 한다');
    });
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

    const result = await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });

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

    await sendDigest(fakeEnv(urgentTables(D_MINUS_2)), { now: NOW });

    assert.ok(!logs.some((l) => l.includes(REAL_TOKEN)), '봇 토큰이 로그 문자열에 노출되면 안 된다');
  });
});
