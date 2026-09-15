/**
 * Worker 엔트리. 라우팅과 cron 분기만 한다 — 실제 처리는 전부 아래 모듈로 넘긴다.
 *
 *   POST /interactions   → 디스코드 상호작용 (worker/discord/)
 *   GET  /, /calendar*   → 달력 페이지 (worker/web/)
 *   cron                 → 수집 / 다이제스트
 */

import type { Env } from './env.d.ts';
import { handleInteraction } from './discord/interactions.ts';
import { handleWeb } from './web/handler.ts';
import { runCollect } from './cron/collect.ts';
import { sendDigest } from './cron/digest.ts';

/** wrangler.toml [triggers].crons와 문자열이 정확히 일치해야 한다. 오타가 나면 조용히 아무것도 안 돈다. */
const CRON_COLLECT = '0 23 * * *'; // KST 08:00
const CRON_DIGEST = '30 23 * * *'; // KST 08:30

function isCalendarPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/calendar' || pathname.startsWith('/calendar/');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 디스코드는 상호작용을 POST로만 보낸다. 서명 검증은 handleInteraction 안에서 한다.
    if (url.pathname === '/interactions') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      return handleInteraction(request, env, ctx);
    }

    if (isCalendarPath(url.pathname)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      return handleWeb(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // cron은 UTC 기준으로 깨어난다. 어느 트리거였는지는 로그에 반드시 남긴다 —
    // 안 남기면 "새벽에 안 돌았다"를 나중에 확인할 방법이 없다.
    // 한 크론이 실패해도 다음 크론(과 다음 요청)이 죽으면 안 된다 — runCollect/sendDigest는
    // 스스로도 예상되는 실패(키 없음, 전송 실패)는 삼키지만, 예상 못 한 예외까지 대비해
    // 여기서도 한 번 더 잡는다. 오래 걸리는 작업은 ctx.waitUntil로 감싼다.
    switch (event.cron) {
      case CRON_COLLECT:
        console.log(`[cron] ${event.cron} (KST 08:00) — K-Startup/기업마당 수집`);
        ctx.waitUntil(
          runCollect(env).catch((err) => {
            console.error(`[cron:collect] 예기치 못한 예외로 중단됨: ${err instanceof Error ? err.message : String(err)}`);
          }),
        );
        break;

      case CRON_DIGEST:
        console.log(`[cron] ${event.cron} (KST 08:30) — D-day 다이제스트`);
        ctx.waitUntil(
          sendDigest(env, { dryRun: env.CRON_DRY_RUN === 'true' }).catch((err) => {
            console.error(`[cron:digest] 예기치 못한 예외로 중단됨: ${err instanceof Error ? err.message : String(err)}`);
          }),
        );
        break;

      default:
        console.warn(`[cron] 등록되지 않은 표현식: ${event.cron} — 아무것도 실행하지 않음`);
    }
  },
};
