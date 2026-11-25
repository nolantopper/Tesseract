import type { McpUiUpdateModelContextRequest } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

export const modelContextHostState = z.object({ updateId: z.string().min(1) }).nullable();
type HostState = z.infer<typeof modelContextHostState>;
type Update = McpUiUpdateModelContextRequest['params'];
type Response = { isError?: boolean; _meta?: Record<string, unknown> };
const receipt = z.object({ updateId: z.string().min(1) });

export class ModelContext {
  private revision = 0;
  private readonly pending = new Set<object>();
  private hostSequence = 0;
  private updateStartedAt = 0;
  private attached = false;
  private cleared = false;
  private hostState: HostState | undefined;
  private readonly updates = new Map<string, number>();

  constructor(
    private readonly send: (params: Update) => Promise<Response>,
    private readonly onRemove: () => void,
  ) {}

  receive(state: HostState) {
    const previous = this.hostState;
    this.hostState = state;
    this.hostSequence++;
    if (state && this.updates.get(state.updateId) === this.revision) this.cleared = false;
    if (state === null) {
      if (!this.cleared && (this.attached || (this.pending.size > 0 && previous != null)))
        this.removed();
    } else this.reconcile();
  }

  async update(params: Update): Promise<boolean> {
    const revision = this.revision;
    const pending = {};
    const sequence = this.hostSequence;
    this.pending.add(pending);
    try {
      const response = await this.send(params);
      if (response.isError || revision !== this.revision) return false;
      const parsed = receipt.safeParse(response._meta?.['openai/modelContext']);
      if (parsed.success) {
        const { updateId } = parsed.data;
        this.updates.set(updateId, revision);
        if (this.updates.size > 16) this.updates.delete(this.updates.keys().next().value!);
        if (this.hostState?.updateId === updateId) this.cleared = false;
      }
      this.attached = true;
      this.cleared = false;
      this.updateStartedAt = sequence;
    } finally {
      this.pending.delete(pending);
      this.reconcile();
    }
    return revision === this.revision;
  }

  async clear() {
    // Cancel pending acknowledgements before clearing so they cannot restore deleted context.
    this.revision++;
    this.attached = false;
    this.cleared = true;
    this.pending.clear();
    const response = await this.send({ content: [] });
    if (response.isError) throw new Error('Couldn’t clear chat context.');
  }

  private reconcile() {
    if (
      this.attached &&
      this.pending.size === 0 &&
      this.hostSequence > this.updateStartedAt &&
      this.hostState &&
      !this.updates.has(this.hostState.updateId)
    )
      this.removed();
  }

  private removed() {
    void this.clear().catch(() => {});
    this.onRemove();
  }
}
