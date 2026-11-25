import initSqlJs from 'sql.js/dist/sql-wasm-inline.js';
import type { Database } from 'sql.js';
import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
} from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { decompress } from 'fzstd';
import type { SqliteCellEdit, StructuredRequest, TablePreview } from './structured';
import { parseNumericEdit } from '../../shared/numeric-edit';

const pageSize = 64;
const columnLimit = 64;
const rangeBytes = 64 * 1024 * 1024;
const sqliteMagic = 'SQLite format 3\0';
const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';

async function openSqlite(file: AsyncBuffer) {
  if (file.byteLength > rangeBytes) throw new Error('SQLite preview limit is 64 MiB.');
  const data = new Uint8Array(await file.slice(0));
  if (new TextDecoder().decode(data.subarray(0, 16)) !== sqliteMagic)
    throw new Error('Invalid SQLite database.');
  const SQL = await initSqlJs({ useOldExtensionFunctions: false });
  const db = new SQL.Database(data);
  try {
    db.run('PRAGMA trusted_schema = OFF;');
    return { db, standalone: data[18] === 1 && data[19] === 1 };
  } catch (error) {
    db.close();
    throw error;
  }
}

function rowIdentity(db: Database, table: string) {
  const properties = db.exec(
    'SELECT wr FROM pragma_table_list WHERE "schema" = \'main\' AND "type" = \'table\' AND name = ?',
    [table],
  )[0]?.values[0];
  if (!properties || properties[0] !== 0) return;
  const columns =
    db.exec('SELECT name, pk, hidden FROM pragma_table_xinfo(?)', [table])[0]?.values ?? [];
  const names = new Set(columns.map(([name]) => String(name).toLowerCase()));
  const alias = ['rowid', '_rowid_', 'oid'].find((candidate) => !names.has(candidate));
  if (
    !alias ||
    db.exec("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?", [table]).length
  )
    return;
  return {
    alias: quote(alias),
    editable: new Set(
      columns.filter(([, pk, hidden]) => pk === 0 && hidden === 0).map(([name]) => String(name)),
    ),
  };
}

function editableStorage(column: string) {
  return `CASE WHEN typeof(${column}) IN ('integer', 'real') THEN typeof(${column})
      WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= 512
        AND instr(${column}, char(0)) = 0 THEN 'text' ELSE NULL END`;
}

export async function editSqliteCell(file: AsyncBuffer, edit: SqliteCellEdit) {
  const { db, standalone } = await openSqlite(file);
  try {
    if (!standalone) throw new Error('SQLite files using WAL cannot be edited.');
    const identity = rowIdentity(db, edit.table);
    if (!identity || !identity.editable.has(edit.column))
      throw new Error('This cell cannot be edited.');
    parseNumericEdit(edit.rowId, 'i', 8);
    const table = quote(edit.table);
    const column = quote(edit.column);
    const row = `${identity.alias} = CAST(? AS INTEGER)`;
    const where = `FROM main.${table} WHERE ${row}`;
    const storageQuery = () =>
      db.exec(`SELECT ${editableStorage(column)} ${where}`, [edit.rowId])[0]?.values[0]?.[0];
    const storage = storageQuery();
    let assignment: string;
    let value: string | number;
    if (storage === 'integer') {
      assignment = 'CAST(? AS INTEGER)';
      value = String(parseNumericEdit(edit.value, 'i', 8));
    } else if (storage === 'real') {
      assignment = 'CAST(? AS REAL)';
      value = Number(parseNumericEdit(edit.value, 'f', 8));
    } else if (
      storage === 'text' &&
      new TextEncoder().encode(edit.value).length <= 512 &&
      !edit.value.includes('\0')
    ) {
      assignment = '?';
      value = edit.value;
    } else {
      throw new Error('This cell needs text up to 512 bytes or a valid numeric value.');
    }
    db.run('PRAGMA foreign_keys = ON;');
    db.run(`UPDATE main.${table} SET ${column} = ${assignment} WHERE ${row}`, [value, edit.rowId]);
    if (db.getRowsModified() !== 1 || storageQuery() !== storage)
      throw new Error('The edit would change the cell’s data type.');
    if (db.exec('SELECT total_changes()')[0]?.values[0]?.[0] !== 1)
      throw new Error('The edit would change other rows through a foreign key.');
    return db.export();
  } finally {
    db.close();
  }
}

export function previewValue(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return `[${value.length.toLocaleString()} bytes]`;
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid date';
  if (typeof value === 'object') {
    return JSON.stringify(summarize(value)).slice(0, 512);
  }
  return String(value).slice(0, 512);
}

function summarize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value !== 'object') return previewValue(value);
  if (value instanceof Uint8Array || value instanceof Date) return previewValue(value);
  if (depth >= 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => summarize(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 16)
      .map(([key, entry]) => [key.slice(0, 128), summarize(entry, depth + 1)]),
  );
}

export class TableReader {
  private db?: Database;
  private standalone = false;
  private parquet?: FileMetaData;

  async sqlite(file: AsyncBuffer, { table, offset = 0 }: StructuredRequest): Promise<TablePreview> {
    if (!this.db) {
      const { db, standalone } = await openSqlite(file);
      this.db = db;
      this.standalone = standalone;
      this.db.run('PRAGMA query_only = ON;');
    }
    const db = this.db;
    const tables = (
      db.exec(`SELECT name FROM pragma_table_list WHERE "schema" = 'main'
      AND type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 500`)[0]?.values ?? []
    ).map(([name]) => String(name));
    if (!tables.length) return { tables, columns: [], rows: [], offset: 0, more: false };
    const selected = table && tables.includes(table) ? table : tables[0];
    const schema =
      db.exec('SELECT name, type FROM pragma_table_info(?) ORDER BY cid LIMIT ?', [
        selected,
        columnLimit + 1,
      ])[0]?.values ?? [];
    const columns = schema
      .slice(0, columnLimit)
      .map(([name, type]) => ({ name: String(name), type: String(type) }));
    const projections = columns
      .map(({ name }) => {
        const column = quote(name);
        return `CASE WHEN typeof(${column}) = 'blob' THEN printf('[%d bytes]', length(${column}))
        WHEN typeof(${column}) = 'text' THEN substr(${column}, 1, 512)
        WHEN typeof(${column}) = 'integer' THEN CAST(${column} AS TEXT) ELSE ${column} END`;
      })
      .join(', ');
    const rows: TablePreview['rows'] = [];
    const edits: TablePreview['edits'] = [];
    const identity = this.standalone ? rowIdentity(db, selected) : undefined;
    const editProjections = identity
      ? [
          `CAST(${identity.alias} AS TEXT)`,
          ...columns.map(({ name }) =>
            identity.editable.has(name) ? editableStorage(quote(name)) : 'NULL',
          ),
        ].join(', ')
      : '';
    const query = db.prepare(`SELECT ${projections}${identity ? ', ' + editProjections : ''}
      FROM main.${quote(selected)} ${identity ? 'ORDER BY ' + identity.alias : ''} LIMIT ? OFFSET ?`);
    try {
      query.bind([pageSize + 1, offset]);
      while (query.step()) {
        const values = query.get().map(previewValue);
        rows.push(values.slice(0, columns.length));
        if (identity) {
          const [rowId, ...types] = values.slice(columns.length);
          edits.push({ rowId: rowId!, types });
        }
      }
    } finally {
      query.free();
    }
    return {
      tables,
      table: selected,
      columns,
      rows: rows.slice(0, pageSize),
      edits: identity ? edits.slice(0, pageSize) : undefined,
      offset,
      more: rows.length > pageSize,
      note: schema.length > columnLimit ? `First ${columnLimit} columns` : undefined,
    };
  }

  async parquetPage(file: AsyncBuffer, { offset = 0 }: StructuredRequest): Promise<TablePreview> {
    if (!this.parquet) {
      if (file.byteLength < 12) throw new Error('Invalid Parquet file.');
      const footer = new DataView(await file.slice(file.byteLength - 8));
      if (footer.getUint32(0, true) > 16 * 1024 * 1024)
        throw new Error('Parquet metadata exceeds the 16 MiB limit.');
      this.parquet = await parquetMetadataAsync(file, {
        initialFetchSize: 64 * 1024,
        geoparquet: false,
      });
    }
    const metadata = this.parquet;
    const schema = parquetSchema(metadata).children;
    const columns = schema.slice(0, columnLimit).map(({ element }) => ({
      name: element.name,
      type: element.type ?? 'Group',
    }));
    const count = Number(metadata.num_rows);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Parquet row count.');
    const end = Math.min(offset + pageSize, count);
    const rows: TablePreview['rows'] = [];
    if (end > offset && columns.length) {
      let row = 0;
      let expanded = 0n;
      for (const group of metadata.row_groups) {
        const next = row + Number(group.num_rows);
        if (!Number.isSafeInteger(next) || next < row)
          throw new Error('Invalid Parquet row group.');
        if (row < end && next > offset) {
          for (const column of group.columns) {
            if (column.file_path) throw new Error('External Parquet column files are unsupported.');
            const size = column.meta_data?.total_uncompressed_size;
            if (size === undefined || size < 0n) throw new Error('Invalid Parquet column size.');
            expanded += size;
          }
        }
        if (expanded > BigInt(rangeBytes))
          throw new Error('Parquet row groups exceed the 64 MiB decode limit.');
        row = next;
      }
      let decoded = 0;
      const guarded: Compressors = Object.fromEntries(
        Object.entries(compressors).map(([codec, decode]) => [
          codec,
          (input: Uint8Array, length: number) => {
            if (!Number.isSafeInteger(length) || length < 0 || (decoded += length) > rangeBytes)
              throw new Error('Parquet pages exceed the 64 MiB decode limit.');
            return codec === 'ZSTD'
              ? decompress(input, new Uint8Array(length))
              : decode(input, length);
          },
        ]),
      );
      await parquetRead({
        file,
        metadata,
        columns: columns.map(({ name }) => name),
        rowStart: offset,
        rowEnd: end,
        compressors: guarded,
        geoparquet: false,
        onComplete: (entries) => {
          for (const entry of entries) rows.push(entry.map(previewValue));
        },
      });
    }
    return {
      tables: [],
      columns,
      rows,
      offset,
      more: end < count,
      note: schema.length > columnLimit ? `First ${columnLimit} columns` : undefined,
    };
  }
}
