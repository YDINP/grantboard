/**
 * repo.ts가 실제로 던지는 SQL 패턴만 흉내 내는 최소 D1 목(mock). 진짜 SQLite 대신 — 이 프로젝트에
 * 새 테스트 의존성을 추가하지 않기 위함이다(myDeadlinesFallback.test.ts가 먼저 쓰던 방식을
 * 일반화했다). 파일명이 `.test.ts`로 끝나지 않아 테스트 러너 글롭(worker/**\/*.test.ts)에
 * 걸리지 않는다 — 순수 테스트 지원 유틸리티다.
 *
 * 행은 D1이 실제로 주는 형태(snake_case 컬럼)로 보관한다 — repo.ts의 toProgram/toApplication
 * 같은 변환 함수가 그 형태를 기대하기 때문이다.
 */

export type Row = Record<string, unknown>;

export interface FakeTables {
  programs: Row[];
  applications: Row[];
  documents: Row[];
  team_profile: Row[];
  owner_map: Row[];
  bot_state: Row[];
}

export function emptyTables(): FakeTables {
  return { programs: [], applications: [], documents: [], team_profile: [], owner_map: [], bot_state: [] };
}

function upsertRow(table: Row[], keyField: string, row: Row): void {
  const idx = table.findIndex((r) => r[keyField] === row[keyField]);
  if (idx >= 0) table[idx] = row;
  else table.push(row);
}

class FakeStatement {
  private sql: string;
  private tables: FakeTables;
  private args: unknown[] = [];

  constructor(sql: string, tables: FakeTables) {
    this.sql = sql;
    this.tables = tables;
  }

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.select()[0] as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.select() as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.mutate();
  }

  private select(): Row[] {
    const sql = this.sql;
    if (sql.includes('FROM owner_map')) {
      return sql.includes('WHERE') ? this.tables.owner_map.filter((r) => r.discord_user_id === this.args[0]) : this.tables.owner_map;
    }
    if (sql.includes('FROM programs')) {
      return sql.includes('WHERE id = ?') ? this.tables.programs.filter((r) => r.id === this.args[0]) : this.tables.programs;
    }
    if (sql.includes('FROM applications')) {
      return sql.includes('WHERE program_id') ? this.tables.applications.filter((r) => r.program_id === this.args[0]) : this.tables.applications;
    }
    if (sql.includes('FROM documents')) return this.tables.documents;
    if (sql.includes('FROM team_profile')) return this.tables.team_profile;
    if (sql.includes('FROM bot_state')) return this.tables.bot_state.filter((r) => r.key === this.args[0]);
    throw new Error(`FakeD1: 지원하지 않는 SELECT (테스트에 라우팅을 추가해야 함): ${sql}`);
  }

  private mutate(): { meta: { changes: number } } {
    const sql = this.sql;
    if (sql.startsWith('INSERT INTO applications')) {
      const [id, program_id, status, owner, priority, target_submit_date, submitted_at, result_at, note, document_ids] = this.args;
      upsertRow(this.tables.applications, 'id', {
        id,
        program_id,
        status,
        owner,
        priority,
        target_submit_date,
        submitted_at,
        result_at,
        note,
        document_ids,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM applications')) {
      const before = this.tables.applications.length;
      this.tables.applications = this.tables.applications.filter((r) => r.program_id !== this.args[0] && r.id !== this.args[0]);
      return { meta: { changes: before - this.tables.applications.length } };
    }
    if (sql.startsWith('INSERT INTO documents')) {
      const [id, name, kind, reusable, issued_at, validity_days, valid_until, ready, reuse_source] = this.args;
      upsertRow(this.tables.documents, 'id', { id, name, kind, reusable, issued_at, validity_days, valid_until, ready, reuse_source });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO owner_map')) {
      const [discord_user_id, owner, updated_at] = this.args;
      upsertRow(this.tables.owner_map, 'discord_user_id', { discord_user_id, owner, updated_at });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO programs')) {
      const [
        id,
        title,
        organizer,
        source_url,
        category,
        apply_start,
        apply_end,
        apply_end_time,
        announce_date,
        support_amount,
        source,
        collected_at,
        eligibility,
        tags,
        alias_titles,
      ] = this.args;
      upsertRow(this.tables.programs, 'id', {
        id,
        title,
        organizer,
        source_url,
        category,
        apply_start,
        apply_end,
        apply_end_time,
        announce_date,
        support_amount,
        source,
        collected_at,
        eligibility,
        tags,
        alias_titles,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM programs')) {
      const before = this.tables.programs.length;
      this.tables.programs = this.tables.programs.filter((r) => r.id !== this.args[0]);
      return { meta: { changes: before - this.tables.programs.length } };
    }
    if (sql.startsWith('INSERT INTO bot_state')) {
      const [key, value, updated_at] = this.args;
      upsertRow(this.tables.bot_state, 'key', { key, value, updated_at });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM bot_state')) {
      const before = this.tables.bot_state.length;
      this.tables.bot_state = this.tables.bot_state.filter((r) => r.key !== this.args[0]);
      return { meta: { changes: before - this.tables.bot_state.length } };
    }
    throw new Error(`FakeD1: 지원하지 않는 쓰기 (테스트에 라우팅을 추가해야 함): ${sql}`);
  }
}

export class FakeD1 {
  tables: FakeTables;

  constructor(tables: FakeTables = emptyTables()) {
    this.tables = tables;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.tables);
  }

  async batch(stmts: FakeStatement[]): Promise<Array<{ results: unknown[] }>> {
    return Promise.all(stmts.map((s) => s.all()));
  }
}

/** 최소한의 팀 프로필 + 공고 1건을 담은 고정치. 대부분의 테스트가 이 정도면 충분하다. */
export function fixtureTables(): FakeTables {
  return {
    owner_map: [],
    programs: [
      {
        id: 'prog-1',
        title: '테스트공고',
        organizer: '테스트기관',
        source_url: 'https://example.com',
        category: '공모전',
        apply_start: null,
        apply_end: '2026-12-31',
        apply_end_time: null,
        announce_date: null,
        support_amount: null,
        source: 'manual',
        collected_at: null,
        eligibility: null,
        tags: null,
        alias_titles: null,
      },
    ],
    applications: [],
    documents: [],
    bot_state: [],
    team_profile: [
      {
        id: 1,
        has_business_registration: 0,
        business_registered_at: null,
        incorporated_at: null,
        founder_birth_year: null,
        region: '서울',
      },
    ],
  };
}
