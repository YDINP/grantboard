/**
 * 디스코드 인터랙션 요청의 Ed25519 서명 검증.
 *
 * 디스코드는 모든 인터랙션 POST에 X-Signature-Ed25519 / X-Signature-Timestamp 헤더를 붙인다.
 * 검증에 실패하면 반드시 401을 반환해야 한다 — 엔드포인트 등록 시 디스코드가 잘못된 서명으로
 * 테스트 요청을 보내고, 401을 주지 않으면 등록 자체가 거부된다.
 *
 * Cloudflare Workers에는 Node의 crypto 모듈이 없으므로 WebCrypto(crypto.subtle)만 사용한다.
 * Ed25519는 Workers 런타임의 WebCrypto가 네이티브로 지원한다(호환성 날짜가 충분히 최신이어야
 * 한다 — wrangler.toml의 compatibility_date 설정은 worker-core 담당).
 */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 원본 요청 바디(body)와 헤더 값(signature, timestamp), 그리고 애플리케이션 공개키로
 * Ed25519 서명을 검증한다. 반환값이 false면 401로 거부해야 한다.
 *
 * body는 반드시 파싱 전의 원문 문자열이어야 한다 — JSON.parse 후 다시 stringify한 값은
 * 원본과 바이트가 달라질 수 있어 서명이 항상 깨진다.
 */
export async function verifyDiscordRequest(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;

  let key: CryptoKey;
  let signatureBytes: Uint8Array;
  try {
    key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    signatureBytes = hexToBytes(signature);
  } catch {
    // 공개키/서명이 hex가 아니거나 길이가 안 맞으면 검증 실패로 처리한다(예외를 던지지 않는다).
    return false;
  }

  const message = new TextEncoder().encode(timestamp + body);

  try {
    return await crypto.subtle.verify('Ed25519', key, signatureBytes, message);
  } catch {
    return false;
  }
}
