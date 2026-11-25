import { useState } from 'react';
import { Icon } from '../Icon';
import EditValue from './EditValue';

export interface EditableArray {
  name: string;
  preview: (number | string | null)[];
}

export default function ArrayValueEditor({
  arrays,
  save,
}: {
  arrays: EditableArray[];
  save: (name: string, index: number, value: string) => Promise<unknown>;
}) {
  const [active, setActive] = useState(false);
  const [name, setName] = useState('');
  const [element, setElement] = useState('1');
  const array = arrays.find((item) => item.name === name) ?? arrays[0];
  const index = Number(element) - 1;
  const valid = Number.isSafeInteger(index) && index >= 0 && index < array.preview.length;
  if (!active)
    return (
      <div className="structured-controls">
        <button
          type="button"
          className="icon-button"
          title="Edit array value"
          aria-label="Edit array value"
          onClick={() => setActive(true)}
        >
          <Icon name="edit" />
        </button>
      </div>
    );
  return (
    <div className="array-editor">
      <div className="structured-controls">
        {array.name && (
          <select
            aria-label="Array"
            value={array.name}
            onChange={(event) => {
              setName(event.target.value);
              setElement('1');
            }}
          >
            {arrays.map(({ name }) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        )}
        <label>
          Element{' '}
          <input
            aria-label="Element number"
            type="number"
            min={1}
            max={array.preview.length}
            value={element}
            onChange={(event) => setElement(event.target.value)}
          />
        </label>
      </div>
      {valid ? (
        <EditValue
          key={`${array.name}:${index}`}
          label="Element value"
          value={array.preview[index] == null ? '' : String(array.preview[index])}
          onSave={(value) => save(array.name, index, value)}
          onClose={() => setActive(false)}
        />
      ) : (
        <button
          type="button"
          className="icon-button"
          title="Cancel edit"
          aria-label="Cancel edit"
          onClick={() => setActive(false)}
        >
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
