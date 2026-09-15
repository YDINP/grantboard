/**
 * Worker 런타임 바인딩. wrangler.toml의 바인딩 + Cloudflare 시크릿과 1:1로 대응한다.
 *
 * ⚠️ 시크릿은 전부 `wrangler secret put`(원격) / `.dev.vars`(로컬)로 주입한다.
 * wrangler.toml의 [vars]에 쓰면 평문으로 커밋된다 — 이 레포는 public이다.
 *
 * 두 가지 방식으로 참조할 수 있다(둘 다 같은 타입이다):
 *   import type { Env } from '../env.d.ts';   // 명시적
 *   function f(env: Env) {}                   // 전역. `wrangler types`가 만드는 것과 같은 모양
 */
interface WorkerEnv {
  /** D1 바인딩. 접근은 worker/db/repo.ts를 통해서만 한다. */
  DB: D1Database;

  /** 디스코드 앱 ID. 슬래시 명령 등록에 쓴다. */
  DISCORD_APPLICATION_ID: string;
  /** Ed25519 공개키. /interactions 서명 검증용 — 검증 없이 처리하면 누구나 명령을 위조할 수 있다. */
  DISCORD_PUBLIC_KEY: string;
  /** 봇 토큰. 다이제스트 등 Worker가 먼저 말을 거는 경우에 쓴다. */
  DISCORD_BOT_TOKEN: string;
  /** 슬래시 명령을 등록할 길드 ID. */
  DISCORD_GUILD_ID: string;
  /** 다이제스트를 보낼 채널 ID. */
  DISCORD_CHANNEL_ID: string;

  /** K-Startup(공공데이터포털) API 키. 없으면 해당 수집기는 건너뛴다. */
  DATA_GO_KR_KEY?: string;
  /** 기업마당(bizinfo) 인증키. 없으면 해당 수집기는 건너뛴다. */
  BIZINFO_CRTFC_KEY?: string;

  /**
   * 로컬 테스트 전용 스위치. 'true'면 CRON_DIGEST가 다이제스트를 조립만 하고 실제 디스코드
   * 전송은 하지 않는다(`wrangler dev --test-scheduled`로 크론을 트리거해도 실채널에 글이 가지
   * 않는다). `.dev.vars`에서만 켤 것 — `wrangler secret put`이나 wrangler.toml [vars]에는
   * 절대 넣지 않는다(프로덕션에서 계속 dry-run으로 남는 사고를 막기 위함).
   */
  CRON_DRY_RUN?: string;
}

export type Env = WorkerEnv;

declare global {
  interface Env extends WorkerEnv {}
}
