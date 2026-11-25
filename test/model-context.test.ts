import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelContext } from '../src/client/model-context.js';

const context = { content: [{ type: 'text' as const, text: 'Selected part' }] };
const receipt = (updateId: string) => ({ _meta: { 'openai/modelContext': { updateId } } });

test('host removal and partial context deletion clear the context once', async () => {
  let removed = 0;
  const sent: unknown[] = [];
  const connection = new ModelContext(
    async (params) => {
      sent.push(params);
      return params.content?.length ? receipt('own-update') : {};
    },
    () => removed++,
  );
  connection.receive(null);
  assert.equal(removed, 0);
  assert.equal(await connection.update(context), true);
  connection.receive({ updateId: 'own-update' });
  connection.receive({ updateId: 'user-removed-one-block' });
  assert.equal(removed, 1);
  assert.deepEqual(sent.at(-1), { content: [] });
  connection.receive(null);
  connection.receive(null);
  assert.equal(removed, 1);
});

test('deleting context during its initial update prevents the late acknowledgement from restoring it', async () => {
  let acknowledge!: (response: ReturnType<typeof receipt>) => void;
  let removed = 0;
  const connection = new ModelContext(
    (params) =>
      params.content?.length
        ? new Promise((resolve) => {
            acknowledge = resolve;
          })
        : Promise.resolve({}),
    () => removed++,
  );
  connection.receive(null);
  const pending = connection.update(context);
  connection.receive({ updateId: 'pending-update' });
  connection.receive(null);
  acknowledge(receipt('pending-update'));
  assert.equal(await pending, false);
  assert.equal(removed, 1);
});

test('a new share survives an older cancelled update completing', async () => {
  let acknowledge!: (response: ReturnType<typeof receipt>) => void;
  let calls = 0;
  let removed = 0;
  const connection = new ModelContext(
    async (params) => {
      if (!params.content?.length) return {};
      if (++calls === 1)
        return new Promise((resolve) => {
          acknowledge = resolve;
        });
      connection.receive({ updateId: 'new-update' });
      return receipt('new-update');
    },
    () => removed++,
  );
  const old = connection.update(context);
  connection.receive({ updateId: 'old-update' });
  connection.receive(null);
  assert.equal(await connection.update(context), true);
  acknowledge(receipt('old-update'));
  assert.equal(await old, false);
  connection.receive({ updateId: 'new-update' });
  assert.equal(removed, 1);
  connection.receive(null);
  assert.equal(removed, 2);
});

test('unrelated host updates do not detach context and a previous external edit does not cancel reattachment', async () => {
  let removed = 0;
  let count = 0;
  const connection = new ModelContext(
    async () => receipt(`own-${++count}`),
    () => removed++,
  );
  assert.equal(await connection.update(context), true);
  connection.receive({ updateId: 'own-1' });
  assert.equal(await connection.update(context), true);
  connection.receive({ updateId: 'own-1' });
  connection.receive({ updateId: 'own-2' });
  assert.equal(removed, 0);
  connection.receive({ updateId: 'external-edit' });
  assert.equal(removed, 1);
  assert.equal(await connection.update(context), true);
  connection.receive({ updateId: 'own-4' });
  assert.equal(removed, 1);
});
