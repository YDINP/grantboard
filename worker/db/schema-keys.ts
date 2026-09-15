/**
 * 스키마 정본이 여러 벌인 상태를 감시하기 위한 소스 텍스트 파서.
 *
 * 지금 같은 데이터 형태가 네 군데에 적혀 있다:
 *   1. src/content.config.ts        — zod 스키마 (Astro 쪽 정본)
 *   2. worker/db/types.ts           — TS 인터페이스 (Worker 쪽 정본)
 *   3. worker/db/repo.ts            — 행 ↔ 객체 매퍼와 컬럼 목록
 *   4. migrations/*.sql             — 실제 테이블 컬럼
 *
 * 한 곳에만 필드를 추가하면 **아무 에러 없이** 갈라진다. 타입은 런타임에 사라지므로
 * 값을 비교하는 방식으로는 이걸 잡을 수 없다. 그래서 소스 텍스트에서 키 집합을 직접 뽑아 비교한다.
 *
 * 한계(중요):
 *   - 정규식이 아니라 중괄호 깊이를 세지만, 어디까지나 텍스트 파싱이다. 소스 서식이 크게 바뀌면
 *     (예: 한 줄에 여러 필드를 몰아 적으면) 키를 놓칠 수 있다. 놓치면 조용히 통과하는 게 아니라
 *     키 집합이 줄어 테스트가 깨지는 쪽으로 기운다 — 거짓 음성보다 거짓 양성이 안전하다.
 *   - 타입의 '형태'까지는 보지 않는다. `string`을 `number`로 바꾸는 변경은 여기서 못 잡고,
 *     types.test.ts의 왕복 테스트가 실제 데이터로 잡는다.
 */

/** 주석 안의 중괄호·콜론이 파싱을 흔들지 않게 먼저 걷어낸다. */
export function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

export interface SchemaField {
  name: string;
  /** zod의 `.optional()` 또는 TS의 `?:`. */
  optional: boolean;
  /** zod의 `.default(...)`. 이게 있으면 출력 타입은 optional이 아니다. */
  hasDefault: boolean;
}

// 객체 리터럴/인터페이스 본문에서 `키:` 또는 `키?:` 로 시작하는 줄.
const FIELD_LINE = /^\s*([A-Za-z_$][\w$]*)\s*(\??)\s*:/;

/**
 * `openBraceIndex`가 가리키는 `{`의 본문에서 **깊이 1의 필드만** 뽑는다.
 * 중첩 객체(z.object 안의 z.object, 인터페이스 안의 인라인 객체)는 건너뛴다.
 */
export function extractFields(source: string, openBraceIndex: number): SchemaField[] {
  const fields: SchemaField[] = [];
  let depth = 0;
  let depthAtLineStart = 0;
  let line = '';
  let current: SchemaField | null = null;
  let currentText = '';

  const flush = (): void => {
    if (!current) return;
    current.optional = /\.optional\(\)/.test(currentText) || current.optional;
    current.hasDefault = /\.default\(/.test(currentText);
    fields.push(current);
    current = null;
    currentText = '';
  };

  const consumeLine = (): void => {
    if (depthAtLineStart === 1) {
      const match = FIELD_LINE.exec(line);
      if (match) {
        flush();
        current = { name: match[1]!, optional: match[2] === '?', hasDefault: false };
        currentText = line;
        return;
      }
    }
    if (current) currentText += `\n${line}`;
  };

  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === '\n') {
      consumeLine();
      line = '';
      depthAtLineStart = depth;
      continue;
    }
    line += char;
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        consumeLine();
        flush();
        return fields;
      }
    }
  }

  throw new Error('객체 블록이 닫히지 않았습니다. 소스 서식을 확인하세요.');
}

/** `marker` 이후 처음 나오는 `opener`의 여는 중괄호 위치. opener는 반드시 '{'로 끝나야 한다. */
export function openBraceAfter(source: string, marker: string, opener: string): number {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`소스에서 '${marker}'를 찾지 못했습니다.`);
  const openerIndex = source.indexOf(opener, markerIndex);
  if (openerIndex < 0) throw new Error(`'${marker}' 뒤에서 '${opener}'를 찾지 못했습니다.`);
  return openerIndex + opener.length - 1;
}

/** zod 컬렉션 스키마(`schema: z.object({ ... })`)의 필드. */
export function zodCollectionFields(source: string, collectionName: string): SchemaField[] {
  const clean = stripComments(source);
  const brace = openBraceAfter(clean, `const ${collectionName} = defineCollection(`, 'z.object({');
  return extractFields(clean, brace);
}

/** 중첩 zod 객체(`키: z.object({ ... })`)의 필드. */
export function zodNestedFields(source: string, fieldName: string): SchemaField[] {
  const clean = stripComments(source);
  const brace = openBraceAfter(clean, `${fieldName}: z`, '.object({');
  return extractFields(clean, brace);
}

/** 독립 zod 스키마 변수(`const X = z.object({ ... })`)의 필드. */
export function zodVariableFields(source: string, variableName: string): SchemaField[] {
  const clean = stripComments(source);
  const brace = openBraceAfter(clean, `const ${variableName} =`, 'z.object({');
  return extractFields(clean, brace);
}

/** `export interface Name { ... }`의 필드. */
export function interfaceFields(source: string, interfaceName: string): SchemaField[] {
  const clean = stripComments(source);
  const brace = openBraceAfter(clean, `export interface ${interfaceName} {`, '{');
  return extractFields(clean, brace);
}

const SQL_COLUMN_LINE = /^\s*([a-z_][a-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i;

/**
 * `CREATE TABLE IF NOT EXISTS <table> ( ... );`의 컬럼 이름.
 * 타입 키워드를 요구하므로 여러 줄에 걸친 CHECK 제약이나 인덱스 정의에는 걸리지 않는다.
 */
export function sqlTableColumns(source: string, table: string): string[] {
  const clean = stripComments(source.replace(/^\s*--.*$/gm, ''));
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(clean);
  if (!match) throw new Error(`마이그레이션에서 테이블 '${table}'을 찾지 못했습니다.`);
  return match[1]!
    .split('\n')
    .map((line) => SQL_COLUMN_LINE.exec(line))
    .filter((found): found is RegExpExecArray => found !== null)
    .map((found) => found[1]!);
}

export function fieldNames(fields: readonly SchemaField[]): string[] {
  return fields.map((field) => field.name).sort();
}
