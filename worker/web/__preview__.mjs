#!/usr/bin/env node
/**
 * 임시 미리보기 하니스. D1(loadAll) 대신 data/*.json을 직접 읽어 renderPage()로 HTML을 뽑는다.
 * 다른 담당의 DB 계층이 없어도 화면을 검증하기 위한 것이며, 배포 번들에는 포함되지 않는다.
 *
 *   node worker/web/__preview__.mjs --out out.html [--today 2026-09-15T03:00:00Z] [--data ./data]
 *
 * content.config.ts의 zod 기본값(tags·documentIds·priority·reusable·ready…)은 여기서 손으로 채운다 —
 * D1에서는 repo.ts가 같은 역할을 한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './page.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const dataDir = resolve(root, opt('data', 'data'));
const out = resolve(process.cwd(), opt('out', 'preview.html'));
const today = new Date(opt('today', new Date().toISOString()));

const read = (name) => JSON.parse(readFileSync(resolve(dataDir, name), 'utf8'));

const programs = read('programs.json').map((p) => ({
  tags: [],
  source: 'manual',
  aliasTitles: [],
  ...p,
}));
const applications = read('applications.json').map((a) => ({
  priority: 'mid',
  documentIds: [],
  ...a,
}));
const documents = read('documents.json').map((d) => ({
  reusable: true,
  ready: false,
  ...d,
}));
const { _comment, ...profile } = read('team-profile.json');

const html = renderPage({ programs, applications, documents, profile, today });
writeFileSync(out, html, 'utf8');
console.log(`wrote ${out} (${html.length.toLocaleString()} chars, today=${today.toISOString()})`);
