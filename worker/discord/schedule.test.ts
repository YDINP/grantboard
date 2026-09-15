/**
 * /일정 핸들러 통합 테스트 — "필터 때문에 0건"과 "데이터 자체가 없어서 0건"을 구분하는지,
 * 실제로 defer + 편집까지 이어지는지를 검증한다. 실네트워크/실D1 접근 없음(FakeD1 + fetch mock).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from './interactions.ts';
import { InteractionType, InteractionResponseType } from './types.ts';
import { FakeD1, fixtureTables, emptyTables, type FakeTables } from './testSupport/fakeD1.ts';
import { makeKeyPair, buildSignedRequest } from './testSupport/discordSigning.ts';

function fakeEnv(publicKeyHex: string, tables: FakeTables): Env {
  return {
    DB: new FakeD1(tables) as unknown as Env['DB'],
    DISCORD_APPLICATION_ID: 'app-123',
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_BOT_TOKEN: 'bot-token-not-real',
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_CHANNEL_ID: 'channel-123',
  } as Env;
}

function trackedCtx(): { ctx: ExecutionContext; settled: () => Promise<unknown> } {
  let pending: Promise<unknown> = Promise.resolve();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending = promise.catch(() => {});
    },
  } as unknown as ExecutionContext;
  return { ctx, settled: () => pending };
}

async function runScheduleCommand(env: Env, ctx: ExecutionContext, privateKey: CryptoKey, options: unknown[] = []) {
  const request = await buildSignedRequest(privateKey, {
    type: InteractionType.APPLICATION_COMMAND,
    id: 'i1',
    token: 'tok',
    application_id: 'app-123',
    member: { nick: '에이든', user: { id: 'user-1', username: 'aiden' } },
    data: { name: '일정', options },
  });
  return handleInteraction(request, env, ctx);
}

describe('/일정', () => {
  test('등록된 공고 자체가 없으면 "일정이 없다"는 안내를 준다(필터 안내와 다른 문구)', async (t) => {
    const webhookBodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.body && String(url).includes('/webhooks/')) webhookBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 });
    });
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = emptyTables();
    tables.team_profile = [
      { id: 1, has_business_registration: 0, business_registered_at: null, incorporated_at: null, founder_birth_year: null, region: '서울' },
    ];
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    const res = await runScheduleCommand(env, ctx, keyPair.privateKey);
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

    await settled();
    assert.equal(webhookBodies.length, 1);
    assert.match(webhookBodies[0].content, /등록된 일정이 없습니다/);
    assert.match(webhookBodies[0].content, /\/공고 추가/);
  });

  test('데이터는 있지만 범위 필터에 안 걸리면 "조건에 맞는 일정이 없다"고 알려주고 범위를 알려준다', async (t) => {
    const webhookBodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.body && String(url).includes('/webhooks/')) webhookBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 });
    });
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables();
    // prog-1의 마감이 2026-12-31이라 기본 "이번달"(테스트 실행 시점 기준)에는 걸릴 수도, 안 걸릴
    // 수도 있으니 확실히 걸리지 않게 아주 먼 미래로 옮긴다.
    tables.programs[0]!.apply_end = '2099-01-01';
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    const res = await runScheduleCommand(env, ctx, keyPair.privateKey, [{ name: '범위', type: 3, value: '이번달' }]);
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

    await settled();
    assert.equal(webhookBodies.length, 1);
    assert.match(webhookBodies[0].content, /"이번달".*조건에 맞는 일정이 없습니다/);
    assert.doesNotMatch(webhookBodies[0].content, /등록된 일정이 없습니다/, '데이터가 있는데 데이터 자체가 없다는 문구를 쓰면 안 된다');
  });

  test('"전체" 범위로는 먼 미래 일정도 타임라인에 나온다', async (t) => {
    const webhookBodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.body && String(url).includes('/webhooks/')) webhookBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 });
    });
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables();
    tables.programs[0]!.apply_end = '2099-01-01';
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    await runScheduleCommand(env, ctx, keyPair.privateKey, [{ name: '범위', type: 3, value: '전체' }]);
    await settled();

    assert.equal(webhookBodies.length, 1);
    assert.equal(webhookBodies[0].embeds[0].title, '📅 일정 타임라인');
    assert.match(webhookBodies[0].embeds[0].description, /테스트공고/);
    assert.match(webhookBodies[0].embeds[0].description, /2099년 1월/);
  });
});
