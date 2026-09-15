/**
 * runCollect(worker/cron/collect.ts) 테스트.
 * D1은 programs 테이블만 흉내 내는 최소 FakeD1로 대체한다(listPrograms/upsertProgram이 쓰는
 * 쿼리 패턴만 지원). 네트워크는 globalThis.fetch를 목으로 바꿔 가로챈다 — 실호출 없음.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCollect } from './collect.ts';

type Row = Record<string, unknown>;

class FakeStatement {
  private sql: string;
  private db: FakeD1;
  private args: unknown[] = [];

  constructor(sql: string, db: FakeD1) {
    this.sql = sql;
    this.db = db;
  }
  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM programs')) return { results: this.db.programs as unknown as T[] };
    return { results: [] as T[] };
  }
  async first<T>(): Promise<T | null> {
    return null;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    this.db.runCalls.push({ sql: this.sql, args: this.args });
    return { meta: { changes: 1 } };
  }
}

/** listPrograms(SELECT) + upsertProgram(INSERT..ON CONFLICT)만 지원하는 최소 D1 목. */
class FakeD1 {
  programs: Row[];
  runCalls: { sql: string; args: unknown[] }[] = [];

  constructor(programs: Row[] = []) {
    this.programs = programs;
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this);
  }
}

function fakeEnv(overrides: Partial<Env> = {}, programs: Row[] = []): Env {
  return {
    DB: new FakeD1(programs) as unknown as Env['DB'],
    DISCORD_APPLICATION_ID: 'app-123',
    DISCORD_PUBLIC_KEY: 'pk',
    DISCORD_BOT_TOKEN: 'bot-token-not-real',
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_CHANNEL_ID: 'channel-123',
    ...overrides,
  } as Env;
}

function kstartupOkResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ response: { body: { items: { item: items }, totalCount: items.length } } }), {
    status: 200,
  });
}

describe('runCollect', () => {
  test('DATA_GO_KR_KEY, BIZINFO_CRTFC_KEY가 둘 다 없으면 조용히 건너뛴다(에러 아님)', async (t) => {
    let fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    });
    const logs: string[] = [];
    t.mock.method(console, 'error', (msg: string) => logs.push(`ERROR: ${msg}`));
    t.mock.method(console, 'log', (msg: string) => logs.push(msg));

    const env = fakeEnv({ DATA_GO_KR_KEY: undefined, BIZINFO_CRTFC_KEY: undefined });
    const result = await runCollect(env);

    assert.equal(fetchCalls, 0, '키가 없으면 네트워크 호출 자체가 없어야 한다');
    assert.equal(result.kstartup.skippedNoKey, true);
    assert.equal(result.kstartup.failed, false);
    assert.equal(result.bizinfo.skippedNoKey, true);
    assert.equal(result.bizinfo.failed, false);
    assert.equal(result.wrote, false);
    assert.equal((env.DB as unknown as FakeD1).runCalls.length, 0, 'D1 쓰기가 발생하면 안 된다');
    assert.ok(!logs.some((l) => l.startsWith('ERROR:')), '키 미설정은 에러로 취급하면 안 된다');
  });

  test('API가 빈 배열을 줘도 기존 programs가 지워지지 않는다', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => kstartupOkResponse([]));
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});

    const existingRows: Row[] = [
      {
        id: 'k-startup-1',
        title: '기존 자동수집 공고',
        organizer: '기관',
        source_url: 'https://example.com',
        category: '정부지원사업',
        apply_start: null,
        apply_end: '2026-12-31',
        apply_end_time: null,
        announce_date: null,
        support_amount: null,
        source: 'k-startup',
        collected_at: null,
        eligibility: null,
        tags: null,
        alias_titles: null,
      },
    ];
    const env = fakeEnv({ DATA_GO_KR_KEY: 'test-key', BIZINFO_CRTFC_KEY: undefined }, existingRows);
    const result = await runCollect(env);

    assert.equal(result.kstartup.count, 0);
    assert.equal(result.wrote, false, '반영할 신규 결과가 없으면 D1을 건드리지 않는다');
    assert.equal((env.DB as unknown as FakeD1).runCalls.length, 0);
    // FakeD1 자체가 DELETE를 구현하지 않으므로, existingRows가 그대로 남아있다는 것 자체가
    // "지워지지 않았다"의 증거다.
    assert.equal((env.DB as unknown as FakeD1).programs.length, 1);
  });

  test('한 소스가 실패해도 다른 소스 결과는 반영된다', async (t) => {
    const bizinfoRaw = {
      pblancNm: '기업마당 테스트 공고',
      jrsdInsttNm: '중소벤처기업부',
      pblancUrl: 'https://bizinfo.example.com/1',
      reqstBeginDe: '20260901',
      reqstEndDe: '20261001',
    };
    t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
      if (String(url).includes('apis.data.go.kr')) {
        throw new Error('simulated network failure');
      }
      return new Response(JSON.stringify({ jsonArray: [bizinfoRaw], totCnt: 1 }), { status: 200 });
    });
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});

    const env = fakeEnv({ DATA_GO_KR_KEY: 'bad-key', BIZINFO_CRTFC_KEY: 'good-key' });
    const result = await runCollect(env);

    assert.equal(result.kstartup.failed, true);
    assert.equal(result.bizinfo.failed, false);
    assert.equal(result.bizinfo.count, 1);
    assert.equal(result.wrote, true);
    assert.ok((env.DB as unknown as FakeD1).runCalls.length >= 1, '성공한 소스(기업마당)는 D1에 반영되어야 한다');
  });

  test('서비스키가 로그·에러 문자열에 나타나지 않는다', async (t) => {
    const SECRET = 'super-secret-data-go-kr-key-xyz';
    t.mock.method(globalThis, 'fetch', async () => new Response('not json at all', { status: 200 }));
    const logs: string[] = [];
    t.mock.method(console, 'error', (msg: string) => logs.push(msg));
    t.mock.method(console, 'warn', (msg: string) => logs.push(msg));
    t.mock.method(console, 'log', (msg: string) => logs.push(msg));

    const env = fakeEnv({ DATA_GO_KR_KEY: SECRET, BIZINFO_CRTFC_KEY: undefined });
    await runCollect(env);

    assert.ok(!logs.some((l) => l.includes(SECRET)), '서비스키가 로그에 노출되면 안 된다');
  });
});
