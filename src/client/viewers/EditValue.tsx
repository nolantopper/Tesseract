import { useState } from 'react';
import { Icon } from '../Icon';
import './structured.css';

export default function EditValue({
  label,
  value,
  multiline,
  onSave,
  onClose,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = () => {
    if (saving || draft === value) return;
    setSaving(true);
    setError('');
    void onSave(draft)
      .then(onClose)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : 'Couldn’t save the edit.');
        setSaving(false);
      });
  };
  const field = multiline ? (
    <textarea
      aria-label={label}
      value={draft}
      disabled={saving}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
    />
  ) : (
    <input
      aria-label={label}
      value={draft}
      disabled={saving}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
  return (
    <div
      className={`edit-value${multiline ? ' edit-value-document' : ''}`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {field}
      <div className="edit-value-actions">
        <button
          type="button"
          className="icon-button"
          title="Save file"
          aria-label="Save file"
          disabled={saving || draft === value}
          onClick={save}
        >
          <Icon name="check" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Cancel edit"
          aria-label="Cancel edit"
          disabled={saving}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {error && (
        <span className="preview-note" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
