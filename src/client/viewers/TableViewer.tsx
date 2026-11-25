import { useState, type KeyboardEvent } from 'react';
import type { ViewerProps } from '../../shared/types';
import { canSaveHostFile, saveHostFile } from '../backend';
import { Icon } from '../Icon';
import EditValue from './EditValue';
import { useStructuredPreview } from './use-structured-preview';
import type { TablePreview } from './structured';
import './structured.css';

export default function TableViewer({ artifact, onShareItem, sharedItemId }: ViewerProps) {
  const { data, loading, error, inspect, edit } = useStructuredPreview<TablePreview>(artifact);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState('');
  const [column, setColumn] = useState(-1);
  const [editing, setEditing] = useState(false);
  if (!data)
    return (
      <div className="empty" role={error ? 'alert' : 'status'}>
        {error || 'Loading table…'}
      </div>
    );

  const query = filter.trim().toLowerCase();
  const rows = data.rows
    .map((values, index) => ({ values, index: data.offset + index }))
    .filter(({ values }) => !query || values.some((cell) => cell?.toLowerCase().includes(query)));
  const dataset = data.table ? `table-${data.tables.indexOf(data.table)}` : 'parquet';
  const selectedRow = rows.find(({ index }) => `${dataset}:${index}` === selected);
  const editable =
    canSaveHostFile(artifact) && selectedRow
      ? data.edits?.[selectedRow.index - data.offset]
      : undefined;
  const editableColumns = editable?.types.flatMap((type, index) => (type ? [index] : [])) ?? [];
  const activeColumn = editableColumns.includes(column) ? column : editableColumns[0];
  const select = (id: string, cell = -1) => {
    setSelected(id);
    setColumn(cell);
    setEditing(false);
  };
  const share = (index: number, values: (string | null)[]) => {
    const id = `${dataset}:${index}`;
    select(id, id === selected ? column : -1);
    onShareItem?.({
      id,
      label: `${data.table ? data.table + ' · ' : ''}Row ${index + 1}`.slice(0, 256),
      details: JSON.stringify(data.columns.map(({ name }, j) => [name, values[j]])).slice(0, 4000),
    });
  };
  const rowKey = (event: KeyboardEvent, id: string, index: number, values: (string | null)[]) => {
    if (event.key === ' ') {
      event.preventDefault();
      select(id);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (selected === id) share(index, values);
      else select(id);
    }
  };

  return (
    <div className="structured-view" onDoubleClick={(event) => event.stopPropagation()}>
      <div className="structured-controls">
        {data.table && (
          <select
            aria-label="Table"
            value={data.table}
            disabled={loading}
            onChange={(event) => {
              select('');
              setFilter('');
              inspect({ table: event.target.value });
            }}
          >
            {data.tables.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        )}
        <input
          type="search"
          aria-label="Filter visible rows"
          placeholder="Filter visible rows"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="structured-pagination" role="group" aria-label="Pages">
          <button
            className="icon-button previous"
            title="Previous page"
            aria-label="Previous page"
            disabled={loading || !data.offset}
            onClick={() => inspect({ table: data.table, offset: Math.max(0, data.offset - 64) })}
          >
            <Icon name="chevron" />
          </button>
          <span className="preview-note">
            {data.rows.length ? `${data.offset + 1}–${data.offset + data.rows.length}` : '0'}
          </span>
          <button
            className="icon-button"
            title="Next page"
            aria-label="Next page"
            disabled={loading || !data.more}
            onClick={() => inspect({ table: data.table, offset: data.offset + data.rows.length })}
          >
            <Icon name="chevron" />
          </button>
        </div>
        {activeColumn !== undefined && !editing && (
          <button
            type="button"
            className="icon-button"
            title="Edit cell"
            aria-label="Edit cell"
            disabled={loading}
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" />
          </button>
        )}
      </div>
      {editing && editable && selectedRow && data.table && activeColumn !== undefined && (
        <div className="array-editor">
          <div className="structured-controls">
            <select
              aria-label="Column"
              value={activeColumn}
              onChange={(event) => setColumn(Number(event.target.value))}
            >
              {editableColumns.map((index) => (
                <option key={index} value={index}>
                  {data.columns[index].name}
                </option>
              ))}
            </select>
          </div>
          <EditValue
            key={`${selected}:${activeColumn}`}
            label="Cell value"
            value={selectedRow.values[activeColumn] ?? ''}
            onClose={() => setEditing(false)}
            onSave={async (value) => {
              const edited = await edit({
                table: {
                  table: data.table!,
                  column: data.columns[activeColumn].name,
                  rowId: editable.rowId,
                  value,
                },
              });
              await saveHostFile(artifact, edited);
            }}
          />
        </div>
      )}
      {error && (
        <div className="preview-note" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="preview-note" role="status">
          Loading rows…
        </div>
      )}
      {data.columns.length ? (
        <div className="structured-scroll" tabIndex={0} aria-label="Table preview">
          <table className="structured-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                {data.columns.map(({ name, type }, index) => (
                  <th key={index} scope="col" title={type}>
                    {name}
                    {type && <small>{type}</small>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ values, index }) => {
                const id = `${dataset}:${index}`;
                return (
                  <tr
                    key={id}
                    tabIndex={0}
                    data-selected={id === selected || undefined}
                    data-shared={id === sharedItemId || undefined}
                    onClick={() => select(id)}
                    onKeyDown={(event) => rowKey(event, id, index, values)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      share(index, values);
                    }}
                  >
                    <th scope="row">
                      {index + 1}
                      {id === sharedItemId && <Icon name="check" />}
                    </th>
                    {values.map((value, j) => (
                      <td
                        key={j}
                        title={value ?? undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          select(id, j);
                        }}
                      >
                        {value ?? <em>NULL</em>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <div className="empty">{query ? 'No matching rows' : 'No rows'}</div>}
        </div>
      ) : (
        <div className="empty">No tables</div>
      )}
      {data.note && <div className="preview-note">{data.note}</div>}
    </div>
  );
}
