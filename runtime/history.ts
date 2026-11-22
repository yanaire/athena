import { object } from './orchestration.ts';
import type { Context } from './orchestration.ts';
import { toolId } from './orchestration-journal.ts';

export type HistoryEvent = Context & { readonly event: { readonly type: string; readonly message?: unknown } };

function withToolIds(message: unknown, attempt: Context): unknown {
  if (!object(message)) return message;
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return {...message, toolCallId: toolId(attempt, message.toolCallId), rawToolCallId: message.toolCallId};
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    return {...message, content: message.content.map((part: unknown) =>
      object(part) && part.type === 'toolCall' && typeof part.id === 'string'
        ? {...part, id: toolId(attempt, part.id), rawToolCallId: part.id}
        : part)};
  }
  return message;
}

/** Match finalized messages inside an unambiguous user turn; never join history by raw ID alone. */
export function projectHistory(messages: readonly unknown[], journal: readonly HistoryEvent[]): readonly unknown[] {
  type Turn = { readonly attempt: Context; readonly messages: unknown[] };
  const journalTurns = new Map<string, Turn | null>();
  const byAttempt = new Map<string, Turn>();
  for (const row of journal) {
    const {type, message} = row.event;
    if (type !== 'message_end' || !object(message)) continue;
    if (message.role === 'user') {
      const key = JSON.stringify(message);
      const turn: Turn = {attempt: row, messages: []};
      journalTurns.set(key, journalTurns.has(key) ? null : turn);
      byAttempt.set(row.attemptId, turn);
    } else {
      byAttempt.get(row.attemptId)?.messages.push(message);
    }
  }
  if (!journalTurns.size) return messages;

  const userCounts = new Map<string, number>();
  for (const message of messages) {
    if (object(message) && message.role === 'user') {
      const key = JSON.stringify(message);
      userCounts.set(key, (userCounts.get(key) ?? 0) + 1);
    }
  }
  let turn: Turn | null | undefined;
  let index = 0;
  return messages.map(message => {
    if (object(message) && message.role === 'user') {
      const key = JSON.stringify(message);
      turn = userCounts.get(key) === 1 ? journalTurns.get(key) : undefined;
      index = 0;
    } else if (turn) {
      // The event is stored just before Pi appends to JSONL. An interrupted or divergent
      // transcript may have only a common prefix; leave the unmatched suffix untouched.
      if (JSON.stringify(turn.messages[index++]) === JSON.stringify(message)) return withToolIds(message, turn.attempt);
      turn = undefined;
    }
    return message;
  });
}
