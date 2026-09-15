/**
 * 테스트에서 실제 디스코드 서명을 만들어 verify.ts를 통과시키기 위한 유틸리티.
 * interactions.test.ts/myDeadlinesFallback.test.ts와 같은 방식을 공용 모듈로 뺀 것이다.
 * `.test.ts`로 끝나지 않아 테스트 러너에 그 자체로는 걸리지 않는다.
 */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function makeKeyPair(): Promise<{ keyPair: CryptoKeyPair; publicKeyHex: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKeyHex = bytesToHex(new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer));
  return { keyPair, publicKeyHex };
}

export async function signBody(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message));
  return bytesToHex(sig);
}

export async function buildSignedRequest(privateKey: CryptoKey, payload: unknown): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signBody(privateKey, timestamp, body);
  return new Request('https://example.com/discord/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body,
  });
}
