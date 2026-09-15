/**
 * /상태 변경 통합 테스트 — 핵심 버그 수정 검증:
 * "지원건이 없는 공고는 선택지에도 안 뜨고, 골라도 상태를 넣을 방법이 없었다"를 고쳤다.
 * ensureApplication을 거쳐 실제 D1 쓰기까지 검증해야 해서, repo.ts가 쓰는 SQL 패턴만
 * 흉내 낸 FakeD1(testSupport/fakeD1.ts)로 in-memory 데이터를 흘려보낸다 — 실네트워크/실D1 없음.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from './interactions.ts';
import { InteractionType, InteractionResponseType } from './types.ts';
import { encodeCustomId } from './customId.ts';
import { FakeD1, fixtureTables, type FakeTables } from './testSupport/fakeD1.ts';
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

/** ctx.waitUntil로 넘긴 백그라운드 작업이 끝날 때까지 기다릴 수 있게 해준다. */
function trackedCtx(): { ctx: ExecutionContext; settled: () => Promise<unknown> } {
  let pending: Promise<unknown> = Promise.resolve();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending = promise.catch(() => {});
    },
  } as unknown as ExecutionContext;
  return { ctx, settled: () => pending };
}

async function postComponent(env: Env, privateKey: CryptoKey, data: unknown, ctx: ExecutionContext) {
  const request = await buildSignedRequest(privateKey, {
    type: InteractionType.MESSAGE_COMPONENT,
    id: 'i1',
    token: 'tok',
    application_id: 'app-123',
    member: { nick: '에이든', user: { id: 'user-1', username: 'aiden' } },
    data,
  });
  return handleInteraction(request, env, ctx);
}

describe('/상태 변경 — 지원건 없는 공고 처리', () => {
  test('지원건이 없는 공고를 골라 상태를 넣으면 지원건이 새로 생긴다', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 }));
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables(); // prog-1만 있고 applications는 비어 있다.
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    const res = await postComponent(
      env,
      keyPair.privateKey,
      { custom_id: encodeCustomId('status', 'select-value', 'prog-1'), component_type: 3, values: ['준비'] },
      ctx,
    );
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_UPDATE_MESSAGE);

    await settled();

    assert.equal(tables.applications.length, 1, '지원건이 새로 생겨야 한다');
    const created = tables.applications[0]!;
    assert.equal(created.program_id, 'prog-1');
    assert.equal(created.status, '준비');
  });

  test('owner는 호출자의 /나는 매핑에서 온다', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 }));
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables();
    tables.owner_map = [{ discord_user_id: 'user-1', owner: 'AB' }]; // postComponent의 user.id와 일치
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    await postComponent(
      env,
      keyPair.privateKey,
      { custom_id: encodeCustomId('status', 'select-value', 'prog-1'), component_type: 3, values: ['검토중'] },
      ctx,
    );
    await settled();

    assert.equal(tables.applications[0]!.owner, 'AB', '매핑된 owner를 그대로 써야 한다');
  });

  test('매핑이 없으면 기본값으로 채우고 등록 안내를 남긴다', async (t) => {
    // 이 흐름은 인터랙션 응답 편집(webhooks/.../messages/@original)과 syncStatusBoard의
    // 현황판 발행(channels/.../messages)이 둘 다 fetch를 부른다 — url로 우리가 보려는
    // 인터랙션 응답만 골라낸다.
    const webhookBodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.body && String(url).includes('/webhooks/')) webhookBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 });
    });
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables(); // owner_map 비어 있음
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    await postComponent(
      env,
      keyPair.privateKey,
      { custom_id: encodeCustomId('status', 'select-value', 'prog-1'), component_type: 3, values: ['검토중'] },
      ctx,
    );
    await settled();

    const owner = tables.applications[0]!.owner as string;
    assert.ok(owner.length > 0 && owner.length <= 4, 'owner는 비어있지 않고 4자 이하여야 한다(스키마 제약)');
    assert.equal(webhookBodies.length, 1);
    assert.match(webhookBodies[0].embeds[0].description, /\/나는/, '/나는으로 등록하라는 안내가 있어야 한다');
  });

  test('이미 지원건이 있으면 새로 만들지 않고 상태만 갱신한다', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 }));
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables();
    tables.applications = [
      {
        id: 'app-existing',
        program_id: 'prog-1',
        status: '작성중',
        owner: 'ZZ',
        priority: 'mid',
        target_submit_date: null,
        submitted_at: null,
        result_at: null,
        note: null,
        document_ids: '[]',
      },
    ];
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    await postComponent(
      env,
      keyPair.privateKey,
      { custom_id: encodeCustomId('status', 'select-value', 'prog-1'), component_type: 3, values: ['제출완료'] },
      ctx,
    );
    await settled();

    assert.equal(tables.applications.length, 1, '새로 만들지 않고 기존 지원건 하나만 유지해야 한다');
    const updated = tables.applications[0]!;
    assert.equal(updated.id, 'app-existing', '기존 id가 그대로 유지돼야 한다');
    assert.equal(updated.status, '제출완료');
    assert.equal(updated.owner, 'ZZ', '기존 owner는 건드리지 않아야 한다');
  });

  test('1단계 공고 선택 목록에는 지원건 없는 공고도 포함된다', async (t) => {
    const bodies: any[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 });
    });
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = fixtureTables(); // prog-1, 지원건 없음
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    const request = await buildSignedRequest(keyPair.privateKey, {
      type: InteractionType.APPLICATION_COMMAND,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      member: { nick: '에이든', user: { id: 'user-1', username: 'aiden' } },
      data: { name: '상태', options: [{ name: '변경', type: 1 }] },
    });

    const res = await handleInteraction(request, env, ctx);
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

    await settled();

    const options = bodies[bodies.length - 1].components[0].components[0].options;
    assert.ok(
      options.some((o: any) => o.value === 'prog-1' && /미지원/.test(o.description)),
      '지원건이 없는 공고가 "미지원" 표시와 함께 선택지에 있어야 한다',
    );
  });
});
