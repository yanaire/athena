import { createHash } from 'node:crypto';

export type ToolFailureLimit = {
  readonly code: 'TOOL_FAILURE_LIMIT';
  readonly message: string;
  readonly toolName: string;
  readonly reason: 'repeated' | 'total';
  readonly failures: number;
  readonly limit: number;
};

type Event = Readonly<Record<string, unknown>> & { readonly type: string };
type Call = { readonly name: string; readonly args: unknown };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(call: Call): string {
  // Pi arguments are JSON. Do not let a malformed SDK event break terminal-state handling.
  let args: string;
  try { args = canonical(call.args); } catch { args = '[unserializable arguments]'; }
  return createHash('sha256').update(JSON.stringify(call.name)).update('\0').update(args).digest('hex');
}

/** A fresh budget belongs to one attempt, never to a task or a conversation. */
export class ToolFailureBudget {
  readonly #maxRepeated: number;
  readonly #maxTotal: number;
  readonly #started = new Map<string, Call>();
  readonly #finished = new Set<string>();
  readonly #failures = new Map<string, number>();
  #total = 0;
  #stopped = false;

  constructor(options: { readonly maxRepeatedFailures?: number; readonly maxTotalFailures?: number } = {}) {
    this.#maxRepeated = options.maxRepeatedFailures ?? 3;
    this.#maxTotal = options.maxTotalFailures ?? 8;
    if (![this.#maxRepeated, this.#maxTotal].every(n => Number.isSafeInteger(n) && n > 0))
      throw new RangeError('Tool failure limits must be positive safe integers.');
  }

  /** Returns the terminal decision once. Only completed tool failures consume the budget. */
  observe(event: Event): ToolFailureLimit | undefined {
    if (this.#stopped || typeof event.toolCallId !== 'string' || !event.toolCallId) return;
    const id = event.toolCallId;
    if (this.#finished.has(id)) return;
    if (event.type === 'tool_execution_start') {
      if (typeof event.toolName === 'string' && !this.#started.has(id))
        this.#started.set(id, { name: event.toolName, args: event.args });
      return;
    }
    if (event.type !== 'tool_execution_end') return;
    const start = this.#started.get(id);
    const name = typeof event.toolName === 'string' ? event.toolName : start?.name;
    if (!name) return;
    this.#started.delete(id);
    this.#finished.add(id);
    const key = fingerprint({ name, args: event.args === undefined ? start?.args : event.args });
    const isError = event.isError === true || (object(event.result) && event.result.isError === true);
    if (!isError) {
      // A successful different tool must not hide a repeated failure loop.
      this.#failures.delete(key);
      return;
    }
    this.#total++;
    const repeated = (this.#failures.get(key) ?? 0) + 1;
    this.#failures.set(key, repeated);
    const reason = repeated >= this.#maxRepeated ? 'repeated' : this.#total >= this.#maxTotal ? 'total' : undefined;
    if (!reason) return;
    this.#stopped = true;
    const failures = reason === 'repeated' ? repeated : this.#total;
    const limit = reason === 'repeated' ? this.#maxRepeated : this.#maxTotal;
    return {
      code: 'TOOL_FAILURE_LIMIT', toolName: name, reason, failures, limit,
      message: reason === 'repeated'
        ? `Stopped after ${limit} failures with the same tool and arguments. Previous results were preserved. Review the error before retrying this task.`
        : `Stopped after ${limit} tool failures in this attempt. Previous results were preserved. Review the errors before retrying this task.`,
    };
  }
}
