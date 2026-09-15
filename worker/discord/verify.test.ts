import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiscordRequest } from './verify.ts';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 테스트용 Ed25519 키쌍을 만들고, 디스코드가 실제로 서명하는 방식(timestamp + body)대로 서명한다. */
async function signRequest(body: string, timestamp: string) {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const message = new TextEncoder().encode(timestamp + body);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, message));
  const publicKeyRaw = new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer);
  return {
    publicKeyHex: bytesToHex(publicKeyRaw),
    signatureHex: bytesToHex(signatureBytes),
  };
}

describe('verifyDiscordRequest', () => {
  test('올바른 서명은 통과한다', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const { publicKeyHex, signatureHex } = await signRequest(body, timestamp);

    const ok = await verifyDiscordRequest(body, signatureHex, timestamp, publicKeyHex);
    assert.equal(ok, true);
  });

  test('바디가 조작되면 실패한다', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const { publicKeyHex, signatureHex } = await signRequest(body, timestamp);

    const ok = await verifyDiscordRequest(JSON.stringify({ type: 2 }), signatureHex, timestamp, publicKeyHex);
    assert.equal(ok, false);
  });

  test('다른 공개키로는 실패한다', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const { signatureHex } = await signRequest(body, timestamp);
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const otherPublicKeyHex = bytesToHex(
      new Uint8Array((await crypto.subtle.exportKey('raw', other.publicKey)) as ArrayBuffer),
    );

    const ok = await verifyDiscordRequest(body, signatureHex, timestamp, otherPublicKeyHex);
    assert.equal(ok, false);
  });

  test('서명 헤더가 없으면 실패한다', async () => {
    const ok = await verifyDiscordRequest('{}', null, '1700000000', 'aa'.repeat(32));
    assert.equal(ok, false);
  });

  test('타임스탬프 헤더가 없으면 실패한다', async () => {
    const ok = await verifyDiscordRequest('{}', 'aa'.repeat(64), null, 'aa'.repeat(32));
    assert.equal(ok, false);
  });

  test('잘못된 형식의 공개키는 예외 없이 false를 반환한다', async () => {
    const ok = await verifyDiscordRequest('{}', 'aa'.repeat(64), '1700000000', 'not-hex');
    assert.equal(ok, false);
  });

  test('잘못된 형식의 서명은 예외 없이 false를 반환한다', async () => {
    const ok = await verifyDiscordRequest('{}', 'not-hex', '1700000000', 'aa'.repeat(32));
    assert.equal(ok, false);
  });
});
