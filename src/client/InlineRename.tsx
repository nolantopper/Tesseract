import { useState } from 'react';
import { Icon } from './Icon';

export default function InlineRename({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const close = () => {
    setDraft(undefined);
    setError('');
  };
  const save = async () => {
    if (saving || draft === undefined || draft === value || !draft.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t save the file.');
    } finally {
      setSaving(false);
    }
  };

  if (draft === undefined)
    return (
      <button
        className="icon-button"
        type="button"
        aria-label={label}
        title={label}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(value);
        }}
      >
        <Icon name="edit" />
      </button>
    );
  return (
    <div
      className="inline-rename"
      role="group"
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!saving && event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div>
        <input
          aria-label={label}
          value={draft}
          autoFocus
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <button
          className="icon-button"
          type="button"
          aria-label="Save"
          title="Save"
          disabled={saving || !draft.trim() || draft === value}
          onClick={() => void save()}
        >
          <Icon name="check" />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Cancel"
          title="Cancel"
          disabled={saving}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {error && <output role="alert">{error}</output>}
    </div>
  );
}
