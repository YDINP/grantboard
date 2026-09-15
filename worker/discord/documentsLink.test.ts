/**
 * /서류 연결 통합 테스트 — /상태 변경과 같은 종류의 구멍을 고쳤는지 검증:
 * "지원건이 없는 공고엔 서류를 연결할 방법이 없었다"를 ensureApplication으로 고쳤다.
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

function trackedCtx(): { ctx: ExecutionContext; settled: () => Promise<unknown> } {
  let pending: Promise<unknown> = Promise.resolve();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending = promise.catch(() => {});
    },
  } as unknown as ExecutionContext;
  return { ctx, settled: () => pending };
}

function withDocument(tables: FakeTables): FakeTables {
  tables.documents = [
    { id: 'doc-1', name: '사업자등록증명원', kind: '증빙', reusable: 1, issued_at: null, validity_days: null, valid_until: null, ready: 0, reuse_source: null },
  ];
  return tables;
}

describe('/서류 연결 — 지원건 없는 공고 처리', () => {
  test('지원건이 없는 공고를 골라 서류를 연결하면 지원건이 새로 생기고 연결된다', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 }));
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = withDocument(fixtureTables()); // prog-1 + doc-1, applications 비어 있음
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    const request = await buildSignedRequest(keyPair.privateKey, {
      type: InteractionType.MESSAGE_COMPONENT,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      member: { nick: '에이든', user: { id: 'user-1', username: 'aiden' } },
      data: { custom_id: encodeCustomId('documents', 'link-select-program', 'doc-1'), component_type: 3, values: ['prog-1'] },
    });
    const res = await handleInteraction(request, env, ctx);
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_UPDATE_MESSAGE);

    await settled();

    assert.equal(tables.applications.length, 1, '지원건이 새로 생겨야 한다');
    const created = tables.applications[0]!;
    assert.equal(created.program_id, 'prog-1');
    assert.equal(created.status, '검토중', '자동 생성 시 초기 상태는 검토중이어야 한다');
    assert.deepEqual(JSON.parse(created.document_ids as string), ['doc-1'], '방금 고른 서류가 연결돼 있어야 한다');
  });

  test('이미 연결돼 있으면 다시 고를 때 해제된다(기존 지원건 유지)', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'msg-x' }), { status: 200 }));
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const tables = withDocument(fixtureTables());
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
        document_ids: JSON.stringify(['doc-1']),
      },
    ];
    const env = fakeEnv(publicKeyHex, tables);
    const { ctx, settled } = trackedCtx();

    const request = await buildSignedRequest(keyPair.privateKey, {
      type: InteractionType.MESSAGE_COMPONENT,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      member: { nick: '에이든', user: { id: 'user-1', username: 'aiden' } },
      data: { custom_id: encodeCustomId('documents', 'link-select-program', 'doc-1'), component_type: 3, values: ['prog-1'] },
    });
    await handleInteraction(request, env, ctx);
    await settled();

    assert.equal(tables.applications.length, 1, '새로 만들지 않고 기존 지원건을 그대로 써야 한다');
    const updated = tables.applications[0]!;
    assert.equal(updated.id, 'app-existing');
    assert.deepEqual(JSON.parse(updated.document_ids as string), [], '이미 연결돼 있었으니 해제돼야 한다');
  });
});
