/**
 * /내마감의 매핑 우선 + 근사매칭 폴백 동작을 검증한다.
 * loadBoardModel(D1)을 실제로 거쳐야 하는 시나리오라, repo.ts가 쓰는 SQL 패턴만 흉내 내는
 * 최소 FakeD1로 in-memory 데이터를 흘려보낸다(실제 SQLite 대신 — 새 의존성을 추가하지 않기 위함).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from './interactions.ts';
import { InteractionType, InteractionResponseType } from './types.ts';

type Row = Record<string, unknown>;

interface Tables {
  owner_map: Row[];
  programs: Row[];
  applications: Row[];
  documents: Row[];
  team_profile: Row[];
}

class FakeStatement {
  private sql: string;
  private tables: Tables;
  private args: unknown[] = [];

  constructor(sql: string, tables: Tables) {
    this.sql = sql;
    this.tables = tables;
  }

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.rows()[0] as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows() as T[] };
  }

  private rows(): Row[] {
    if (this.sql.includes('FROM owner_map')) {
      return this.tables.owner_map.filter((r) => r.discord_user_id === this.args[0]);
    }
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

function fixtureTables(): Tables {
  return {
    owner_map: [],
    programs: [
      {
        id: 'prog-1',
        title: '테스트공고',
        organizer: '테스트기관',
        source_url: 'https://example.com',
        category: '공모전',
        apply_start: null,
        apply_end: '2026-12-31',
        apply_end_time: null,
        announce_date: null,
        support_amount: null,
        source: 'manual',
        collected_at: null,
        eligibility: null,
        tags: null,
        alias_titles: null,
      },
    ],
    applications: [
      {
        id: 'app-1',
        program_id: 'prog-1',
        status: '작성중',
        owner: 'AB',
        priority: 'mid',
        target_submit_date: null,
        submitted_at: null,
        result_at: null,
        note: null,
        document_ids: null,
      },
    ],
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function makeKeyPair() {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKeyHex = bytesToHex(
    new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer),
  );
  return { keyPair, publicKeyHex };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message));
  return bytesToHex(sig);
}

describe('/내마감 owner 매핑 우선 + 폴백', () => {
  test('/나는으로 등록하지 않은 유저는 이름 근사매칭으로 폴백하고, 안내 문구가 붙는다', async (t) => {
    const bodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });

    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = {
      DB: new FakeD1(fixtureTables()) as unknown as Env['DB'],
      DISCORD_APPLICATION_ID: 'app-123',
      DISCORD_PUBLIC_KEY: publicKeyHex,
      DISCORD_BOT_TOKEN: 'bot-token-not-real',
      DISCORD_GUILD_ID: 'guild-123',
      DISCORD_CHANNEL_ID: 'channel-123',
    } as Env;

    let pending: Promise<unknown> = Promise.resolve();
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending = p; } } as unknown as ExecutionContext;

    const body = JSON.stringify({
      type: InteractionType.APPLICATION_COMMAND,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      member: { nick: 'AB', user: { id: 'user-1', username: 'aiden' } },
      data: { name: '내마감' },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(keyPair.privateKey, timestamp, body);
    const request = new Request('https://example.com/discord/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
      body,
    });

    const res = await handleInteraction(request, env, ctx);
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

    await pending;
    assert.equal(bodies.length, 1);
    const embed = bodies[0].embeds[0];
    assert.match(embed.description, /테스트공고/);
    assert.ok(embed.footer, '근사매칭 폴백일 때는 안내 문구(footer)가 반드시 붙어야 한다');
    assert.match(embed.footer.text, /나는/);
  });

  test('/나는으로 등록된 유저는 정확히 매칭되고, 폴백 안내 문구가 없다', async (t) => {
    const bodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });

    const tables = fixtureTables();
    tables.owner_map = [{ discord_user_id: 'user-1', owner: 'AB' }];

    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = {
      DB: new FakeD1(tables) as unknown as Env['DB'],
      DISCORD_APPLICATION_ID: 'app-123',
      DISCORD_PUBLIC_KEY: publicKeyHex,
      DISCORD_BOT_TOKEN: 'bot-token-not-real',
      DISCORD_GUILD_ID: 'guild-123',
      DISCORD_CHANNEL_ID: 'channel-123',
    } as Env;

    let pending: Promise<unknown> = Promise.resolve();
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending = p; } } as unknown as ExecutionContext;

    const body = JSON.stringify({
      type: InteractionType.APPLICATION_COMMAND,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      // 표시 이름은 일부러 owner와 다르게 둔다 — 매핑이 있으면 표시 이름과 무관하게 정확히 찾아야 한다.
      member: { nick: '전혀다른이름', user: { id: 'user-1', username: 'aiden' } },
      data: { name: '내마감' },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(keyPair.privateKey, timestamp, body);
    const request = new Request('https://example.com/discord/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
      body,
    });

    const res = await handleInteraction(request, env, ctx);
    await res.json();
    await pending;

    assert.equal(bodies.length, 1);
    const embed = bodies[0].embeds[0];
    assert.match(embed.description, /테스트공고/, '매핑된 owner(AB)로 지원건을 정확히 찾아야 한다');
    assert.equal(embed.footer, undefined, '정확한 매핑이 있을 때는 폴백 안내 문구가 없어야 한다');
  });
});
