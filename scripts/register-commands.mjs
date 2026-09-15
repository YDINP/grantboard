#!/usr/bin/env node
/**
 * worker/discord/commands.ts의 COMMAND_DEFINITIONS를 디스코드 길드 커맨드로 등록한다.
 * 길드 커맨드는 등록 즉시 반영된다(글로벌 커맨드는 최대 1시간 걸리므로 이 프로젝트는 길드로 등록한다).
 *
 * 사용법:
 *   DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
 *   node scripts/register-commands.mjs --dry-run   # 전송하지 않고 등록될 커맨드 이름만 출력
 *
 * ⚠️ 봇 토큰은 절대 로그에 찍지 않는다. 실패 응답 본문을 로그로 남길 때도 토큰은 요청 헤더에만
 * 있고 본문에는 나타나지 않지만, 혹시 모를 에코를 대비해 마스킹 없이 원문을 그대로 찍지 않는다
 * (상태 코드와 디스코드 에러 메시지 필드만 남긴다).
 */

import { COMMAND_DEFINITIONS } from '../worker/discord/commands.ts';

const MAX_RETRIES = 3;

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function backoffMs(attempt) {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  }
  return value;
}

async function registerCommands({ applicationId, guildId, botToken }) {
  const url = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));

    let res;
    try {
      res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${botToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(COMMAND_DEFINITIONS),
      });
    } catch (err) {
      lastError = err;
      console.error(`커맨드 등록 요청 실패 (시도 ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
      continue;
    }

    if (res.ok) {
      const body = await res.json();
      return body;
    }

    // 토큰은 담기지 않는 응답 본문이지만, 그대로 로그에 쏟지 않고 요약만 남긴다.
    const text = await res.text().catch(() => '');
    let summary = text;
    try {
      const parsed = JSON.parse(text);
      summary = parsed.message ?? text;
    } catch {
      // JSON이 아니면 원문 그대로 요약 사용.
    }
    lastError = new Error(`디스코드 API 응답 실패: status=${res.status} message=${summary}`);

    // 401/403은 토큰/권한 문제라 재시도해도 소용없다.
    if (res.status === 401 || res.status === 403) break;
    console.error(`커맨드 등록 실패 (시도 ${attempt + 1}/${MAX_RETRIES}): status=${res.status}`);
  }

  throw lastError ?? new Error('알 수 없는 이유로 커맨드 등록에 실패했습니다.');
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const names = COMMAND_DEFINITIONS.map((c) => `/${c.name}`).join(', ');

  if (dryRun) {
    console.log(`[dry-run] 등록될 커맨드(${COMMAND_DEFINITIONS.length}개): ${names}`);
    console.log(JSON.stringify(COMMAND_DEFINITIONS, null, 2));
    return;
  }

  const applicationId = requireEnv('DISCORD_APPLICATION_ID');
  const guildId = requireEnv('DISCORD_GUILD_ID');
  const botToken = requireEnv('DISCORD_BOT_TOKEN');

  console.log(`길드(${guildId})에 커맨드 ${COMMAND_DEFINITIONS.length}개 등록 중: ${names}`);
  const result = await registerCommands({ applicationId, guildId, botToken });
  console.log(`등록 완료: ${result.length}개 커맨드가 반영되었습니다.`);
}

main().catch((err) => {
  console.error(`커맨드 등록 실패: ${err.message}`);
  process.exitCode = 1;
});
