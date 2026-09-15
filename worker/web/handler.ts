/**
 * Worker가 서빙하는 달력 웹페이지 핸들러.
 * 디스코드 `/달력` 명령이 띄우는 링크 버튼이 이 페이지를 연다. 봇과 같은 Worker에서 D1을 읽어
 * 요청 시점에 렌더하므로 D-day가 항상 정확하다 — 정적 사이트 시절의 "빌드 시각 고정 + 하루 두 번 재빌드"는 없다.
 *
 * 라우팅: GET|HEAD  /  또는  /calendar(/)  → HTML. 그 외 경로는 404, 그 외 메서드는 405.
 * 캐시: no-store. 자정(KST)에 D-day가 바뀌고 디스코드에서 언제든 데이터가 바뀐다 — 하루 지난 D-day를
 * 보여주면 이 도구의 존재 이유가 무너지므로 브라우저·CDN 어디에도 남기지 않는다. 페이지는 한 요청짜리라 부담이 없다.
 */

import type { Env } from '../env.d.ts';
import { loadAll } from '../db/repo.ts';
import { renderPage } from './page.ts';
import { STYLES } from './styles.ts';

const PAGE_PATHS = new Set(['/', '/calendar', '/calendar/']);

const HTML_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

export async function handleWeb(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!PAGE_PATHS.has(url.pathname)) {
    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }

  const body = (html: string) => (request.method === 'HEAD' ? null : html);

  let html: string;
  try {
    const { programs, applications, documents, profile } = await loadAll(env.DB);
    html = renderPage({ programs, applications, documents, profile, today: new Date() });
  } catch (error) {
    // 스택·쿼리 내용은 로그로만. 화면에는 사용자가 할 수 있는 행동만 적는다.
    console.error('calendar page render failed', error);
    return new Response(body(renderErrorPage()), { status: 500, headers: HTML_HEADERS });
  }

  return new Response(body(html), { status: 200, headers: HTML_HEADERS });
}

function renderErrorPage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="robots" content="noindex" /><title>GrantBoard — 오류</title><style>${STYLES}</style></head><body><div class="error-box"><h1>달력을 불러오지 못했습니다</h1><p>잠시 후 새로고침해 주세요. 계속 실패하면 디스코드에서 봇이 살아 있는지 확인해 주세요.</p></div></body></html>`;
}
