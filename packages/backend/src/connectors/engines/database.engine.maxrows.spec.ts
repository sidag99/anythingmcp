import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseEngine } from './database.engine';

// Postgres is mocked: only the slice a driver applies to the rows it loaded matters here.
const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery, end: jest.fn() })),
}));

/**
 * `config.maxRows`: how many rows one query may return. Opt-in per connector, a
 * hard ceiling above it, and for SQLite the rows are streamed, so memory follows
 * the cap and not the size of the table.
 */

const CEILING = 250_000;

describe('DatabaseEngine: config.maxRows', () => {
  let dir: string;
  let config: { baseUrl: string; authType: string };
  const engine = new DatabaseEngine();

  const query = (sql: string, options: Record<string, unknown> = {}) =>
    engine.execute(config, { method: 'query', path: sql }, {}, options) as Promise<{
      rows: Array<Record<string, unknown>>;
      totalRows: number | string;
      truncated?: boolean;
      message?: string;
    }>;

  /** n rows without a table: a recursive CTE, which a read-only connector may run. */
  const rowsOf = (n: number) =>
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT x FROM c`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'maxrows-'));
    const file = join(dir, 'demo.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
    const insert = db.prepare('INSERT INTO t (label) VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) insert.run(`row ${i}`);
    })();
    db.close();
    config = { baseUrl: `sqlite://${file}`, authType: 'CONNECTION_STRING' };
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => jest.restoreAllMocks());

  describe('the default is unchanged', () => {
    it('returns 1000 rows and says the result was cut, with the real total', async () => {
      const r = await query('SELECT * FROM t');
      expect(r.rows).toHaveLength(1000);
      expect(r).toMatchObject({ truncated: true, totalRows: 5000, message: 'Results truncated to 1000 rows' });
    });

    it('does not mark a short result as cut', async () => {
      const r = await query('SELECT * FROM t WHERE id <= 10');
      expect(r.rows).toHaveLength(10);
      expect(r.truncated).toBeUndefined();
      expect(r.totalRows).toBe(10);
    });
  });

  describe('a connector can raise it', () => {
    it('returns that many rows, still reporting the real total', async () => {
      const r = await query('SELECT * FROM t', { maxRows: 3000 });
      expect(r.rows).toHaveLength(3000);
      expect(r).toMatchObject({ truncated: true, totalRows: 5000, message: 'Results truncated to 3000 rows' });
    });

    it('returns everything when the cap is above the result', async () => {
      const r = await query('SELECT * FROM t', { maxRows: 10_000 });
      expect(r.rows).toHaveLength(5000);
      expect(r.truncated).toBeUndefined();
    });

    it('keeps the rows in query order', async () => {
      const r = await query('SELECT id FROM t ORDER BY id', { maxRows: 5 });
      expect(r.rows.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('can also lower it', async () => {
      const r = await query('SELECT * FROM t', { maxRows: 10 });
      expect(r.rows).toHaveLength(10);
      expect(r.truncated).toBe(true);
    });
  });

  describe('it is bounded', () => {
    it(`never returns more than the ceiling of ${CEILING} rows, whatever is asked`, async () => {
      const r = await query(rowsOf(CEILING + 500), { maxRows: 10_000_000 });
      expect(r.rows).toHaveLength(CEILING);
      expect(r).toMatchObject({ truncated: true, totalRows: CEILING + 500 });
    });

    it.each([0, -5, 1.5, Number.NaN, Infinity, '5000', null, undefined, {}, [], true])(
      'falls back to 1000 for %p, which is not a positive whole number',
      async (bad) => {
        const r = await query('SELECT * FROM t', { maxRows: bad });
        expect(r.rows).toHaveLength(1000);
      },
    );
  });

  describe('memory follows the cap, not the table', () => {
    it('streams the result: it never asks the driver for every row at once', async () => {
      const prepare = Database.prototype.prepare;
      jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
        const stmt = prepare.call(this, sql) as Database.Statement;
        (stmt as unknown as { all: () => never }).all = () => {
          throw new Error('all() would load every row');
        };
        return stmt;
      } as typeof Database.prototype.prepare);
      const r = await query(rowsOf(20_000), { maxRows: 500 });
      expect(r.rows).toHaveLength(500);
      expect(r.totalRows).toBe(20_000);
    });

    it('counts a result far larger than the cap without keeping it', async () => {
      const r = await query(rowsOf(1_000_000));
      expect(r.rows).toHaveLength(1000);
      expect(r.totalRows).toBe(1_000_000);
    });
  });

  describe('other drivers', () => {
    const pgConfig = { baseUrl: 'postgres://u:p@localhost:5432/db', authType: 'CONNECTION_STRING' };
    const pgRows = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    const run = (options: Record<string, unknown>) =>
      engine.execute(pgConfig, { method: 'query', path: 'SELECT * FROM t' }, {}, options) as Promise<{
        rows: unknown[];
        truncated?: boolean;
      }>;

    beforeEach(() => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ rows: pgRows });
      // The SSRF guard resolves the host; this one is a literal for a mocked driver.
      jest.spyOn(engine as unknown as { assertSafeDbHost: () => Promise<void> }, 'assertSafeDbHost').mockResolvedValue();
    });

    it('applies the same default', async () => {
      expect((await run({})).rows).toHaveLength(1000);
    });

    it('applies the connector’s cap to the rows it loaded', async () => {
      const r = await run({ maxRows: 3000 });
      expect(r.rows).toHaveLength(3000);
      expect(r.truncated).toBe(true);
    });

    it('applies the ceiling too', async () => {
      mockQuery.mockResolvedValue({ rows: Array.from({ length: CEILING + 10 }, (_, i) => ({ id: i })) });
      expect((await run({ maxRows: 99_999_999 })).rows).toHaveLength(CEILING);
    });
  });
});
