/**
 * 스키마 이중화 가드.
 *
 * 같은 데이터 형태가 네 군데에 적혀 있어서(zod / TS 인터페이스 / repo 컬럼 상수 / SQL 마이그레이션)
 * 한 곳만 고치면 아무 에러 없이 갈라진다. 증상은 "디스코드로 입력한 값이 화면에서 사라짐"처럼
 * 한참 뒤에 엉뚱한 모습으로 나타난다. 그걸 커밋 시점에 깨뜨리는 게 이 파일의 목적이다.
 *
 * 무엇을 잡고 무엇을 못 잡는가:
 *   ✅ 한쪽에만 필드를 추가/삭제/오타     → 키 집합 비교가 잡는다
 *   ✅ optional 여부가 어긋남              → optional 표시 비교가 잡는다
 *   ✅ 컬럼명 오타, SQL에만 빠진 컬럼      → SQL 컬럼 비교가 잡는다
 *   ✅ 실제 데이터의 필드가 왕복에서 유실   → 왕복 테스트가 잡는다
 *   ❌ 타입 '형태'만 바뀌는 경우(string→number)는 키 비교로는 못 잡는다.
 *      data/*.json에 그 값이 실제로 들어 있다면 왕복 테스트가 잡고, 아니면 못 잡는다.
 *   ❌ zod `.default()`의 '값' 자체(예: [] → ['기본태그'])는 못 잡는다.
 *      어느 필드가 default를 갖는지는 아래에서 검증하므로, 남는 위험은 값뿐이다.
 *
 * 검사 대상이 아닌 테이블 (묻기 전에 답을 적어둔다):
 *   owner_map (0002), bot_state (0003)은 **런타임 상태**라 zod 정본이 없다.
 *   data/*.json에 대응하는 파일이 없고 Astro도 읽지 않는다 — 디스코드 봇이 실행 중에 쓰고 읽을 뿐이다.
 *   정본이 한 벌(마이그레이션 SQL)뿐이라 '갈라질' 상대가 없으므로 여기서 검사하지 않는다.
 *   같은 이유로 scripts/seed-d1.mjs도 두 테이블을 건드리지 않는다(시드가 지우면 봇의 기억이 날아간다).
 *   나중에 이 테이블들에 zod 스키마가 생기면 그때 SCHEMA_PAIRS에 추가할 것.
 *
 * TS 타입은 런타임에 사라지므로 값 비교로는 키 집합을 알 수 없다. 그래서 소스 텍스트를 판다
 * (worker/db/schema-keys.ts). 서식이 크게 바뀌면 파서가 키를 놓칠 수 있는데, 그때는 조용히
 * 통과하지 않고 키 집합이 줄어 테스트가 깨진다 — 거짓 음성보다 거짓 양성이 안전하다.
 *
 * 실행: node --test worker/db/*.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPLICATION_COLUMNS,
  DOCUMENT_COLUMNS,
  PROGRAM_COLUMNS,
  TEAM_PROFILE_COLUMNS,
  applicationToRow,
  documentToRow,
  programToRow,
  teamProfileToRow,
  toApplication,
  toDocument,
  toProgram,
  toTeamProfile,
} from './repo.ts';
import {
  fieldNames,
  interfaceFields,
  sqlTableColumns,
  zodCollectionFields,
  zodNestedFields,
  zodVariableFields,
  type SchemaField,
} from './schema-keys.ts';

// 전역 URL을 쓰지 않는다: workers-types의 URL과 node:url의 URL이 겹쳐 readFileSync 오버로드가
// 잡히지 않는다(Buffer가 반환 타입으로 추론됨). 경로를 문자열로 만들어 넘긴다.
// worker/web/buildClient.ts도 같은 이유로 같은 방식을 쓴다.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8');
const readJson = (relativePath: string): any => JSON.parse(read(relativePath));

const CONTENT_CONFIG = read('src/content.config.ts');
const TEAM_PROFILE_SOURCE = read('src/lib/teamProfile.ts');
const TYPES_SOURCE = read('worker/db/types.ts');
const MIGRATION = read('migrations/0001_init.sql');

/** zod 출력 타입 기준의 optional: `.default()`가 있으면 값이 항상 채워지므로 optional이 아니다. */
function optionalNames(fields: readonly SchemaField[]): string[] {
  return fields
    .filter((field) => field.optional && !field.hasDefault)
    .map((field) => field.name)
    .sort();
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

// zod 스키마 ↔ TS 인터페이스 대응표. 새 컬렉션이 생기면 여기에 한 줄 추가한다.
const SCHEMA_PAIRS = [
  {
    label: 'programs',
    zod: () => zodCollectionFields(CONTENT_CONFIG, 'programs'),
    ts: () => interfaceFields(TYPES_SOURCE, 'Program'),
    table: 'programs',
    columns: PROGRAM_COLUMNS,
  },
  {
    label: 'applications',
    zod: () => zodCollectionFields(CONTENT_CONFIG, 'applications'),
    ts: () => interfaceFields(TYPES_SOURCE, 'Application'),
    table: 'applications',
    columns: APPLICATION_COLUMNS,
  },
  {
    label: 'documents',
    zod: () => zodCollectionFields(CONTENT_CONFIG, 'documents'),
    ts: () => interfaceFields(TYPES_SOURCE, 'Document'),
    table: 'documents',
    columns: DOCUMENT_COLUMNS,
  },
] as const;

test('zod 스키마와 TS 인터페이스의 키 집합이 일치한다', async (t) => {
  for (const pair of SCHEMA_PAIRS) {
    await t.test(pair.label, () => {
      assert.deepEqual(fieldNames(pair.ts()), fieldNames(pair.zod()));
    });
  }

  await t.test('programs.eligibility (중첩 객체)', () => {
    assert.deepEqual(
      fieldNames(interfaceFields(TYPES_SOURCE, 'ProgramEligibility')),
      fieldNames(zodNestedFields(CONTENT_CONFIG, 'eligibility')),
    );
  });

  await t.test('teamProfile', () => {
    assert.deepEqual(
      fieldNames(interfaceFields(TYPES_SOURCE, 'TeamProfile')),
      fieldNames(zodVariableFields(TEAM_PROFILE_SOURCE, 'teamProfileSchema')),
    );
  });
});

test('optional 표시가 zod와 TS 인터페이스에서 일치한다', async (t) => {
  for (const pair of SCHEMA_PAIRS) {
    await t.test(pair.label, () => {
      // zod의 .default()는 출력 타입을 required로 만든다. TS 쪽에 `?`가 붙어 있으면 그게 틀린 것이다.
      assert.deepEqual(optionalNames(pair.ts()), optionalNames(pair.zod()));
    });
  }

  await t.test('programs.eligibility (중첩 객체)', () => {
    assert.deepEqual(
      optionalNames(interfaceFields(TYPES_SOURCE, 'ProgramEligibility')),
      optionalNames(zodNestedFields(CONTENT_CONFIG, 'eligibility')),
    );
  });

  await t.test('teamProfile', () => {
    assert.deepEqual(
      optionalNames(interfaceFields(TYPES_SOURCE, 'TeamProfile')),
      optionalNames(zodVariableFields(TEAM_PROFILE_SOURCE, 'teamProfileSchema')),
    );
  });
});

test('TS 인터페이스의 키가 SQL 테이블 컬럼과 일치한다 (camelCase ↔ snake_case)', async (t) => {
  for (const pair of SCHEMA_PAIRS) {
    await t.test(pair.label, () => {
      const fromTypes = fieldNames(pair.ts()).map(camelToSnake).sort();
      assert.deepEqual(fromTypes, sqlTableColumns(MIGRATION, pair.table).sort());
    });
  }

  await t.test('team_profile (id는 항상 1인 단일 행이라 도메인 타입에 없다)', () => {
    const fromTypes = fieldNames(interfaceFields(TYPES_SOURCE, 'TeamProfile')).map(camelToSnake).sort();
    const fromSql = sqlTableColumns(MIGRATION, 'team_profile')
      .filter((column) => column !== 'id')
      .sort();
    assert.deepEqual(fromTypes, fromSql);
  });
});

test('repo의 컬럼 상수가 SQL 테이블 컬럼과 일치한다 (bind 순서의 정본)', async (t) => {
  for (const pair of SCHEMA_PAIRS) {
    await t.test(pair.label, () => {
      assert.deepEqual([...pair.columns].sort(), sqlTableColumns(MIGRATION, pair.table).sort());
    });
  }

  await t.test('team_profile', () => {
    assert.deepEqual(
      [...TEAM_PROFILE_COLUMNS].sort(),
      sqlTableColumns(MIGRATION, 'team_profile')
        .filter((column) => column !== 'id')
        .sort(),
    );
  });
});

/**
 * zod `.default()`를 흉내낸 값. 이 표의 **키 집합**은 아래 테스트가 zod 소스와 대조하므로
 * 필드가 추가/삭제되면 깨진다. 남는 위험은 default '값' 자체뿐이다.
 */
const DEFAULTS = {
  programs: { tags: [], source: 'manual', aliasTitles: [] },
  applications: { priority: 'mid', documentIds: [] },
  documents: { reusable: true, ready: false },
} as const;

test('DEFAULTS 표가 zod의 .default() 필드 목록과 일치한다', async (t) => {
  for (const pair of SCHEMA_PAIRS) {
    await t.test(pair.label, () => {
      const withDefaults = pair
        .zod()
        .filter((field) => field.hasDefault)
        .map((field) => field.name)
        .sort();
      assert.deepEqual(Object.keys(DEFAULTS[pair.label]).sort(), withDefaults);
    });
  }
});

/** data/*.json의 한 레코드를 zod 파싱 결과와 같은 모양(기본값 채워진)으로 만든다. */
function withDefaults(raw: Record<string, unknown>, label: keyof typeof DEFAULTS): Record<string, unknown> {
  return { ...DEFAULTS[label], ...raw };
}

/** 왕복에서 원본 키가 하나도 사라지지 않았는지 확인한다. 값까지 비교한다. */
function assertNoFieldLost(
  raw: Record<string, unknown>,
  roundTripped: Record<string, unknown>,
  label: string,
): void {
  for (const [key, value] of Object.entries(raw)) {
    // _comment는 설명용 키다. zod도 스키마에 없는 키로 보고 버리므로 왕복 대상이 아니다.
    if (key === '_comment') continue;
    assert.ok(
      key in roundTripped,
      `${label}: '${key}' 필드가 왕복에서 사라졌습니다. ` +
        `worker/db/types.ts와 repo.ts의 매퍼에 이 필드가 있는지 확인하세요.`,
    );
    assert.deepEqual(roundTripped[key], value, `${label}: '${key}' 값이 왕복에서 바뀌었습니다.`);
  }
}

test('data/*.json의 모든 레코드가 repo 직렬화/역직렬화 왕복을 그대로 통과한다', async (t) => {
  await t.test('programs (10건)', () => {
    const rows = readJson('data/programs.json');
    assert.equal(rows.length, 10, '실제 조사로 확인한 공고 10건이 그대로 있어야 합니다.');
    for (const raw of rows) {
      const domain = withDefaults(raw, 'programs') as any;
      const roundTripped = toProgram(programToRow(domain));
      assert.deepEqual(roundTripped, domain, `programs[${raw.id}] 왕복 불일치`);
      assertNoFieldLost(raw, roundTripped as any, `programs[${raw.id}]`);
    }
  });

  await t.test('applications', () => {
    for (const raw of readJson('data/applications.json')) {
      const domain = withDefaults(raw, 'applications') as any;
      const roundTripped = toApplication(applicationToRow(domain));
      assert.deepEqual(roundTripped, domain, `applications[${raw.id}] 왕복 불일치`);
      assertNoFieldLost(raw, roundTripped as any, `applications[${raw.id}]`);
    }
  });

  await t.test('documents', () => {
    for (const raw of readJson('data/documents.json')) {
      const domain = withDefaults(raw, 'documents') as any;
      const roundTripped = toDocument(documentToRow(domain));
      assert.deepEqual(roundTripped, domain, `documents[${raw.id}] 왕복 불일치`);
      assertNoFieldLost(raw, roundTripped as any, `documents[${raw.id}]`);
    }
  });

  await t.test('team-profile', () => {
    const raw = readJson('data/team-profile.json');
    const { _comment, ...domain } = raw;
    const roundTripped = toTeamProfile(teamProfileToRow(domain as any));
    assert.deepEqual(roundTripped, domain, 'team-profile 왕복 불일치');
    assertNoFieldLost(raw, roundTripped as any, 'team-profile');
  });
});

test('중첩 eligibility 객체도 왕복에서 보존된다', () => {
  // JSON 컬럼이라 직렬화/파싱을 거치는데, 여기서 키가 새면 자격요건 자동판정이 조용히 틀린다.
  const withEligibility = readJson('data/programs.json').filter((p: any) => p.eligibility);
  assert.ok(withEligibility.length > 0, 'eligibility를 가진 공고가 최소 하나는 있어야 테스트가 의미 있습니다.');
  for (const raw of withEligibility) {
    const domain = withDefaults(raw, 'programs') as any;
    const roundTripped = toProgram(programToRow(domain));
    assert.deepEqual(roundTripped.eligibility, raw.eligibility, `programs[${raw.id}].eligibility 왕복 불일치`);
  }
});

// ---------------------------------------------------------------------------
// 가드 자체 검증 — "안 잡히면 가드가 아니다"
// ---------------------------------------------------------------------------

test('가드 검증: zod에만 필드를 추가하면 키 비교가 실제로 깨진다', () => {
  const marker = '    supportAmount: z.string().optional(),';
  assert.ok(
    CONTENT_CONFIG.includes(marker),
    'src/content.config.ts의 서식이 바뀌어 주입 지점을 찾지 못했습니다. 이 테스트를 고치세요.',
  );

  // zod에만 있고 types.ts에는 없는 필드를 흉내낸다.
  const mutated = CONTENT_CONFIG.replace(marker, `${marker}\n    contactEmail: z.string().optional(),`);

  const mutatedKeys = fieldNames(zodCollectionFields(mutated, 'programs'));
  const typeKeys = fieldNames(interfaceFields(TYPES_SOURCE, 'Program'));

  assert.ok(mutatedKeys.includes('contactEmail'), '파서가 새 필드를 인식하지 못했습니다 — 가드가 동작하지 않습니다.');
  assert.notDeepEqual(typeKeys, mutatedKeys, '한쪽에만 필드를 추가했는데 키 집합이 같다고 나옵니다 — 가드가 동작하지 않습니다.');
  assert.deepEqual(
    mutatedKeys.filter((key) => !typeKeys.includes(key)),
    ['contactEmail'],
    '차이가 정확히 새로 추가한 필드 하나여야 합니다.',
  );
});

test('가드 검증: SQL에서 컬럼을 빼면 컬럼 비교가 실제로 깨진다', () => {
  const marker = '  support_amount  TEXT,';
  assert.ok(MIGRATION.includes(marker), '마이그레이션 서식이 바뀌었습니다. 이 테스트를 고치세요.');

  const mutated = MIGRATION.replace(marker, '');
  const columns = sqlTableColumns(mutated, 'programs');

  assert.ok(!columns.includes('support_amount'), '파서가 컬럼 삭제를 인식하지 못했습니다.');
  assert.notDeepEqual([...PROGRAM_COLUMNS].sort(), columns.sort(), 'SQL에서 컬럼을 뺐는데 일치한다고 나옵니다 — 가드가 동작하지 않습니다.');
});

test('가드 검증: optional 표시가 어긋나면 잡는다', () => {
  const marker = '    supportAmount: z.string().optional(),';
  // .optional()을 떼어 required로 만든다. types.ts는 여전히 `supportAmount?`다.
  const mutated = CONTENT_CONFIG.replace(marker, '    supportAmount: z.string(),');

  const mutatedOptional = optionalNames(zodCollectionFields(mutated, 'programs'));
  const typeOptional = optionalNames(interfaceFields(TYPES_SOURCE, 'Program'));

  assert.ok(!mutatedOptional.includes('supportAmount'), '파서가 optional 제거를 인식하지 못했습니다.');
  assert.notDeepEqual(typeOptional, mutatedOptional, 'optional이 어긋났는데 같다고 나옵니다 — 가드가 동작하지 않습니다.');
});

test('가드 검증: 데이터에만 있는 필드는 왕복 테스트가 잡는다', () => {
  const raw = { ...readJson('data/programs.json')[0], contactEmail: 'x@example.com' };
  const roundTripped = toProgram(programToRow(withDefaults(raw, 'programs') as any));

  assert.throws(
    () => assertNoFieldLost(raw, roundTripped as any, 'programs[가상]'),
    /'contactEmail' 필드가 왕복에서 사라졌습니다/,
    'repo 매퍼가 모르는 필드가 조용히 사라지는데 테스트가 통과합니다 — 가드가 동작하지 않습니다.',
  );
});
