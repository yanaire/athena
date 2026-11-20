import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject } from "typebox";
import { createProjectReadTool } from "./files.ts";
import { ANALYSIS_LIMITS } from "./analysis-container.ts";

export interface PiOrchestration {
  readonly role: "parent" | "child";
  readonly executionEnabled?: boolean;
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

  const { role, execute, executionEnabled } = orchestration;
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
  const ids = Type.Array(id, {maxItems: 32, uniqueItems: true});
  const transfers = {fileIds: Type.Optional(ids), artifactIds: Type.Optional(ids)};
  const artifact = Type.Object({artifactId: id}, closed);
  const source = Type.Union([id, Type.Object({name:id,fileId:id},closed), Type.Object({name:id,artifactId:id},closed)]);

  switch (role) {
    case "parent": return {
      systemPrompt: executionEnabled ? "You coordinate analysis. Delegate with spawn_agent, join using wait_for_agents. Verify the actual returned artifacts with read_file({artifactId}); if needed send_to_agent for a correction and join again. Use fileIds or artifactIds to explicitly pass inputs. Cite only canonical returned artifact titles and URIs. Disclose failures." : parentPrompt,
      customTools: [executionEnabled ? delegated({name:"read",label:"Read attached input",description:"Read an input attachment using its exact granted project-relative path.",readOnly:true,parameters:Type.Object({path:id},closed)}) : projectRead,
        ...(executionEnabled ? [delegated({name:"read_file",label:"Verify artifact",description:"Read the verified contents of a direct child's completed artifact in this run.",parameters:artifact,readOnly:true})] : []),
        delegated({ name: "spawn_agent", label: "Spawn agent", description: "Start a direct child research task. Returns its task ID. Omit requestId unless retrying the same request.",
          parameters: Type.Object({ title: id, prompt: message, requestId: Type.Optional(id), ...transfers }, closed) }),
        delegated({ name: "send_to_agent", label: "Send to agent", description: "Send a message to a direct child by task ID.",
          parameters: Type.Object({ taskId: id, message, requestId: Type.Optional(id), ...transfers }, closed) }),
        delegated({ name: "wait_for_agents", label: "Wait for agents", description: "Join direct child tasks and return their outcomes, including failures. Use {} to wait for all direct children.", readOnly: true,
          parameters: Type.Object({ taskIds: Type.Optional(Type.Array(id)) }, closed) }),
        delegated({ name: "get_task", label: "Get task", description: "Get one direct child's state and result.", readOnly: true, parameters: oneTask }),
        delegated({ name: "list_tasks", label: "List tasks", description: "List direct child tasks and their current states.", readOnly: true, parameters: Type.Object({}, closed) }),
        delegated({ name: "cancel_task", label: "Cancel task", description: "Cancel a direct child by task ID.", parameters: oneTask }),
      ],
    };
    case "child": return {
      systemPrompt: executionEnabled ? "You are an Athena research worker. Use the standard library only (no pandas). First write_file({name:'analysis.py',content:<your script text>}), then run_command({language:'python',script:'analysis.py',inputs:['original.csv'],outputs:['result.json']}). Substitute the actual input and output names. The script field is a filename; put code only in write_file.content. calculate_csv accepts granted uploads only. If a call fails, do not repeat identical arguments. A string input names a private workspace file first, or exactly one granted upload with that original filename. For ambiguous upload names pass {fileId,name}; pass transferred artifacts as {artifactId,name}. Your script reads /workspace/<name> and writes /outputs/<name>. No shell, package installation, network or host filesystem. Verify with read_file. Cite only real artifacts returned by successful tools. Report failures." : childPrompt,
      customTools: [
        ...(executionEnabled ? [
          delegated({name:"read_file",label:"Read scoped file",description:"Specify exactly one of: a private name, granted fileId, or authorized artifactId.",readOnly:true,parameters:Type.Object({name:Type.Optional(id),fileId:Type.Optional(id),artifactId:Type.Optional(id)},closed)}),
          delegated({name:"write_file",label:"Write private file",description:"Write UTF-8 content to a flat filename in this child's private workspace.",parameters:Type.Object({name:id,content:Type.String()},closed)}),
          delegated({name:"run_command",label:"Run offline analysis",description:"Execute a private script in offline Docker. List each filename the script needs in inputs; only those files are mounted under /workspace. Use [] for a script that needs no inputs. Write declared outputs under /outputs.",parameters:Type.Object({language:Type.Union([Type.Literal("node"),Type.Literal("python")]),script:id,inputs:Type.Array(source,{maxItems:ANALYSIS_LIMITS.maxFiles,description:"Required. Include the original CSV filename for an attachment analysis."}),outputs:Type.Array(id,{maxItems:ANALYSIS_LIMITS.maxFiles,uniqueItems:true}),args:Type.Optional(Type.Array(Type.String(),{maxItems:ANALYSIS_LIMITS.maxArgs}))},closed)}),
        ] : []),
        delegated({ name: "read", label: "Read granted file", description: "Read the assigned text file with {}. Specify fileId only to select an exact ID from the task.", readOnly: true,
          parameters: Type.Object({ fileId: uniqueGrant }, closed) }),
        delegated({ name: "calculate_csv", label: "Calculate CSV statistics", description: 'Create a statistics.json file for the assigned CSV. Use {} for all columns, or specify the requested column name. Specify fileId only to select an exact ID from the task.',
          parameters: Type.Object({ fileId: uniqueGrant, column: Type.Optional(id) }, closed) }),
      ],
    };
  }
}
