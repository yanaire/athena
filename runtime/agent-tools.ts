import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject } from "typebox";
import { createProjectReadTool } from "./files.ts";

export interface PiOrchestration {
  readonly role: "parent" | "child";
  readonly execute: (
    name: string, rawToolCallId: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal,
  ) => Promise<unknown>;
}

const standalonePrompt = "You are Athena, a research assistant. Use the read tool to inspect project files when requested. Only claim to have read a file after a successful tool result. No shell, write, or network tools are available.";
const parentPrompt = "You are Athena, a research coordinator. When asked to delegate, call spawn_agent once per assignment, then wait_for_agents({}). The wait result contains the final child reports. Once all children settle, answer the user immediately from those reports; do not call more tools. Cite generated files by their returned artifact title and URI. An upload is input, never an output artifact. For a direct file question without delegation, use read. Disclose failed tasks.";
const childPrompt = 'You are an Athena research worker. Call calculate_csv for CSV statistics or read for text. Example: for the voltage column of the assigned CSV, call calculate_csv with {"column":"voltage"}. Without a named column, use {}. For the assigned text file, call read with {}. Only copy a fileId if the task gives an exact ID. Report the tool result or error.';

export function createPiToolLoadout(projectDir: string, orchestration?: PiOrchestration) {
  const projectRead = createProjectReadTool(projectDir);
  if (!orchestration) return { customTools: [projectRead], systemPrompt: standalonePrompt };

  const { role, execute } = orchestration;
  const delegated = <T extends TObject>(spec: {
    readonly name: string; readonly label: string; readonly description: string;
    readonly parameters: T; readonly readOnly?: boolean;
  }) => defineTool({
    name: spec.name, label: spec.label, description: spec.description, parameters: spec.parameters,
    annotations: { readOnlyHint: spec.readOnly ?? false, openWorldHint: false },
    async execute(rawToolCallId, args, signal) {
      signal?.throwIfAborted();
      const result = await execute(spec.name, rawToolCallId, args, signal);
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) ?? "null" }], details: result };
    },
  });
  const id = Type.String({ minLength: 1, maxLength: 256 });
  const message = Type.String({ minLength: 1, maxLength: 32768 });
  const closed = { additionalProperties: false } as const;
  const oneTask = Type.Object({ taskId: id }, closed);
  const uniqueGrant = Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exact granted file ID from the task. Omit this field unless an ID was given." }));

  switch (role) {
    case "parent": return {
      systemPrompt: parentPrompt,
      customTools: [projectRead,
        delegated({ name: "spawn_agent", label: "Spawn agent", description: "Start a direct child research task. Returns its task ID. Omit requestId unless retrying the same request.",
          parameters: Type.Object({ title: id, prompt: message, requestId: Type.Optional(id) }, closed) }),
        delegated({ name: "send_to_agent", label: "Send to agent", description: "Send a message to a direct child by task ID.",
          parameters: Type.Object({ taskId: id, message, requestId: Type.Optional(id) }, closed) }),
        delegated({ name: "wait_for_agents", label: "Wait for agents", description: "Join direct child tasks and return their outcomes, including failures. Use {} to wait for all direct children.", readOnly: true,
          parameters: Type.Object({ taskIds: Type.Optional(Type.Array(id)) }, closed) }),
        delegated({ name: "get_task", label: "Get task", description: "Get one direct child's state and result.", readOnly: true, parameters: oneTask }),
        delegated({ name: "list_tasks", label: "List tasks", description: "List direct child tasks and their current states.", readOnly: true, parameters: Type.Object({}, closed) }),
        delegated({ name: "cancel_task", label: "Cancel task", description: "Cancel a direct child by task ID.", parameters: oneTask }),
      ],
    };
    case "child": return {
      systemPrompt: childPrompt,
      customTools: [
        delegated({ name: "read", label: "Read granted file", description: "Read the assigned text file with {}. Specify fileId only to select an exact ID from the task.", readOnly: true,
          parameters: Type.Object({ fileId: uniqueGrant }, closed) }),
        delegated({ name: "calculate_csv", label: "Calculate CSV statistics", description: 'Create a statistics.json file for the assigned CSV. Use {} for all columns, or specify the requested column name. Specify fileId only to select an exact ID from the task.',
          parameters: Type.Object({ fileId: uniqueGrant, column: Type.Optional(id) }, closed) }),
      ],
    };
  }
}
