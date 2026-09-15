/**
 * handleInteraction 통합 테스트.
 *
 * ⚠️ 이 파일은 worker/discord/handlers/*.ts가 import하는 worker/db/repo.ts와 worker/env.d.ts가
 * 실제로 존재해야 로드된다(다른 담당 작업물). 그 전까지는 "Cannot find module" 오류로
 * 전체가 실패하는 게 정상이다 — 이 파일 자체의 버그가 아니다. 실행 방법과 현재 상태는
 * 작업 보고서를 참고할 것.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from './interactions.ts';
import { InteractionType, InteractionResponseType, ComponentType, TextInputStyle } from './types.ts';
import { encodeCustomId } from './customId.ts';

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

function fakeEnv(publicKeyHex: string): Env {
  return {
    DB: {} as Env['DB'],
    DISCORD_APPLICATION_ID: 'app-123',
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_BOT_TOKEN: 'bot-token-not-real',
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_CHANNEL_ID: 'channel-123',
  } as Env;
}

function fakeCtx(): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      // 백그라운드 작업 실패는 이 테스트의 관심사가 아니다(D1 mock이 없어 당연히 실패한다).
      promise.catch(() => {});
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

/**
 * defer된 백그라운드 작업(ctx.waitUntil로 넘긴 프로미스)이 끝날 때까지 테스트가 기다릴 수 있게
 * 해 주는 ctx. 임의의 sleep 없이 "편집 응답까지 다 끝났다"를 결정적으로 기다리기 위함이다.
 */
function trackedCtx(): { ctx: ExecutionContext; settled: () => Promise<unknown> } {
  let pending: Promise<unknown> = Promise.resolve();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending = promise.catch(() => {});
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, settled: () => pending };
}

async function postInteraction(
  env: Env,
  privateKey: CryptoKey,
  payload: unknown,
  ctx: ExecutionContext = fakeCtx(),
) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(privateKey, timestamp, body);
  const request = new Request('https://example.com/discord/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body,
  });
  return handleInteraction(request, env, ctx);
}

/** discord.com으로 나가는 PATCH(editOriginalResponse) 호출을 가로채 바디를 기록한다. 실네트워크 호출 없이 검증한다. */
function captureEditRequests(t: import('node:test').TestContext): { bodies: any[] } {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return new Response('{}', { status: 200 });
  });
  return { bodies };
}

describe('handleInteraction', () => {
  test('서명이 잘못된 요청은 401을 받는다', async () => {
    const { publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const request = new Request('https://example.com/discord/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Signature-Ed25519': 'aa'.repeat(64),
        'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ type: InteractionType.PING }),
    });
    const res = await handleInteraction(request, env, fakeCtx());
    assert.equal(res.status, 401);
  });

  test('서명 헤더가 없는 요청은 401을 받는다', async () => {
    const { publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const request = new Request('https://example.com/discord/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: InteractionType.PING }),
    });
    const res = await handleInteraction(request, env, fakeCtx());
    assert.equal(res.status, 401);
  });

  test('PING에는 PONG으로 응답한다', async () => {
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const res = await postInteraction(env, keyPair.privateKey, { type: InteractionType.PING });
    assert.equal(res.status, 200);
    // Response.json()이 @cloudflare/workers-types 아래서 unknown을 반환해 테스트 편의상 캐스팅한다.
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.PONG);
  });

  test('알 수 없는 커맨드는 에러가 아니라 사용자에게 보이는 메시지로 응답한다', async () => {
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const res = await postInteraction(env, keyPair.privateKey, {
      type: InteractionType.APPLICATION_COMMAND,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      data: { name: '없는커맨드' },
    });
    assert.equal(res.status, 200);
    // Response.json()이 @cloudflare/workers-types 아래서 unknown을 반환해 테스트 편의상 캐스팅한다.
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    assert.match(json.data.content, /알 수 없는 커맨드/);
  });

  test('/달력은 DB 접근 없이 즉시 링크 버튼으로 응답한다', async () => {
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const res = await postInteraction(env, keyPair.privateKey, {
      type: InteractionType.APPLICATION_COMMAND,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      data: { name: '달력' },
    });
    // Response.json()이 @cloudflare/workers-types 아래서 unknown을 반환해 테스트 편의상 캐스팅한다.
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    const button = json.data.components[0].components[0];
    assert.equal(button.url, 'https://example.com/calendar');
  });

  test('/임박처럼 D1을 읽는 커맨드는 즉시 DEFERRED 응답을 반환한다(3초 제한 대응)', async (t) => {
    // env.DB가 mock이라 백그라운드 처리(loadBoardModel)는 반드시 실패한다. 그 실패 후 편집 호출이
    // 실제 discord.com에 나가지 않도록 fetch를 막아 이 테스트를 네트워크 독립적으로 만든다.
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const res = await postInteraction(env, keyPair.privateKey, {
      type: InteractionType.APPLICATION_COMMAND,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      data: { name: '임박' },
    });
    // Response.json()이 @cloudflare/workers-types 아래서 unknown을 반환해 테스트 편의상 캐스팅한다.
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  });

  test('/서류 추가 모달에 잘못된 날짜(존재하지 않는 날)를 내면 저장하지 않고 사유를 알려준다', async (t) => {
    const { bodies } = captureEditRequests(t);
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const { ctx, settled } = trackedCtx();

    const res = await postInteraction(
      env,
      keyPair.privateKey,
      {
        type: InteractionType.MODAL_SUBMIT,
        id: 'i1',
        token: 'tok',
        application_id: 'app-123',
        data: {
          custom_id: encodeCustomId('documents', 'add-submit'),
          components: [
            { type: ComponentType.ACTION_ROW, components: [{ type: ComponentType.TEXT_INPUT, custom_id: 'name', value: '사업자등록증명원' }] },
            { type: ComponentType.ACTION_ROW, components: [{ type: ComponentType.TEXT_INPUT, custom_id: 'kind', value: '증빙' }] },
            // 2월 30일 — 실제로 존재하지 않는 날짜.
            { type: ComponentType.ACTION_ROW, components: [{ type: ComponentType.TEXT_INPUT, custom_id: 'issuedAt', value: '2026-02-30' }] },
            { type: ComponentType.ACTION_ROW, components: [{ type: ComponentType.TEXT_INPUT, custom_id: 'validityDays', value: '' }] },
          ],
        },
      },
      ctx,
    );
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

    await settled();
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].content, /발급일/);
    assert.match(bodies[0].content, /2월은 28일까지/);
    // 검증에 실패했으니 저장 성공 메시지(임베드)는 절대 나가면 안 된다.
    assert.equal(bodies[0].embeds, undefined);
  });

  test('/공고 삭제: 공고 선택 단계는 확인 화면만 준비할 뿐 실제 삭제는 실행하지 않는다', async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (msg: string) => {
      errors.push(msg);
    });
    captureEditRequests(t);
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex); // env.DB가 mock이라 board 조회는 실패한다 — 어느 단계에서 실패했는지로 판별한다.
    const { ctx, settled } = trackedCtx();

    const res = await postInteraction(
      env,
      keyPair.privateKey,
      {
        type: InteractionType.MESSAGE_COMPONENT,
        id: 'i1',
        token: 'tok',
        application_id: 'app-123',
        data: {
          custom_id: encodeCustomId('programs', 'delete-select-program'),
          component_type: 3,
          values: ['prog-1'],
        },
      },
      ctx,
    );
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.DEFERRED_UPDATE_MESSAGE);

    await settled();
    assert.ok(
      errors.some((e) => e.includes('/공고 삭제 2단계 실패')),
      '확인 화면을 준비하는 2단계 코드까지만 실행되어야 한다',
    );
    assert.ok(
      !errors.some((e) => e.includes('/공고 삭제 3단계 실패')),
      '3단계(실제 삭제, deleteProgram 호출)는 이 단계에서 절대 실행되면 안 된다',
    );
  });

  test('/공고 삭제: 취소 버튼은 DB에 전혀 접근하지 않고 즉시 취소 메시지를 준다', async () => {
    const { keyPair, publicKeyHex } = await makeKeyPair();
    const env = fakeEnv(publicKeyHex);
    const res = await postInteraction(env, keyPair.privateKey, {
      type: InteractionType.MESSAGE_COMPONENT,
      id: 'i1',
      token: 'tok',
      application_id: 'app-123',
      data: { custom_id: encodeCustomId('programs', 'delete-cancel'), component_type: 2 },
    });
    // handleProgramDeleteCancel은 env/ctx를 받지 않는 시그니처라 애초에 DB에 접근할 수 없다.
    const json = (await res.json()) as any;
    assert.equal(json.type, InteractionResponseType.UPDATE_MESSAGE);
    assert.match(json.data.content, /취소/);
    assert.deepEqual(json.data.components, []);
  });
});
