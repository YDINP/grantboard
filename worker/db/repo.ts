/**
 * D1 데이터 접근 계층. **SQL은 이 파일 밖으로 새지 않는다.**
 *
 * 계약:
 *  - JSON 컬럼(eligibility/tags/aliasTitles/documentIds)은 여기서 파싱·직렬화한다.
 *    호출자는 순수 객체/배열만 본다 — 문자열을 JSON.parse 하는 코드를 다른 곳에 두지 말 것.
 *  - DB의 NULL은 `undefined`로 바꿔서 넘긴다. src/lib은 zod의 .optional() 형태를 전제한다.
 *  - 날짜는 TEXT 그대로 읽고 쓴다. 판정은 전부 src/lib/schedule.ts(KST 기준)가 한다.
 *
 * 깨진 JSON을 만나면 조용히 넘어가지 않는다: 안전한 기본값으로 계속 진행하되
 * console.error로 남기고 getDataIntegrityIssues()에 기록해 화면/봇이 드러낼 수 있게 한다.
 */

import type {
  Application,
  BoardData,
  Document,
  OwnerMapping,
  Program,
  ProgramEligibility,
  TeamProfile,
} from './types.ts';

// ---------------------------------------------------------------------------
// 데이터 무결성 기록
// ---------------------------------------------------------------------------

export interface DataIntegrityIssue {
  table: string;
  rowId: string;
  column: string;
  message: string;
  /** 문제가 된 원본 값의 앞부분. 전문을 담으면 로그가 터지므로 잘라서 보관한다. */
  sample: string;
}

/**
 * 링버퍼. Worker 아이솔레이트는 요청 사이에 살아남기 때문에 무한히 쌓으면 메모리가 샌다.
 * 오래된 것부터 덮어쓰고 상한을 고정한다.
 */
const MAX_TRACKED_ISSUES = 50;
const SAMPLE_LENGTH = 120;
const issueRing: (DataIntegrityIssue | undefined)[] = new Array(MAX_TRACKED_ISSUES);
let issueWriteIndex = 0;
let issueTotal = 0;

function recordIssue(issue: DataIntegrityIssue): void {
  console.error(
    `[repo] MALFORMED DATA ${issue.table}.${issue.column} (id=${issue.rowId}): ${issue.message} | ${issue.sample}`,
  );
  issueRing[issueWriteIndex] = issue;
  issueWriteIndex = (issueWriteIndex + 1) % MAX_TRACKED_ISSUES;
  issueTotal += 1;
}

/** 이번 아이솔레이트가 만난 깨진 행 목록(오래된 순). 상한을 넘으면 최근 것만 남는다. */
export function getDataIntegrityIssues(): DataIntegrityIssue[] {
  const kept = Math.min(issueTotal, MAX_TRACKED_ISSUES);
  const start = (issueWriteIndex - kept + MAX_TRACKED_ISSUES) % MAX_TRACKED_ISSUES;
  const out: DataIntegrityIssue[] = [];
  for (let i = 0; i < kept; i += 1) {
    const entry = issueRing[(start + i) % MAX_TRACKED_ISSUES];
    if (entry) out.push(entry);
  }
  return out;
}

/** 누락분을 포함한 누적 발생 건수. 링버퍼 길이보다 크면 그만큼 잘려 나갔다는 뜻이다. */
export function getDataIntegrityIssueCount(): number {
  return issueTotal;
}

export function clearDataIntegrityIssues(): void {
  issueRing.fill(undefined);
  issueWriteIndex = 0;
  issueTotal = 0;
}

// ---------------------------------------------------------------------------
// 행 ↔ 도메인 객체 변환
// ---------------------------------------------------------------------------

/** D1은 NULL을 null로 준다. 도메인 타입은 undefined를 쓴다. */
function opt<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/**
 * 값이 undefined인 키를 지운다.
 * zod의 .optional()은 값이 없을 때 키 자체를 만들지 않는다. repo 출력도 같은 모양이어야
 * `Object.keys`·`in`·전개 결과가 Astro 쪽과 어긋나지 않는다. (worker/db/types.test.ts가 감시한다)
 */
function compact<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}

function sampleOf(raw: unknown): string {
  return String(raw).slice(0, SAMPLE_LENGTH);
}

function parseJsonColumn<T>(
  raw: unknown,
  fallback: T,
  guard: (value: unknown) => value is T,
  ctx: { table: string; rowId: string; column: string },
): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    recordIssue({
      ...ctx,
      message: `JSON 파싱 실패 (${error instanceof Error ? error.message : String(error)}) — 기본값으로 대체`,
      sample: sampleOf(raw),
    });
    return fallback;
  }
  if (!guard(parsed)) {
    recordIssue({ ...ctx, message: '예상과 다른 JSON 형태 — 기본값으로 대체', sample: sampleOf(raw) });
    return fallback;
  }
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPlainObject(value: unknown): value is ProgramEligibility {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SQLite에는 boolean이 없다. 0/1로 저장하고 여기서만 환원한다. */
function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

function jsonArray(value: readonly string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

/** 행 객체에서 컬럼 순서대로 값을 뽑는다. bind 인자 순서를 손으로 유지하지 않기 위한 것. */
function bindValues<R>(row: R, columns: readonly (keyof R)[]): unknown[] {
  return columns.map((column) => row[column]);
}

export interface ProgramRow {
  id: string;
  title: string;
  organizer: string;
  source_url: string;
  category: string;
  apply_start: string | null;
  apply_end: string;
  apply_end_time: string | null;
  announce_date: string | null;
  support_amount: string | null;
  source: string;
  collected_at: string | null;
  eligibility: string | null;
  tags: string | null;
  alias_titles: string | null;
}

export function toProgram(row: ProgramRow): Program {
  const ctx = { table: 'programs', rowId: row.id };
  const eligibility = row.eligibility
    ? parseJsonColumn<ProgramEligibility>(row.eligibility, {}, isPlainObject, { ...ctx, column: 'eligibility' })
    : undefined;

  return compact({
    id: row.id,
    title: row.title,
    organizer: row.organizer,
    sourceUrl: row.source_url,
    category: row.category as Program['category'],
    applyStart: opt(row.apply_start),
    applyEnd: row.apply_end,
    applyEndTime: opt(row.apply_end_time),
    announceDate: opt(row.announce_date),
    supportAmount: opt(row.support_amount),
    tags: parseJsonColumn<string[]>(row.tags, [], isStringArray, { ...ctx, column: 'tags' }),
    source: row.source as Program['source'],
    collectedAt: opt(row.collected_at),
    aliasTitles: parseJsonColumn<string[]>(row.alias_titles, [], isStringArray, { ...ctx, column: 'alias_titles' }),
    eligibility,
  });
}

export interface ApplicationRow {
  id: string;
  program_id: string;
  status: string;
  owner: string;
  priority: string;
  target_submit_date: string | null;
  submitted_at: string | null;
  result_at: string | null;
  note: string | null;
  document_ids: string | null;
}

export function toApplication(row: ApplicationRow): Application {
  return compact({
    id: row.id,
    programId: row.program_id,
    status: row.status as Application['status'],
    owner: row.owner,
    priority: row.priority as Application['priority'],
    targetSubmitDate: opt(row.target_submit_date),
    submittedAt: opt(row.submitted_at),
    resultAt: opt(row.result_at),
    documentIds: parseJsonColumn<string[]>(row.document_ids, [], isStringArray, {
      table: 'applications',
      rowId: row.id,
      column: 'document_ids',
    }),
    note: opt(row.note),
  });
}

export interface DocumentRow {
  id: string;
  name: string;
  kind: string;
  reusable: number;
  issued_at: string | null;
  validity_days: number | null;
  valid_until: string | null;
  ready: number;
  reuse_source: string | null;
}

export function toDocument(row: DocumentRow): Document {
  return compact({
    id: row.id,
    name: row.name,
    kind: row.kind as Document['kind'],
    reusable: toBool(row.reusable),
    issuedAt: opt(row.issued_at),
    validityDays: opt(row.validity_days),
    validUntil: opt(row.valid_until),
    reuseSource: opt(row.reuse_source),
    ready: toBool(row.ready),
  });
}

export interface TeamProfileRow {
  id: number;
  has_business_registration: number;
  business_registered_at: string | null;
  incorporated_at: string | null;
  founder_birth_year: number | null;
  region: string;
}

export function toTeamProfile(row: TeamProfileRow): TeamProfile {
  return compact({
    hasBusinessRegistration: toBool(row.has_business_registration),
    businessRegisteredAt: opt(row.business_registered_at),
    incorporatedAt: opt(row.incorporated_at),
    founderBirthYear: opt(row.founder_birth_year),
    region: row.region as TeamProfile['region'],
  });
}

// ---------------------------------------------------------------------------
// 도메인 객체 → 행 (직렬화)
// ---------------------------------------------------------------------------

// 컬럼 순서는 아래 INSERT문의 ?1..?N 순서와 같아야 한다. 손으로 두 벌을 맞추면 언젠가 어긋나므로
// 이 배열 하나를 정본으로 두고 bind는 여기서 파생시킨다.

export const PROGRAM_COLUMNS = [
  'id', 'title', 'organizer', 'source_url', 'category', 'apply_start', 'apply_end',
  'apply_end_time', 'announce_date', 'support_amount', 'source', 'collected_at',
  'eligibility', 'tags', 'alias_titles',
] as const;

export function programToRow(p: Program): ProgramRow {
  return {
    id: p.id,
    title: p.title,
    organizer: p.organizer,
    source_url: p.sourceUrl,
    category: p.category,
    apply_start: p.applyStart ?? null,
    apply_end: p.applyEnd,
    apply_end_time: p.applyEndTime ?? null,
    announce_date: p.announceDate ?? null,
    support_amount: p.supportAmount ?? null,
    source: p.source,
    collected_at: p.collectedAt ?? null,
    eligibility: p.eligibility ? JSON.stringify(p.eligibility) : null,
    tags: jsonArray(p.tags),
    alias_titles: jsonArray(p.aliasTitles),
  };
}

export const APPLICATION_COLUMNS = [
  'id', 'program_id', 'status', 'owner', 'priority', 'target_submit_date',
  'submitted_at', 'result_at', 'note', 'document_ids',
] as const;

export function applicationToRow(a: Application): ApplicationRow {
  return {
    id: a.id,
    program_id: a.programId,
    status: a.status,
    owner: a.owner,
    priority: a.priority,
    target_submit_date: a.targetSubmitDate ?? null,
    submitted_at: a.submittedAt ?? null,
    result_at: a.resultAt ?? null,
    note: a.note ?? null,
    document_ids: jsonArray(a.documentIds),
  };
}

export const DOCUMENT_COLUMNS = [
  'id', 'name', 'kind', 'reusable', 'issued_at', 'validity_days', 'valid_until',
  'ready', 'reuse_source',
] as const;

export function documentToRow(d: Document): DocumentRow {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    reusable: fromBool(d.reusable),
    issued_at: d.issuedAt ?? null,
    validity_days: d.validityDays ?? null,
    valid_until: d.validUntil ?? null,
    ready: fromBool(d.ready),
    reuse_source: d.reuseSource ?? null,
  };
}

// id는 항상 1이라 바인딩하지 않는다(INSERT문에 상수로 박혀 있다).
export const TEAM_PROFILE_COLUMNS = [
  'has_business_registration', 'business_registered_at', 'incorporated_at',
  'founder_birth_year', 'region',
] as const;

export function teamProfileToRow(profile: TeamProfile): TeamProfileRow {
  return {
    id: 1,
    has_business_registration: fromBool(profile.hasBusinessRegistration),
    business_registered_at: profile.businessRegisteredAt ?? null,
    incorporated_at: profile.incorporatedAt ?? null,
    founder_birth_year: profile.founderBirthYear ?? null,
    region: profile.region,
  };
}

// ---------------------------------------------------------------------------
// 쿼리
// ---------------------------------------------------------------------------

// 마감일 오름차순이 기본 정렬이다(달력/타임라인이 그대로 쓴다). 같은 날은 id로 고정해
// 페이지를 다시 그려도 순서가 흔들리지 않게 한다.
const SELECT_PROGRAMS = `
  SELECT id, title, organizer, source_url, category, apply_start, apply_end, apply_end_time,
         announce_date, support_amount, source, collected_at, eligibility, tags, alias_titles
    FROM programs
   ORDER BY apply_end ASC, id ASC`;

const SELECT_APPLICATIONS = `
  SELECT id, program_id, status, owner, priority, target_submit_date, submitted_at,
         result_at, note, document_ids
    FROM applications
   ORDER BY id ASC`;

const SELECT_DOCUMENTS = `
  SELECT id, name, kind, reusable, issued_at, validity_days, valid_until, ready, reuse_source
    FROM documents
   ORDER BY id ASC`;

const SELECT_TEAM_PROFILE = `
  SELECT id, has_business_registration, business_registered_at, incorporated_at,
         founder_birth_year, region
    FROM team_profile
   WHERE id = 1`;

export async function listPrograms(db: D1Database): Promise<Program[]> {
  const { results } = await db.prepare(SELECT_PROGRAMS).all<ProgramRow>();
  return results.map(toProgram);
}

export async function getProgram(db: D1Database, id: string): Promise<Program | null> {
  const row = await db
    .prepare(
      `SELECT id, title, organizer, source_url, category, apply_start, apply_end, apply_end_time,
              announce_date, support_amount, source, collected_at, eligibility, tags, alias_titles
         FROM programs WHERE id = ?`,
    )
    .bind(id)
    .first<ProgramRow>();
  return row ? toProgram(row) : null;
}

/**
 * 공고 삽입/갱신. id가 이미 있으면 덮어쓴다 — 수집기를 몇 번 돌려도 중복이 생기지 않는다.
 * 자동수집이 수동 입력분을 덮어쓰지 않게 하는 판단은 src/lib/collect.ts의 mergePrograms 몫이고,
 * 여기서는 시키는 대로 쓴다.
 */
export async function upsertProgram(db: D1Database, p: Program): Promise<void> {
  await db
    .prepare(
      `INSERT INTO programs (id, title, organizer, source_url, category, apply_start, apply_end,
                             apply_end_time, announce_date, support_amount, source, collected_at,
                             eligibility, tags, alias_titles)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         organizer = excluded.organizer,
         source_url = excluded.source_url,
         category = excluded.category,
         apply_start = excluded.apply_start,
         apply_end = excluded.apply_end,
         apply_end_time = excluded.apply_end_time,
         announce_date = excluded.announce_date,
         support_amount = excluded.support_amount,
         source = excluded.source,
         collected_at = excluded.collected_at,
         eligibility = excluded.eligibility,
         tags = excluded.tags,
         alias_titles = excluded.alias_titles`,
    )
    .bind(...bindValues(programToRow(p), PROGRAM_COLUMNS))
    .run();
}

export async function listApplications(db: D1Database): Promise<Application[]> {
  const { results } = await db.prepare(SELECT_APPLICATIONS).all<ApplicationRow>();
  return results.map(toApplication);
}

/**
 * 공고 하나에 대한 우리 팀의 지원 건. 스키마상 한 공고에 여러 건이 들어갈 수는 있지만
 * 운영상 1건만 두므로 가장 최근에 만들어진 것 하나를 돌려준다(id 내림차순).
 * 2건 이상이 발견되면 데이터 문제이므로 기록을 남긴다.
 */
export async function getApplicationByProgram(
  db: D1Database,
  programId: string,
): Promise<Application | null> {
  const { results } = await db
    .prepare(
      `SELECT id, program_id, status, owner, priority, target_submit_date, submitted_at,
              result_at, note, document_ids
         FROM applications WHERE program_id = ? ORDER BY id DESC`,
    )
    .bind(programId)
    .all<ApplicationRow>();

  if (results.length === 0) return null;
  if (results.length > 1) {
    recordIssue({
      table: 'applications',
      rowId: programId,
      column: 'program_id',
      message: `한 공고에 지원 건이 ${results.length}개 — 가장 최근 것만 사용`,
      sample: results.map((r) => r.id).join(', '),
    });
  }
  return toApplication(results[0]!);
}

export async function upsertApplication(db: D1Database, a: Application): Promise<void> {
  await db
    .prepare(
      `INSERT INTO applications (id, program_id, status, owner, priority, target_submit_date,
                                 submitted_at, result_at, note, document_ids)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(id) DO UPDATE SET
         program_id = excluded.program_id,
         status = excluded.status,
         owner = excluded.owner,
         priority = excluded.priority,
         target_submit_date = excluded.target_submit_date,
         submitted_at = excluded.submitted_at,
         result_at = excluded.result_at,
         note = excluded.note,
         document_ids = excluded.document_ids`,
    )
    .bind(...bindValues(applicationToRow(a), APPLICATION_COLUMNS))
    .run();
}

export async function listDocuments(db: D1Database): Promise<Document[]> {
  const { results } = await db.prepare(SELECT_DOCUMENTS).all<DocumentRow>();
  return results.map(toDocument);
}

export async function upsertDocument(db: D1Database, d: Document): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents (id, name, kind, reusable, issued_at, validity_days, valid_until,
                              ready, reuse_source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         reusable = excluded.reusable,
         issued_at = excluded.issued_at,
         validity_days = excluded.validity_days,
         valid_until = excluded.valid_until,
         ready = excluded.ready,
         reuse_source = excluded.reuse_source`,
    )
    .bind(...bindValues(documentToRow(d), DOCUMENT_COLUMNS))
    .run();
}

/**
 * 팀 프로필(단일 행). 없으면 던진다 — 자격요건 판정이 프로필 없이는 의미가 없으므로
 * 빈 기본값으로 얼버무리면 "전부 지원 가능"처럼 보이는 조용한 오답이 나온다.
 */
export async function getTeamProfile(db: D1Database): Promise<TeamProfile> {
  const row = await db.prepare(SELECT_TEAM_PROFILE).first<TeamProfileRow>();
  if (!row) {
    throw new Error('team_profile 행이 없습니다. `npm run seed -- --local`로 시드를 먼저 넣으세요.');
  }
  return toTeamProfile(row);
}

export async function upsertTeamProfile(db: D1Database, profile: TeamProfile): Promise<void> {
  await db
    .prepare(
      `INSERT INTO team_profile (id, has_business_registration, business_registered_at,
                                 incorporated_at, founder_birth_year, region)
       VALUES (1, ?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET
         has_business_registration = excluded.has_business_registration,
         business_registered_at = excluded.business_registered_at,
         incorporated_at = excluded.incorporated_at,
         founder_birth_year = excluded.founder_birth_year,
         region = excluded.region`,
    )
    .bind(...bindValues(teamProfileToRow(profile), TEAM_PROFILE_COLUMNS))
    .run();
}

/**
 * 화면/다이제스트가 필요로 하는 전부를 한 번에 읽는다.
 * 네 쿼리를 db.batch로 묶어 왕복을 1회로 줄인다 — Worker에서 순차 await하면 그만큼 지연이 쌓인다.
 * 결과 순서는 넘긴 statement 순서와 같다.
 */
export async function loadAll(db: D1Database): Promise<BoardData> {
  const [programs, applications, documents, profile] = await db.batch<unknown>([
    db.prepare(SELECT_PROGRAMS),
    db.prepare(SELECT_APPLICATIONS),
    db.prepare(SELECT_DOCUMENTS),
    db.prepare(SELECT_TEAM_PROFILE),
  ]);

  const profileRow = (profile!.results as TeamProfileRow[])[0];
  if (!profileRow) {
    throw new Error('team_profile 행이 없습니다. `npm run seed -- --local`로 시드를 먼저 넣으세요.');
  }

  return {
    programs: (programs!.results as ProgramRow[]).map(toProgram),
    applications: (applications!.results as ApplicationRow[]).map(toApplication),
    documents: (documents!.results as DocumentRow[]).map(toDocument),
    profile: toTeamProfile(profileRow),
  };
}

// ---------------------------------------------------------------------------
// 담당자 매핑 (owner_map)
// ---------------------------------------------------------------------------

/**
 * applications.owner / owner_map.owner의 상한. DB CHECK와 같은 값이어야 한다.
 * public 레포라 실명을 막으려고 둔 제약이다 — 여기서 먼저 걸러 DB 제약 위반 대신
 * 사람이 읽을 수 있는 메시지가 나가게 한다.
 */
const OWNER_MAX_LENGTH = 4;

/** 지우려는 대상이 없을 때. 호출자가 "그런 항목 없습니다"와 실제 실패를 구분할 수 있게 한다. */
export class NotFoundError extends Error {
  readonly table: string;
  readonly id: string;

  constructor(table: string, id: string) {
    super(`${table}에 id '${id}'인 행이 없습니다.`);
    this.name = 'NotFoundError';
    this.table = table;
    this.id = id;
  }
}

/**
 * 디스코드 계정에 담당자 이니셜을 붙인다. 같은 계정으로 다시 부르면 덮어쓴다
 * (discord_user_id가 PK라 한 계정이 이니셜을 둘 가질 수 없다).
 * 반대로 두 계정이 같은 이니셜을 쓰는 건 막지 않는다 — 공용 계정이 있을 수 있다.
 */
export async function setOwnerMapping(
  db: D1Database,
  discordUserId: string,
  owner: string,
): Promise<void> {
  const trimmed = owner.trim();
  if (trimmed.length === 0) {
    throw new Error('담당자 이니셜이 비어 있습니다.');
  }
  // 코드포인트 기준으로 센다. SQLite의 length()도 문자 수를 세므로 판정이 어긋나지 않는다.
  if ([...trimmed].length > OWNER_MAX_LENGTH) {
    throw new Error(
      `담당자 이니셜은 최대 ${OWNER_MAX_LENGTH}자입니다(실명 금지, 이니셜/닉네임만). 받은 값: '${trimmed}'`,
    );
  }

  await db
    .prepare(
      `INSERT INTO owner_map (discord_user_id, owner, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(discord_user_id) DO UPDATE SET
         owner = excluded.owner,
         updated_at = excluded.updated_at`,
    )
    // 감사용 타임스탬프. 날짜 '판정'이 아니므로 UTC ISO로 둔다 — KST 정규화가 필요한 곳은
    // src/lib/schedule.ts를 쓴다(0001_init.sql의 날짜 규칙 참고).
    .bind(discordUserId, trimmed, new Date().toISOString())
    .run();
}

/** 등록된 적 없는 계정이면 null. 호출자는 이걸 보고 "먼저 /나는 으로 등록하세요"를 띄우면 된다. */
export async function getOwnerByDiscordUser(
  db: D1Database,
  discordUserId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT owner FROM owner_map WHERE discord_user_id = ?')
    .bind(discordUserId)
    .first<{ owner: string }>();
  return row ? row.owner : null;
}

export async function listOwnerMappings(db: D1Database): Promise<OwnerMapping[]> {
  const { results } = await db
    .prepare('SELECT discord_user_id, owner FROM owner_map ORDER BY owner ASC, discord_user_id ASC')
    .all<{ discord_user_id: string; owner: string }>();
  return results.map((row) => ({ discordUserId: row.discord_user_id, owner: row.owner }));
}

// ---------------------------------------------------------------------------
// 삭제
// ---------------------------------------------------------------------------

/**
 * 공고와 거기 딸린 지원 현황을 함께 지운다.
 *
 * 지원 현황을 남기면 화면에서 program이 null인 카드가 되므로 반드시 같이 지운다.
 * FK에 ON DELETE CASCADE가 걸려 있지만 그것에 기대지 않고 명시적으로 먼저 지운다 —
 * D1에서 foreign_keys PRAGMA가 켜져 있든 아니든 동작이 같아야 하고,
 * 몇 건이 함께 지워졌는지 정확한 수를 사용자에게 알려줘야 하기 때문이다.
 *
 * @throws {NotFoundError} 해당 id의 공고가 없을 때. 이 경우 아무것도 지우지 않는다.
 * @returns 함께 지워진 지원 현황 건수
 */
export async function deleteProgram(
  db: D1Database,
  id: string,
): Promise<{ deletedApplications: number }> {
  // 존재 확인을 먼저 한다. 지운 뒤에 던지면 "없는 공고"인데도 고아 지원현황이 사라진다.
  const existing = await db.prepare('SELECT id FROM programs WHERE id = ?').bind(id).first<{ id: string }>();
  if (!existing) throw new NotFoundError('programs', id);

  // batch는 하나의 트랜잭션으로 실행된다 — 지원현황만 지워지고 공고가 남는 절반 상태가 없다.
  const [appsResult, programResult] = await db.batch([
    db.prepare('DELETE FROM applications WHERE program_id = ?').bind(id),
    db.prepare('DELETE FROM programs WHERE id = ?').bind(id),
  ]);

  if (programResult!.meta.changes === 0) {
    // 존재 확인과 삭제 사이에 누가 먼저 지운 경우. 결과는 같지만 조용히 넘기지는 않는다.
    recordIssue({
      table: 'programs',
      rowId: id,
      column: 'id',
      message: '삭제 직전에 행이 이미 사라졌습니다(동시 삭제로 추정)',
      sample: id,
    });
  }

  return { deletedApplications: appsResult!.meta.changes };
}

/**
 * 서류를 지우고, 그 서류를 참조하던 applications.document_ids에서 id를 떼어낸다.
 * 떼어내지 않으면 존재하지 않는 서류를 가리키는 참조가 남아 "준비된 서류 N건" 집계가 틀어진다.
 *
 * document_ids는 JSON 배열 문자열이라 SQL만으로는 원소를 안전하게 뺄 수 없다.
 * (LIKE '%id%'는 'doc-plan'이 'doc-plan-v2'에도 걸려 오탐이 난다.)
 * 그래서 읽어서 JS에서 정확히 비교한 뒤, 실제로 그 id를 담고 있던 행만 다시 쓴다.
 * 지원 건수는 팀 단위라 많아야 수십 건이므로 전량 조회가 문제되지 않는다.
 *
 * @throws {NotFoundError} 해당 id의 서류가 없을 때. 이 경우 아무것도 바꾸지 않는다.
 * @returns 참조를 떼어낸 지원 현황 건수
 */
export async function deleteDocument(db: D1Database, id: string): Promise<{ detachedFrom: number }> {
  const existing = await db.prepare('SELECT id FROM documents WHERE id = ?').bind(id).first<{ id: string }>();
  if (!existing) throw new NotFoundError('documents', id);

  const applications = await listApplications(db);
  // 파싱이 깨진 행은 documentIds가 []로 오므로 여기 걸리지 않는다 —
  // 원본을 빈 배열로 덮어쓰는 사고가 나지 않게 하려는 의도다.
  const affected = applications.filter((application) => application.documentIds.includes(id));

  const statements = affected.map((application) =>
    db
      .prepare('UPDATE applications SET document_ids = ?1 WHERE id = ?2')
      .bind(JSON.stringify(application.documentIds.filter((docId) => docId !== id)), application.id),
  );
  statements.push(db.prepare('DELETE FROM documents WHERE id = ?').bind(id));

  // 참조 제거와 서류 삭제가 한 트랜잭션이다. 절반만 적용되면 깨진 참조가 남는다.
  const results = await db.batch(statements);

  // 마지막 결과는 DELETE이므로 제외하고, 실제로 갱신된 행 수를 센다.
  const detachedFrom = results
    .slice(0, affected.length)
    .reduce((sum, result) => sum + result.meta.changes, 0);

  return { detachedFrom };
}
