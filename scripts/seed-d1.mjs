#!/usr/bin/env node
/**
 * data/*.json → D1 이관 스크립트.
 *
 *   node scripts/seed-d1.mjs --local     # 로컬 .wrangler/state (계정 불필요)
 *   node scripts/seed-d1.mjs --remote    # 실제 D1
 *   node scripts/seed-d1.mjs --local --dry-run   # 생성될 SQL만 출력
 *
 * 멱등하다: 전부 INSERT ... ON CONFLICT(id) DO UPDATE라 몇 번을 돌려도 행 수가 늘지 않는다.
 * data/*.json이 정본이므로 다시 돌리면 D1이 JSON 쪽으로 맞춰진다.
 *
 * ⚠️ 여기 든 공고는 실제 조사로 확인한 것들이다. 한 건이라도 조용히 빠지면 안 되므로
 * 삽입 전에 필수 필드를 검사하고, 하나라도 어긋나면 아무것도 쓰지 않고 멈춘다.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = join(ROOT, 'data');
const DB_NAME = 'grantboard';

const CATEGORIES = ['정부지원사업', '공모전', '경진대회', '교육프로그램', '기타'];
const SOURCES = ['manual', 'k-startup', 'bizinfo'];
const STATUSES = ['검토중', '준비', '작성중', '제출완료', '서류통과', '최종선정', '탈락', '미지원'];
const PRIORITIES = ['high', 'mid', 'low'];
const DOC_KINDS = ['서식', '증빙', '기타'];
const OWNER_MAX_LENGTH = 4;

// ---------------------------------------------------------------------------
// SQL 리터럴
// ---------------------------------------------------------------------------

/**
 * SQLite 문자열 리터럴. 작은따옴표만 이스케이프하면 된다(본문에 줄바꿈·이모지 있어도 안전).
 *
 * 빈 문자열은 NULL로 바꾸지 않는다. zod는 ''를 그대로 통과시키고 repo의 upsert도 ''를 그대로 쓴는데,
 * 여기서만 NULL로 바꾸면 "시드로 넣은 행"과 "봇으로 넣은 행"의 모양이 달라진다.
 * 입력을 조용히 바꾸지 않는다는 원칙이기도 하다.
 */
function sqlText(value) {
  if (value === undefined || value === null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** NULL을 허용하지 않는 컬럼용. 빈 문자열도 값으로 취급한다. */
function sqlRequiredText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  return value === undefined || value === null ? 'NULL' : String(Number(value));
}

function sqlBool(value) {
  return value ? '1' : '0';
}

/** JSON 컬럼. repo.ts가 같은 형태로 읽는다 — 배열은 항상 존재하고, 없으면 빈 배열이다. */
function sqlJsonArray(value) {
  return sqlRequiredText(JSON.stringify(Array.isArray(value) ? value : []));
}

function sqlJsonObject(value) {
  if (value === undefined || value === null) return 'NULL';
  return sqlRequiredText(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 검증 — 조용한 유실을 막는다
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkDate(errors, label, value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${label}: 필수 날짜 누락`);
    return;
  }
  if (!DATE_RE.test(value)) errors.push(`${label}: 'YYYY-MM-DD' 형식이 아님 (${value})`);
}

function checkEnum(errors, label, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${label}: 허용되지 않은 값 '${value}' (허용: ${allowed.join(', ')})`);
}

function validatePrograms(programs, errors) {
  const seen = new Set();
  for (const p of programs) {
    const label = `programs[${p.id ?? '(id 없음)'}]`;
    if (!p.id) errors.push(`${label}: id 누락`);
    if (seen.has(p.id)) errors.push(`${label}: id 중복`);
    seen.add(p.id);
    for (const field of ['title', 'organizer', 'sourceUrl']) {
      if (!p[field]) errors.push(`${label}: ${field} 누락`);
    }
    checkEnum(errors, `${label}.category`, p.category, CATEGORIES);
    checkEnum(errors, `${label}.source`, p.source ?? 'manual', SOURCES);
    checkDate(errors, `${label}.applyEnd`, p.applyEnd, { required: true });
    checkDate(errors, `${label}.applyStart`, p.applyStart);
    checkDate(errors, `${label}.announceDate`, p.announceDate);
    if (p.applyEndTime !== undefined && !TIME_RE.test(p.applyEndTime)) {
      errors.push(`${label}.applyEndTime: 'HH:MM' 형식이 아님 (${p.applyEndTime})`);
    }
  }
}

function validateApplications(applications, programs, errors) {
  const programIds = new Set(programs.map((p) => p.id));
  const seen = new Set();
  for (const a of applications) {
    const label = `applications[${a.id ?? '(id 없음)'}]`;
    if (!a.id) errors.push(`${label}: id 누락`);
    if (seen.has(a.id)) errors.push(`${label}: id 중복`);
    seen.add(a.id);
    if (!programIds.has(a.programId)) errors.push(`${label}: programId '${a.programId}'에 해당하는 공고 없음`);
    checkEnum(errors, `${label}.status`, a.status, STATUSES);
    checkEnum(errors, `${label}.priority`, a.priority ?? 'mid', PRIORITIES);
    if (!a.owner) errors.push(`${label}: owner 누락`);
    // public 레포다. 4자를 넘으면 실명일 가능성이 높다 — 스키마와 같은 선에서 막는다.
    else if ([...a.owner].length > OWNER_MAX_LENGTH) {
      errors.push(`${label}.owner: ${OWNER_MAX_LENGTH}자를 초과 (실명 금지, 이니셜/닉네임만)`);
    }
    checkDate(errors, `${label}.targetSubmitDate`, a.targetSubmitDate);
    checkDate(errors, `${label}.submittedAt`, a.submittedAt);
    checkDate(errors, `${label}.resultAt`, a.resultAt);
  }
}

function validateDocuments(documents, errors) {
  const seen = new Set();
  for (const d of documents) {
    const label = `documents[${d.id ?? '(id 없음)'}]`;
    if (!d.id) errors.push(`${label}: id 누락`);
    if (seen.has(d.id)) errors.push(`${label}: id 중복`);
    seen.add(d.id);
    if (!d.name) errors.push(`${label}: name 누락`);
    checkEnum(errors, `${label}.kind`, d.kind, DOC_KINDS);
    checkDate(errors, `${label}.issuedAt`, d.issuedAt);
    checkDate(errors, `${label}.validUntil`, d.validUntil);
  }
}

function validateProfile(profile, errors) {
  if (typeof profile.hasBusinessRegistration !== 'boolean') {
    errors.push('team-profile: hasBusinessRegistration는 boolean이어야 함');
  }
  if (!profile.region) errors.push('team-profile: region 누락');
  checkDate(errors, 'team-profile.businessRegisteredAt', profile.businessRegisteredAt);
  checkDate(errors, 'team-profile.incorporatedAt', profile.incorporatedAt);
}

// ---------------------------------------------------------------------------
// SQL 생성
// ---------------------------------------------------------------------------

function programStatement(p) {
  return `INSERT INTO programs (id, title, organizer, source_url, category, apply_start, apply_end, apply_end_time, announce_date, support_amount, source, collected_at, eligibility, tags, alias_titles) VALUES (${[
    sqlRequiredText(p.id),
    sqlRequiredText(p.title),
    sqlRequiredText(p.organizer),
    sqlRequiredText(p.sourceUrl),
    sqlRequiredText(p.category),
    sqlText(p.applyStart),
    sqlRequiredText(p.applyEnd),
    sqlText(p.applyEndTime),
    sqlText(p.announceDate),
    sqlText(p.supportAmount),
    sqlRequiredText(p.source ?? 'manual'),
    sqlText(p.collectedAt),
    sqlJsonObject(p.eligibility),
    sqlJsonArray(p.tags),
    sqlJsonArray(p.aliasTitles),
  ].join(', ')}) ON CONFLICT(id) DO UPDATE SET title=excluded.title, organizer=excluded.organizer, source_url=excluded.source_url, category=excluded.category, apply_start=excluded.apply_start, apply_end=excluded.apply_end, apply_end_time=excluded.apply_end_time, announce_date=excluded.announce_date, support_amount=excluded.support_amount, source=excluded.source, collected_at=excluded.collected_at, eligibility=excluded.eligibility, tags=excluded.tags, alias_titles=excluded.alias_titles;`;
}

function applicationStatement(a) {
  return `INSERT INTO applications (id, program_id, status, owner, priority, target_submit_date, submitted_at, result_at, note, document_ids) VALUES (${[
    sqlRequiredText(a.id),
    sqlRequiredText(a.programId),
    sqlRequiredText(a.status),
    sqlRequiredText(a.owner),
    sqlRequiredText(a.priority ?? 'mid'),
    sqlText(a.targetSubmitDate),
    sqlText(a.submittedAt),
    sqlText(a.resultAt),
    sqlText(a.note),
    sqlJsonArray(a.documentIds),
  ].join(', ')}) ON CONFLICT(id) DO UPDATE SET program_id=excluded.program_id, status=excluded.status, owner=excluded.owner, priority=excluded.priority, target_submit_date=excluded.target_submit_date, submitted_at=excluded.submitted_at, result_at=excluded.result_at, note=excluded.note, document_ids=excluded.document_ids;`;
}

function documentStatement(d) {
  return `INSERT INTO documents (id, name, kind, reusable, issued_at, validity_days, valid_until, ready, reuse_source) VALUES (${[
    sqlRequiredText(d.id),
    sqlRequiredText(d.name),
    sqlRequiredText(d.kind),
    sqlBool(d.reusable ?? true),
    sqlText(d.issuedAt),
    sqlNumber(d.validityDays),
    sqlText(d.validUntil),
    sqlBool(d.ready ?? false),
    sqlText(d.reuseSource),
  ].join(', ')}) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, reusable=excluded.reusable, issued_at=excluded.issued_at, validity_days=excluded.validity_days, valid_until=excluded.valid_until, ready=excluded.ready, reuse_source=excluded.reuse_source;`;
}

function profileStatement(profile) {
  return `INSERT INTO team_profile (id, has_business_registration, business_registered_at, incorporated_at, founder_birth_year, region) VALUES (1, ${[
    sqlBool(profile.hasBusinessRegistration),
    sqlText(profile.businessRegisteredAt),
    sqlText(profile.incorporatedAt),
    sqlNumber(profile.founderBirthYear),
    sqlRequiredText(profile.region),
  ].join(', ')}) ON CONFLICT(id) DO UPDATE SET has_business_registration=excluded.has_business_registration, business_registered_at=excluded.business_registered_at, incorporated_at=excluded.incorporated_at, founder_birth_year=excluded.founder_birth_year, region=excluded.region;`;
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function readJson(name) {
  return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const remote = args.includes('--remote');
  const local = args.includes('--local');

  if (!remote && !local && !dryRun) {
    console.error('대상을 지정하세요: --local 또는 --remote (--dry-run은 SQL만 출력)');
    process.exit(1);
  }

  const programs = readJson('programs.json');
  const applications = readJson('applications.json');
  const documents = readJson('documents.json');
  const profile = readJson('team-profile.json');

  const errors = [];
  validatePrograms(programs, errors);
  validateApplications(applications, programs, errors);
  validateDocuments(documents, errors);
  validateProfile(profile, errors);

  if (errors.length > 0) {
    console.error(`데이터 검증 실패 (${errors.length}건). 아무것도 쓰지 않고 중단합니다:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // 외래키 순서: programs → applications. documents/team_profile은 독립이다.
  const statements = [
    '-- scripts/seed-d1.mjs가 data/*.json에서 생성. 직접 고치지 말 것.',
    'PRAGMA foreign_keys = ON;',
    ...programs.map(programStatement),
    ...documents.map(documentStatement),
    ...applications.map(applicationStatement),
    profileStatement(profile),
  ];
  const sql = `${statements.join('\n')}\n`;

  console.log(
    `시드 대상: programs ${programs.length}건, documents ${documents.length}건, ` +
      `applications ${applications.length}건, team_profile 1건`,
  );

  if (dryRun) {
    console.log('--- dry-run: 아래 SQL을 실행할 예정 ---');
    console.log(sql);
    return;
  }

  // wrangler는 --command로 긴 다중 문장을 받으면 셸 인용 규칙(특히 Windows)에 걸린다.
  // 파일로 넘기면 인코딩·따옴표 문제가 사라진다.
  const tempDir = mkdtempSync(join(tmpdir(), 'grantboard-seed-'));
  const sqlPath = join(tempDir, 'seed.sql');
  writeFileSync(sqlPath, sql, 'utf8');

  const target = remote ? '--remote' : '--local';
  // wrangler CLI를 node로 직접 실행한다.
  //  - `npx`/`npx.cmd`는 Windows에서 막힌다: Node 20+는 shell 없이 .cmd 실행을 거부하고(EINVAL),
  //    shell: true로 풀면 인자가 이스케이프되지 않아 경로에 공백이 있을 때 깨진다(DEP0190).
  //  - .js를 process.execPath로 부르면 양쪽 문제가 동시에 없어진다.
  const wranglerBin = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(wranglerBin)) {
    console.error(`wrangler를 찾지 못했습니다 (${wranglerBin}). 먼저 \`npm install\`을 돌리세요.`);
    process.exit(1);
  }

  const wranglerArgs = ['d1', 'execute', DB_NAME, target, `--file=${sqlPath}`, '--yes'];

  try {
    const result = spawnSync(process.execPath, [wranglerBin, ...wranglerArgs], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      // 실패했을 때만 전문을 보여준다 — 성공 시 wrangler는 문장당 결과 JSON을 전부 찍어낸다.
      console.error(result.stdout ?? '');
      console.error(result.stderr ?? '');
      console.error(`wrangler가 실패했습니다 (exit ${result.status}).`);
      process.exit(result.status ?? 1);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`시드 완료 (${target}). 같은 명령을 다시 돌려도 행 수는 늘지 않습니다.`);
}

main();
