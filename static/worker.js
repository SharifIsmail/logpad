import SQLiteESMFactory from 'https://cdn.jsdelivr.net/gh/rhashimoto/wa-sqlite@v1.0.0/dist/wa-sqlite-async.mjs';
import { OPFSCoopSyncVFS } from 'https://cdn.jsdelivr.net/gh/rhashimoto/wa-sqlite@v1.0.0/src/examples/OPFSCoopSyncVFS.js';
import * as SQLite from 'https://cdn.jsdelivr.net/gh/rhashimoto/wa-sqlite@v1.0.0/src/sqlite-api.js';

let sqlite3, db;

// ---------------------------------------------------------------------------
// Core exec helper — runs SQL with optional positional bindings
// Returns array of row objects keyed by column name
// ---------------------------------------------------------------------------
async function exec(sql, bind = []) {
  const rows = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (bind.length) {
      bind.forEach((v, i) => sqlite3.bind(stmt, i + 1, v));
    }
    while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
      const row = {};
      for (let i = 0; i < sqlite3.column_count(stmt); i++) {
        row[sqlite3.column_name(stmt, i)] = sqlite3.column(stmt, i);
      }
      rows.push(row);
    }
  }
  return rows;
}

// Run a single INSERT/UPDATE/DELETE and return last_insert_rowid
async function run(sql, bind = []) {
  await exec(sql, bind);
  const [{ id }] = await exec('SELECT last_insert_rowid() AS id');
  return id;
}

// ---------------------------------------------------------------------------
// Schema init + migration
// ---------------------------------------------------------------------------
async function init_db() {
  // Detect if this is a fresh database or existing (pre-multi-table) database
  const existing = await exec(
    `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='tables'`
  );
  const hasTables = existing[0].cnt > 0;

  if (!hasTables) {
    // Check if old single-table schema exists
    const oldSchema = await exec(
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='columns'`
    );
    if (oldSchema[0].cnt > 0) {
      // Existing single-table database — run migration
      await _migrate_legacy_db();
    } else {
      // Fresh database — create all tables in final form
      await _create_fresh_schema();
    }
  }
  // else: already migrated, nothing to do
}

async function _create_fresh_schema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS tables (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
      deleted_at TEXT
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id      INTEGER NOT NULL REFERENCES tables(id),
      name          TEXT    NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_unique     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
      deleted_at    TEXT,
      UNIQUE(table_id, name)
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS cell_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id    INTEGER NOT NULL REFERENCES tables(id),
      row_id      TEXT    NOT NULL,
      column_id   INTEGER REFERENCES columns(id),
      sentinel    TEXT,
      value       TEXT,
      timestamp   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS foreign_keys (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      from_column_id INTEGER NOT NULL REFERENCES columns(id),
      to_table_id    INTEGER NOT NULL REFERENCES tables(id),
      created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
      deleted_at     TEXT
    )
  `);
  await _create_indexes();
}

async function _migrate_legacy_db() {
  await exec('BEGIN');
  try {
    // 1. Create tables registry
    await exec(`
      CREATE TABLE IF NOT EXISTS tables (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        deleted_at TEXT
      )
    `);
    // 2. Create default table to house existing data
    await exec(`INSERT OR IGNORE INTO tables (id, name) VALUES (1, 'Default')`);
    // 3. Rebuild columns table with new schema (old had UNIQUE(name) globally)
    await exec(`
      CREATE TABLE columns_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id      INTEGER NOT NULL REFERENCES tables(id),
        name          TEXT    NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        is_unique     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        deleted_at    TEXT,
        UNIQUE(table_id, name)
      )
    `);
    await exec(`
      INSERT INTO columns_new (id, table_id, name, display_order, created_at, deleted_at)
      SELECT id, 1, name, display_order, created_at, deleted_at FROM columns
    `);
    await exec(`DROP TABLE columns`);
    await exec(`ALTER TABLE columns_new RENAME TO columns`);
    // 4. Add table_id to cell_history
    await exec(`ALTER TABLE cell_history ADD COLUMN table_id INTEGER REFERENCES tables(id)`);
    await exec(`UPDATE cell_history SET table_id = 1 WHERE table_id IS NULL`);
    // 5. Create foreign_keys table
    await exec(`
      CREATE TABLE IF NOT EXISTS foreign_keys (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        from_column_id INTEGER NOT NULL REFERENCES columns(id),
        to_table_id    INTEGER NOT NULL REFERENCES tables(id),
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        deleted_at     TEXT
      )
    `);
    await exec('COMMIT');
  } catch (e) {
    await exec('ROLLBACK');
    throw e;
  }
  await _create_indexes();
}

async function _create_indexes() {
  await exec(`CREATE INDEX IF NOT EXISTS idx_cell_table_row  ON cell_history(table_id, row_id, column_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_cell_sentinel   ON cell_history(row_id, sentinel)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_cell_timestamp  ON cell_history(timestamp)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_fk_from_col     ON foreign_keys(from_column_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_fk_to_table     ON foreign_keys(to_table_id)`);
}

// ---------------------------------------------------------------------------
// Helper: column map for a table { colName -> { id, is_unique } }
// ---------------------------------------------------------------------------
async function _col_map_for_table(table_id) {
  const cols = await exec(
    `SELECT id, name, is_unique FROM columns WHERE table_id = ? AND deleted_at IS NULL`,
    [table_id]
  );
  const map = {};
  for (const c of cols) map[c.name] = { id: c.id, is_unique: c.is_unique };
  return map;
}

// Helper: FK map for a table { column_id -> to_table_id }
async function _get_fk_map_for_table(table_id) {
  const fks = await exec(`
    SELECT fk.from_column_id, fk.to_table_id
    FROM foreign_keys fk
    JOIN columns c ON c.id = fk.from_column_id
    WHERE c.table_id = ? AND fk.deleted_at IS NULL AND c.deleted_at IS NULL
  `, [table_id]);
  const map = {};
  for (const fk of fks) map[fk.from_column_id] = fk.to_table_id;
  return map;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
async function _check_uniqueness(table_id, column_id, col_name, value, excluding_row_id) {
  if (!value) return;
  const rows = await exec(`
    WITH latest AS (
      SELECT row_id, column_id, MAX(id) AS max_id
      FROM cell_history WHERE table_id = ? AND sentinel IS NULL
      GROUP BY row_id, column_id
    ),
    deleted_rows AS (
      SELECT row_id FROM cell_history
      WHERE table_id = ? AND sentinel = '__deleted__'
      GROUP BY row_id
      HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
             MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
    )
    SELECT ch.value
    FROM latest l
    JOIN cell_history ch ON ch.id = l.max_id
    WHERE l.column_id = ? AND ch.value = ?
      AND l.row_id != ?
      AND l.row_id NOT IN (SELECT row_id FROM deleted_rows)
    LIMIT 1
  `, [table_id, table_id, column_id, value, excluding_row_id]);
  if (rows.length > 0) {
    throw new Error(`Value "${value}" already exists in column "${col_name}" (unique constraint)`);
  }
}

async function _check_fk_exists(to_table_id, value, col_name) {
  if (!value) return;
  const rows = await exec(`
    WITH deleted_rows AS (
      SELECT row_id FROM cell_history
      WHERE table_id = ? AND sentinel = '__deleted__'
      GROUP BY row_id
      HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
             MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
    )
    SELECT row_id FROM cell_history
    WHERE table_id = ? AND sentinel = '__new__' AND row_id = ?
      AND row_id NOT IN (SELECT row_id FROM deleted_rows)
    LIMIT 1
  `, [to_table_id, to_table_id, value]);
  if (rows.length === 0) {
    throw new Error(
      `Value in column "${col_name}" does not reference a valid row in the linked table`
    );
  }
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------
async function get_tables() {
  return exec(
    `SELECT id, name, created_at FROM tables WHERE deleted_at IS NULL ORDER BY created_at, id`
  );
}

async function create_table({ name }) {
  name = name.trim();
  if (!name) throw new Error('Table name cannot be empty');
  const existing = await exec(
    `SELECT id FROM tables WHERE name = ? AND deleted_at IS NULL`, [name]
  );
  if (existing.length > 0) throw new Error(`Table "${name}" already exists`);
  const id = await run(`INSERT INTO tables (name) VALUES (?)`, [name]);
  return { id, name };
}

async function rename_table({ id, name }) {
  name = name.trim();
  if (!name) throw new Error('Table name cannot be empty');
  const conflict = await exec(
    `SELECT id FROM tables WHERE name = ? AND id != ? AND deleted_at IS NULL`, [name, id]
  );
  if (conflict.length > 0) throw new Error(`Table "${name}" already exists`);
  await exec(`UPDATE tables SET name = ? WHERE id = ? AND deleted_at IS NULL`, [name, id]);
  return { id, name };
}

async function delete_table({ id }) {
  // Check for live rows
  const liveRows = await exec(`
    WITH deleted_rows AS (
      SELECT row_id FROM cell_history
      WHERE table_id = ? AND sentinel = '__deleted__'
      GROUP BY row_id
      HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
             MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
    )
    SELECT COUNT(DISTINCT row_id) AS cnt
    FROM cell_history
    WHERE table_id = ? AND sentinel = '__new__'
      AND row_id NOT IN (SELECT row_id FROM deleted_rows)
  `, [id, id]);
  if (liveRows[0].cnt > 0) {
    throw new Error(`Cannot delete table: it still has ${liveRows[0].cnt} live row(s). Delete all rows first.`);
  }
  const now = `strftime('%Y-%m-%dT%H:%M:%f', 'now')`;
  // Soft-delete FK defs for this table's columns
  await exec(`
    UPDATE foreign_keys SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE deleted_at IS NULL
      AND from_column_id IN (SELECT id FROM columns WHERE table_id = ? AND deleted_at IS NULL)
  `, [id]);
  // Soft-delete columns
  await exec(
    `UPDATE columns SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE table_id = ? AND deleted_at IS NULL`,
    [id]
  );
  // Soft-delete table
  await exec(
    `UPDATE tables SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  return null;
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------
async function get_columns({ table_id }) {
  return exec(
    `SELECT id, name, display_order, is_unique, created_at
     FROM columns WHERE table_id = ? AND deleted_at IS NULL ORDER BY display_order, id`,
    [table_id]
  );
}

async function create_column({ table_id, name, is_unique = 0 }) {
  name = name.trim();
  if (!name) throw new Error('Column name cannot be empty');
  const [{ max_order }] = await exec(
    `SELECT COALESCE(MAX(display_order), -1) AS max_order FROM columns WHERE table_id = ? AND deleted_at IS NULL`,
    [table_id]
  );
  const display_order = max_order + 1;
  let id;
  try {
    id = await run(
      `INSERT INTO columns (table_id, name, display_order, is_unique) VALUES (?, ?, ?, ?)`,
      [table_id, name, display_order, is_unique]
    );
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      throw new Error(`Column "${name}" already exists in this table`);
    }
    throw e;
  }
  return { id, name, display_order, is_unique };
}

async function rename_column({ id, name }) {
  name = name.trim();
  if (!name) throw new Error('Column name cannot be empty');
  const [col] = await exec(`SELECT table_id FROM columns WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!col) throw new Error('Column not found');
  const conflict = await exec(
    `SELECT id FROM columns WHERE table_id = ? AND name = ? AND id != ? AND deleted_at IS NULL`,
    [col.table_id, name, id]
  );
  if (conflict.length > 0) throw new Error(`Column "${name}" already exists in this table`);
  await exec(`UPDATE columns SET name = ? WHERE id = ? AND deleted_at IS NULL`, [name, id]);
  return { id, name };
}

async function set_column_unique({ id, is_unique }) {
  const [col] = await exec(
    `SELECT table_id, name FROM columns WHERE id = ? AND deleted_at IS NULL`, [id]
  );
  if (!col) throw new Error('Column not found');

  if (is_unique) {
    // Check for existing duplicates
    const dupes = await exec(`
      WITH latest AS (
        SELECT row_id, column_id, MAX(id) AS max_id
        FROM cell_history WHERE table_id = ? AND sentinel IS NULL
        GROUP BY row_id, column_id
      ),
      deleted_rows AS (
        SELECT row_id FROM cell_history
        WHERE table_id = ? AND sentinel = '__deleted__'
        GROUP BY row_id
        HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
               MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
      )
      SELECT ch.value, COUNT(*) AS cnt
      FROM latest l
      JOIN cell_history ch ON ch.id = l.max_id
      WHERE l.column_id = ?
        AND ch.value IS NOT NULL AND ch.value != ''
        AND l.row_id NOT IN (SELECT row_id FROM deleted_rows)
      GROUP BY ch.value
      HAVING cnt > 1
      LIMIT 1
    `, [col.table_id, col.table_id, id]);
    if (dupes.length > 0) {
      throw new Error(
        `Cannot enable unique constraint on "${col.name}": column already has duplicate values`
      );
    }
  }
  await exec(`UPDATE columns SET is_unique = ? WHERE id = ? AND deleted_at IS NULL`, [is_unique ? 1 : 0, id]);
  return { id, is_unique: is_unique ? 1 : 0 };
}

async function delete_column({ id }) {
  // Soft-delete FK defs for this column
  await exec(
    `UPDATE foreign_keys SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
     WHERE from_column_id = ? AND deleted_at IS NULL`,
    [id]
  );
  await exec(
    `UPDATE columns SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  return null;
}

// ---------------------------------------------------------------------------
// Row reconstruction SQL (scoped to table_id)
// ---------------------------------------------------------------------------
function _reconstruction_sql() {
  return `
WITH latest AS (
  SELECT row_id, column_id, MAX(id) AS max_id
  FROM cell_history
  WHERE table_id = ? AND sentinel IS NULL
  GROUP BY row_id, column_id
),
deleted_rows AS (
  SELECT row_id
  FROM cell_history
  WHERE table_id = ? AND sentinel = '__deleted__'
  GROUP BY row_id
  HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
         MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
)
SELECT
  l.row_id,
  c.id   AS column_id,
  c.name AS column_name,
  c.display_order,
  c.is_unique,
  ch.value,
  ch.timestamp AS last_modified
FROM latest l
JOIN cell_history ch ON ch.id = l.max_id
JOIN columns c       ON c.id  = l.column_id
WHERE c.deleted_at IS NULL
  AND l.row_id NOT IN (SELECT row_id FROM deleted_rows)
ORDER BY l.row_id, c.display_order
`;
}

function _empty_rows_sql() {
  return `
SELECT DISTINCT ch.row_id, ch.timestamp
FROM cell_history ch
WHERE ch.table_id = ?
  AND ch.sentinel = '__new__'
  AND ch.row_id NOT IN (SELECT row_id FROM cell_history WHERE table_id = ? AND sentinel IS NULL)
  AND ch.row_id NOT IN (
    SELECT row_id FROM cell_history
    WHERE table_id = ? AND sentinel = '__deleted__'
    GROUP BY row_id
    HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
           MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
  )
`;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------
async function get_rows({ table_id }) {
  const raw = await exec(_reconstruction_sql(), [table_id, table_id]);
  const rowMap = {};

  for (const record of raw) {
    const rid = record.row_id;
    if (!rowMap[rid]) {
      rowMap[rid] = { row_id: rid, cells: {}, _last_modified: record.last_modified };
    }
    rowMap[rid].cells[record.column_name] = record.value;
    if (record.last_modified > rowMap[rid]._last_modified) {
      rowMap[rid]._last_modified = record.last_modified;
    }
  }

  const emptyRows = await exec(_empty_rows_sql(), [table_id, table_id, table_id]);
  for (const record of emptyRows) {
    if (!rowMap[record.row_id]) {
      rowMap[record.row_id] = { row_id: record.row_id, cells: {}, _last_modified: record.timestamp };
    }
  }

  return Object.values(rowMap);
}

async function create_row({ table_id, cells = {} }) {
  const colMap = await _col_map_for_table(table_id);
  const fkMap  = await _get_fk_map_for_table(table_id);
  const row_id = crypto.randomUUID();

  // Validate before writing anything
  for (const [colName, value] of Object.entries(cells)) {
    const col = colMap[colName];
    if (!col || !value) continue;
    if (col.is_unique) {
      await _check_uniqueness(table_id, col.id, colName, value, row_id);
    }
    if (fkMap[col.id] !== undefined) {
      await _check_fk_exists(fkMap[col.id], value, colName);
    }
  }

  // Write __new__ sentinel
  await exec(
    `INSERT INTO cell_history (table_id, row_id, column_id, sentinel, value) VALUES (?, ?, NULL, '__new__', NULL)`,
    [table_id, row_id]
  );
  // Write initial cells
  for (const [colName, value] of Object.entries(cells)) {
    const col = colMap[colName];
    if (col && value) {
      await exec(
        `INSERT INTO cell_history (table_id, row_id, column_id, sentinel, value) VALUES (?, ?, ?, NULL, ?)`,
        [table_id, row_id, col.id, value]
      );
    }
  }
  return { row_id };
}

async function update_row({ table_id, row_id, cells }) {
  const colMap = await _col_map_for_table(table_id);
  const fkMap  = await _get_fk_map_for_table(table_id);
  let inserted = false;

  // Validate first
  for (const [colName, value] of Object.entries(cells)) {
    const col = colMap[colName];
    if (col === undefined) continue;
    if (value && col.is_unique) {
      await _check_uniqueness(table_id, col.id, colName, value, row_id);
    }
    if (value && fkMap[col.id] !== undefined) {
      await _check_fk_exists(fkMap[col.id], value, colName);
    }
  }

  // Write
  for (const [colName, value] of Object.entries(cells)) {
    const col = colMap[colName];
    if (col === undefined) continue;
    await exec(
      `INSERT INTO cell_history (table_id, row_id, column_id, sentinel, value) VALUES (?, ?, ?, NULL, ?)`,
      [table_id, row_id, col.id, value]
    );
    inserted = true;
  }
  if (!inserted) throw new Error('No valid columns found in update');
  return { row_id };
}

async function delete_row({ table_id, row_id }) {
  // Check all inbound FK references to this table
  const inbound = await exec(`
    SELECT fk.from_column_id, c.table_id AS from_table_id, t.name AS from_table_name
    FROM foreign_keys fk
    JOIN columns c ON c.id  = fk.from_column_id
    JOIN tables  t ON t.id  = c.table_id
    WHERE fk.to_table_id = ? AND fk.deleted_at IS NULL
      AND c.deleted_at IS NULL AND t.deleted_at IS NULL
  `, [table_id]);

  for (const fk of inbound) {
    const refs = await exec(`
      WITH latest AS (
        SELECT row_id, column_id, MAX(id) AS max_id
        FROM cell_history WHERE table_id = ? AND sentinel IS NULL
        GROUP BY row_id, column_id
      ),
      deleted_rows AS (
        SELECT row_id FROM cell_history
        WHERE table_id = ? AND sentinel = '__deleted__'
        GROUP BY row_id
        HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
               MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
      )
      SELECT COUNT(*) AS cnt
      FROM latest l
      JOIN cell_history ch ON ch.id = l.max_id
      WHERE l.column_id = ? AND ch.value = ?
        AND l.row_id NOT IN (SELECT row_id FROM deleted_rows)
    `, [fk.from_table_id, fk.from_table_id, fk.from_column_id, row_id]);

    if (refs[0].cnt > 0) {
      throw new Error(
        `Cannot delete: ${refs[0].cnt} row(s) in "${fk.from_table_name}" reference this row`
      );
    }
  }

  await exec(
    `INSERT INTO cell_history (table_id, row_id, column_id, sentinel, value) VALUES (?, ?, NULL, '__deleted__', '1')`,
    [table_id, row_id]
  );
  return null;
}

async function get_row_history({ table_id, row_id }) {
  const raw = await exec(`
    SELECT ch.id, ch.row_id, ch.sentinel, c.name AS column_name, c.id AS column_id, ch.value, ch.timestamp
    FROM cell_history ch
    LEFT JOIN columns c ON c.id = ch.column_id
    WHERE ch.table_id = ? AND ch.row_id = ?
    ORDER BY ch.timestamp ASC, ch.id ASC
  `, [table_id, row_id]);
  return raw.map(entry => {
    const sentinel = entry.sentinel;
    let description;
    if (sentinel === '__deleted__') {
      description = entry.value === '1' ? 'Row deleted' : 'Row restored';
    } else if (sentinel === '__new__') {
      description = 'Row created';
    } else {
      const col = entry.column_name ?? '(deleted column)';
      const val = entry.value === null ? '(cleared)' : `"${entry.value}"`;
      description = `${col} \u2192 ${val}`;
    }
    return { ...entry, description };
  });
}

// ---------------------------------------------------------------------------
// FK helpers
// ---------------------------------------------------------------------------
async function get_foreign_keys({ table_id }) {
  return exec(`
    SELECT fk.id, fk.from_column_id, c.name AS from_column_name,
           fk.to_table_id, t.name AS to_table_name
    FROM foreign_keys fk
    JOIN columns c ON c.id  = fk.from_column_id
    JOIN tables  t ON t.id  = fk.to_table_id
    WHERE c.table_id = ? AND fk.deleted_at IS NULL
      AND c.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY fk.created_at
  `, [table_id]);
}

async function create_foreign_key({ from_column_id, to_table_id }) {
  // Validate from_column exists
  const [fromCol] = await exec(
    `SELECT id, table_id FROM columns WHERE id = ? AND deleted_at IS NULL`, [from_column_id]
  );
  if (!fromCol) throw new Error('Column not found');
  // Prevent self-reference
  if (fromCol.table_id === to_table_id) {
    throw new Error('A table cannot reference itself');
  }
  // Validate to_table exists
  const [toTable] = await exec(
    `SELECT id FROM tables WHERE id = ? AND deleted_at IS NULL`, [to_table_id]
  );
  if (!toTable) throw new Error('Target table not found');
  // Check only one FK per column
  const existing = await exec(
    `SELECT id FROM foreign_keys WHERE from_column_id = ? AND deleted_at IS NULL`, [from_column_id]
  );
  if (existing.length > 0) throw new Error('Column already has a foreign key defined');

  const id = await run(
    `INSERT INTO foreign_keys (from_column_id, to_table_id) VALUES (?, ?)`,
    [from_column_id, to_table_id]
  );
  return { id, from_column_id, to_table_id };
}

async function delete_foreign_key({ id }) {
  await exec(
    `UPDATE foreign_keys SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  return null;
}

async function get_fk_options({ column_id }) {
  // Find which table this FK points to
  const [fkDef] = await exec(
    `SELECT to_table_id FROM foreign_keys WHERE from_column_id = ? AND deleted_at IS NULL`,
    [column_id]
  );
  if (!fkDef) return [];

  const to_table_id = fkDef.to_table_id;

  const rows = await exec(`
    WITH latest AS (
      SELECT row_id, column_id, MAX(id) AS max_id
      FROM cell_history WHERE table_id = ? AND sentinel IS NULL
      GROUP BY row_id, column_id
    ),
    deleted_rows AS (
      SELECT row_id FROM cell_history
      WHERE table_id = ? AND sentinel = '__deleted__'
      GROUP BY row_id
      HAVING MAX(CASE WHEN value = '1' THEN id ELSE 0 END) >
             MAX(CASE WHEN value = '0' THEN id ELSE 0 END)
    ),
    live_rows AS (
      SELECT DISTINCT row_id FROM cell_history
      WHERE table_id = ? AND sentinel = '__new__'
        AND row_id NOT IN (SELECT row_id FROM deleted_rows)
    ),
    ranked AS (
      SELECT l.row_id, ch.value,
             ROW_NUMBER() OVER (PARTITION BY l.row_id ORDER BY c.display_order, c.id) AS rn
      FROM latest l
      JOIN cell_history ch ON ch.id = l.max_id
      JOIN columns c ON c.id = l.column_id
      WHERE l.row_id IN (SELECT row_id FROM live_rows)
        AND ch.value IS NOT NULL AND ch.value != ''
        AND c.deleted_at IS NULL
    )
    SELECT lr.row_id, r.value AS label
    FROM live_rows lr
    LEFT JOIN ranked r ON r.row_id = lr.row_id AND r.rn = 1
    ORDER BY lr.row_id
  `, [to_table_id, to_table_id, to_table_id]);

  return rows;
}

// ---------------------------------------------------------------------------
// Message dispatcher
// ---------------------------------------------------------------------------
const handlers = {
  // Table
  get_tables,
  create_table,
  rename_table,
  delete_table,
  // Column
  get_columns,
  create_column,
  rename_column,
  set_column_unique,
  delete_column,
  // Row
  get_rows,
  create_row,
  update_row,
  delete_row,
  get_row_history,
  // FK
  get_foreign_keys,
  create_foreign_key,
  delete_foreign_key,
  get_fk_options,
};

self.onmessage = async ({ data: { id, type, payload } }) => {
  try {
    const result = await handlers[type](payload);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  try {
    const module = await SQLiteESMFactory();
    sqlite3 = SQLite.Factory(module);
    const vfs = await OPFSCoopSyncVFS.create('appendonly', module);
    sqlite3.vfs_register(vfs, true);
    db = await sqlite3.open_v2('appendonly.db');
    await init_db();
    self.postMessage({ type: 'ready' });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
})();
