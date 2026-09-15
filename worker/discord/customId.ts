/**
 * 컴포넌트(버튼/셀렉트)의 custom_id에 상태를 인코딩/디코딩한다.
 * 디스코드는 인터랙션 사이 상태를 서버에 저장해주지 않으므로, "어떤 화면/어떤 대상"인지를
 * custom_id 문자열 자체에 실어 보낸다. 디스코드 제약: custom_id는 최대 100바이트.
 *
 * 구분자로 ':' 대신 제어문자(U+001F, Unit Separator)를 쓴다 — programId나 상태값에 콜론이
 * 섞여 들어와도 이스케이프 없이 안전하게 split할 수 있다.
 */

const FIELD_SEP = '';

export interface DecodedCustomId {
  /** 어느 커맨드/기능에서 만든 컴포넌트인지 (예: 'status', 'programs'). */
  namespace: string;
  /** 그 안에서의 단계/동작 (예: 'select-program', 'select-value'). */
  action: string;
  /** 나머지 파라미터(예: programId). */
  params: string[];
}

/**
 * custom_id를 조립한다. 100바이트를 넘으면 즉시 예외를 던진다 — 조립 시점에 잡아야
 * 디스코드 API가 400으로 거부하기 전에 원인을 알 수 있다.
 */
export function encodeCustomId(namespace: string, action: string, ...params: string[]): string {
  const id = [namespace, action, ...params].join(FIELD_SEP);
  const byteLength = new TextEncoder().encode(id).length;
  if (byteLength > 100) {
    throw new Error(`custom_id가 100바이트를 초과합니다(${byteLength}바이트): ${namespace}${FIELD_SEP}${action}...`);
  }
  return id;
}

export function decodeCustomId(customId: string): DecodedCustomId {
  const [namespace = '', action = '', ...params] = customId.split(FIELD_SEP);
  return { namespace, action, params };
}
