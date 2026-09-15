/**
 * src/lib/filters.ts의 readAttrs()는 브라우저에서 쓰라고 만든 헬퍼라 시그니처에 DOMStringMap이 있다.
 * Worker 타입체크에는 DOM lib이 없고, workers-types와 DOM lib을 같이 켜면
 * fetch/Request/Response 같은 전역이 양쪽에서 정의돼 서로를 덮어쓴다(Cloudflare가 명시적으로 말리는 조합).
 *
 * 그래서 lib을 켜는 대신 필요한 한 개만 여기에 최소 형태로 선언한다.
 * Worker 코드가 DOM API를 실제로 쓰기 시작하면 그건 잘못 짜고 있다는 신호다 — 여기에 더 추가하지 말 것.
 */
interface DOMStringMap {
  [name: string]: string | undefined;
}
