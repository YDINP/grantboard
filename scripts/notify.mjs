#!/usr/bin/env node
/**
 * data/*.json으로부터 D-day 다이제스트를 조립해(src/lib/digest.ts) Slack/Discord 웹훅으로 보낸다.
 * 메시지 조립은 순수 함수(src/lib/digest.ts)에 맡기고, 네트워크 호출은 이 파일에서만 한다 —
 * scripts/collect.mjs와 같은 구조다.
 *
 * 사용법:
 *   node scripts/notify.mjs --dry-run   # 전송하지 않고 조립된 메시지를 stdout에 출력
 *   node scripts/notify.mjs             # SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL 로 실제 전송
 *
 * Slack과 Discord는 각각 다른 환경변수로 받는다. URL 형태를 파싱해 자동판별하는 대신 환경변수
 * 이름 자체로 종류를 알 수 있게 했다 — 어느 쪽이든 설정된 것만 보내면 되고, 파싱할 게 없어
 * 실패할 여지도 없다. 최소 하나는 설정되어야 하며, 없으면(단 --dry-run이 아니면) 에러로 종료한다.
 *
 * ⚠️ 웹훅 URL은 절대 로그에 그대로 찍지 않는다. 실패 응답 본문에 URL이 그대로 에코되는 경우를
 * 대비해 로그로 내보내기 전에 항상 scrubUrl로 치환한다(공공데이터 API 키를 다루는
 * scripts/collect.mjs의 scrubServiceKey와 같은 이유).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDigest } from '../src/lib/digest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const MAX_RETRIES = 3;
const DISCORD_CONTENT_LIMIT = 2000;

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function backoffMs(attempt) {
  return 2 ** attempt * 500; // 1s, 2s, 4s
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 로그에 웹훅 URL이 그대로 남지 않도록, 주어진 text에서 실제 URL 문자열을 마스킹한다. */
function scrubUrl(text, url) {
  return url ? text.split(url).join('***') : text;
}

async function readJson(fileName) {
  const raw = await readFile(path.join(DATA_DIR, fileName), 'utf-8');
  return JSON.parse(raw);
}

/** Slack은 { text }, Discord는 { content }를 받는다. Discord는 2000자 제한이 있어 넘으면 잘라 보낸다. */
function buildPayload(kind, message) {
  if (kind === 'discord') {
    const content =
      message.length > DISCORD_CONTENT_LIMIT
        ? `${message.slice(0, DISCORD_CONTENT_LIMIT - 24)}\n…(길이 제한으로 생략됨)`
        : message;
    return { content };
  }
  return { text: message };
}

/** 실패 시 지수 백오프로 최대 MAX_RETRIES회 재시도한다. 최종 실패하면 예외를 던진다(워크플로 실패용). */
async function sendWithRetry(target, message) {
  const payload = buildPayload(target.kind, message);
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) return;

      const bodyText = scrubUrl(await res.text(), target.url);
      lastError = new Error(`HTTP ${res.status} — ${bodyText.slice(0, 200)}`);
    } catch (err) {
      lastError = new Error(scrubUrl(err.message, target.url));
    }

    if (attempt < MAX_RETRIES) {
      console.warn(`[notify] ${target.kind} 전송 실패(시도 ${attempt}/${MAX_RETRIES}) — ${backoffMs(attempt)}ms 후 재시도합니다: ${lastError.message}`);
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError ?? new Error('알 수 없는 이유로 전송에 실패했습니다.');
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const [programs, applications, documents, profile] = await Promise.all([
    readJson('programs.json'),
    readJson('applications.json'),
    readJson('documents.json'),
    readJson('team-profile.json'),
  ]);

  const message = buildDigest(programs, applications, documents, profile, new Date());

  if (message === null) {
    console.log('[notify] 오늘 보낼 다이제스트가 없습니다(급한 항목 없음) — 전송하지 않습니다.');
    return;
  }

  if (dryRun) {
    console.log('[notify] --dry-run 모드: 아래 메시지는 전송하지 않았습니다.\n');
    console.log(message);
    return;
  }

  const targets = [];
  if (process.env.SLACK_WEBHOOK_URL) targets.push({ kind: 'slack', url: process.env.SLACK_WEBHOOK_URL });
  if (process.env.DISCORD_WEBHOOK_URL) targets.push({ kind: 'discord', url: process.env.DISCORD_WEBHOOK_URL });

  if (targets.length === 0) {
    console.error('[notify] 오류: SLACK_WEBHOOK_URL 또는 DISCORD_WEBHOOK_URL 중 최소 하나는 설정되어야 합니다.');
    console.error('  README.md "알림" 절을 참고해 웹훅을 만들고 gh secret set으로 등록하세요.');
    process.exitCode = 1;
    return;
  }

  let hadFailure = false;
  for (const target of targets) {
    try {
      await sendWithRetry(target, message);
      console.log(`[notify] ${target.kind} 전송 완료.`);
    } catch (err) {
      hadFailure = true;
      console.error(`[notify] ${target.kind} 전송이 ${MAX_RETRIES}회 재시도 후에도 실패했습니다: ${err.message}`);
    }
  }

  if (hadFailure) {
    // 알림이 조용히 안 가는 게 제일 나쁘다 — 워크플로를 실패시켜 사람이 보게 한다.
    process.exitCode = 1;
  }
}

main();
