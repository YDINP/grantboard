/**
 * base('/grantboard')가 빠지면 GitHub Pages에서 404가 난다.
 * 내부 링크·정적 자산 경로는 반드시 이 헬퍼를 통해서만 생성할 것.
 */

/** import.meta.env.BASE_URL은 항상 끝에 슬래시가 붙은 형태('/grantboard/')로 온다. */
const BASE_URL = import.meta.env.BASE_URL;

/**
 * 사이트 내부 경로를 base가 적용된 절대 경로로 변환한다.
 * @param path 예: '/', '/programs/foo', 'programs/foo' (선행 슬래시 유무 무관)
 */
export function withBase(path: string): string {
  const trimmedBase = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const combined = `${trimmedBase}${normalizedPath}`;
  // 루트('') 요청 시 최소 '/'는 보장한다.
  return combined === '' ? '/' : combined;
}
