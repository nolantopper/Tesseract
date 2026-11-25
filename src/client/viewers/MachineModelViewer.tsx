import { useState } from 'react';
import type { ViewerProps } from '../../shared/types';
import { canSaveHostFile, saveHostFile } from '../backend';
import { Icon } from '../Icon';
import EditValue from './EditValue';
import { useStructuredPreview } from './use-structured-preview';
import type { MachineModel, ModelItem } from './structured';
import './structured.css';

const pageSize = 100;
export default function MachineModelViewer({ artifact, onShareItem, sharedItemId }: ViewerProps) {
  const { data, error, edit } = useStructuredPreview<MachineModel>(artifact);
  const [graph, setGraph] = useState(0);
  const [section, setSection] = useState('');
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState(false);
  if (!data)
    return (
      <div className="empty" role={error ? 'alert' : 'status'}>
        {error || 'Loading model…'}
      </div>
    );

  const current = data.graphs[graph];
  const groups = [
    { name: 'Operators', items: current?.operators ?? [] },
    { name: 'Tensors', items: current?.tensors ?? [] },
    { name: 'Metadata', items: data.metadata },
  ].filter(({ items }) => items.length > 0);
  const group = groups.find(({ name }) => name === section) ?? groups[0];
  const query = filter.toLowerCase().trim();
  const items =
    group?.items.filter(
      ({ label, type }) =>
        !query || label.toLowerCase().includes(query) || type?.toLowerCase().includes(query),
    ) ?? [];
  const item = items.find(({ id }) => id === selected);
  const canEdit = item?.canEdit && artifact.size <= 64 * 1024 * 1024 && canSaveHostFile(artifact);
  const select = (id: string) => {
    setSelected(id);
    setEditing(false);
  };
  const share = (row: ModelItem) => {
    select(row.id);
    onShareItem?.({
      id: row.id,
      label: row.label || row.id,
      details: JSON.stringify({
        graph: current?.name,
        type: row.type,
        shape: row.shape,
        inputs: row.inputs,
        outputs: row.outputs,
        description: row.details,
      }).slice(0, 4000),
    });
  };

  return (
    <div className="structured-view" onDoubleClick={(event) => event.stopPropagation()}>
      <div className="structured-controls">
        {data.graphs.length > 1 && (
          <select
            aria-label="Graph"
            value={graph}
            onChange={(event) => {
              setGraph(Number(event.target.value));
              setOffset(0);
              select('');
            }}
          >
            {data.graphs.map(({ name }, index) => (
              <option value={index} key={index}>
                {name}
              </option>
            ))}
          </select>
        )}
        {groups.length > 1 && (
          <select
            aria-label="Model section"
            value={group?.name}
            onChange={(event) => {
              setSection(event.target.value);
              setOffset(0);
              select('');
            }}
          >
            {groups.map(({ name, items }) => (
              <option key={name} value={name}>
                {name} · {items.length}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          aria-label="Filter model items"
          placeholder="Filter"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setOffset(0);
          }}
        />
        {items.length > pageSize && (
          <div className="structured-pagination" role="group" aria-label="Pages">
            <button
              className="icon-button previous"
              title="Previous page"
              aria-label="Previous page"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              <Icon name="chevron" />
            </button>
            <span className="preview-note">
              {offset + 1}–{Math.min(offset + pageSize, items.length)}
            </span>
            <button
              className="icon-button"
              title="Next page"
              aria-label="Next page"
              disabled={offset + pageSize >= items.length}
              onClick={() => setOffset(offset + pageSize)}
            >
              <Icon name="chevron" />
            </button>
          </div>
        )}
        {canEdit && !editing && (
          <button
            type="button"
            className="icon-button"
            title="Edit description"
            aria-label="Edit description"
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" />
          </button>
        )}
      </div>
      {editing && canEdit && item && (
        <EditValue
          label="Description"
          value={item.details ?? ''}
          onClose={() => setEditing(false)}
          onSave={async (description) => {
            const bytes = await edit({ description });
            await saveHostFile(artifact, bytes);
          }}
        />
      )}
      <div className="structured-scroll" tabIndex={0} aria-label="Model inspection">
        {items.length ? (
          <table className="structured-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">{group?.name === 'Metadata' ? 'Value' : 'Type'}</th>
                {group?.name === 'Tensors' && <th scope="col">Shape</th>}
              </tr>
            </thead>
            <tbody>
              {items.slice(offset, offset + pageSize).map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  data-selected={selected === row.id || undefined}
                  data-shared={sharedItemId === row.id || undefined}
                  onClick={() => select(row.id)}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    share(row);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === ' ') {
                      event.preventDefault();
                      select(row.id);
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (selected === row.id) share(row);
                      else select(row.id);
                    }
                  }}
                >
                  <th scope="row" title={row.label}>
                    {row.label}
                    {sharedItemId === row.id && <Icon name="check" />}
                  </th>
                  <td>{group?.name === 'Metadata' ? row.details : row.type}</td>
                  {group?.name === 'Tensors' && <td>{row.shape || '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{query ? 'No matching items' : 'No model items'}</div>
        )}
      </div>
      {item && (item.inputs?.length || item.outputs?.length || item.details) ? (
        <dl className="structured-detail">
          {item.inputs?.length ? (
            <>
              <dt>Inputs</dt>
              <dd>{item.inputs.join(', ')}</dd>
            </>
          ) : null}
          {item.outputs?.length ? (
            <>
              <dt>Outputs</dt>
              <dd>{item.outputs.join(', ')}</dd>
            </>
          ) : null}
          {item.details && (
            <>
              <dt>Details</dt>
              <dd>{item.details}</dd>
            </>
          )}
        </dl>
      ) : null}
      {data.note && <div className="preview-note">{data.note}</div>}
    </div>
  );
}
