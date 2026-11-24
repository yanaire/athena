import { builtins } from './mcp-registry.ts';
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject } from "typebox";
import { createProjectReadTool } from "./files.ts";
import { ANALYSIS_LIMITS } from "./analysis-sandbox.ts";

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

// Selected operational guidance from skills/athena-data-quality/SKILL.md.
const measurementParent = 'For an attached measurement CSV and a request for counts, missing values, mean or range, delegate the requested column and its granted upload to one child. Ask it to use calculate_csv, then join and report the published statistics.json.';
const measurementChild = 'For measurement counts, missing values, mean or range, call calculate_csv (the local measurement MCP tool) on the granted CSV. Use the returned counts: distinguish blanks, nonnumeric values and valid zeros. Keep repeated measurements. Report the column and its stated unit, numeric count, and missing count; claim only checks actually performed.';

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
      systemPrompt: measurementParent + " Delegate a granted RC input JSON to one child for calculate_rc_response, then join. " + (executionEnabled ? "Delegate with spawn_agent and join with wait_for_agents. In the join response, result is the child's own report; artifacts is what Athena actually published. If outputs were requested but artifacts is empty, send_to_agent with a correction and join again, or report the failure. Read the published result using read_file({artifactId}) before citing its values. Copy URIs only from artifacts. Use fileIds or artifactIds to explicitly pass inputs." : parentPrompt),
      customTools: [executionEnabled ? delegated({name:"read",label:"Read attached input",description:"Read an input attachment using its exact granted project-relative path.",readOnly:true,parameters:Type.Object({path:id},closed)}) : projectRead,
        ...(executionEnabled ? [delegated({name:"read_file",label:"Verify artifact",description:"Read the verified contents of a direct child's completed artifact in this run.",parameters:artifact,readOnly:true})] : []),
        delegated({ name: "spawn_agent", label: "Spawn agent", description: "Start a direct child research task. Returns its task ID. Omit requestId unless retrying the same request.",
          parameters: Type.Object({ title: id, prompt: message, requestId: Type.Optional(id), ...transfers }, closed) }),
        delegated({ name: "send_to_agent", label: "Send to agent", description: "Send a message to a direct child by task ID.",
          parameters: Type.Object({ taskId: id, message, requestId: Type.Optional(id), ...transfers }, closed) }),
        delegated({ name: "wait_for_agents", label: "Wait for agents", description: "Join direct child tasks and return their outcomes, including failures. Omit taskIds or pass [] to wait for all direct children.", readOnly: true,
          parameters: Type.Object({ taskIds: Type.Optional(Type.Array(id)) }, closed) }),
        delegated({ name: "get_task", label: "Get task", description: "Get one direct child's state and result.", readOnly: true, parameters: oneTask }),
        delegated({ name: "list_tasks", label: "List tasks", description: "List direct child tasks and their current states.", readOnly: true, parameters: Type.Object({}, closed) }),
        delegated({ name: "cancel_task", label: "Cancel task", description: "Cancel a direct child by task ID.", parameters: oneTask }),
      ],
    };
    case "child": return {
      systemPrompt: measurementChild + " For an RC low-pass step response, use calculate_rc_response on the assigned JSON. Report values from its published result. " + (executionEnabled ? "For other calculations that require a script, use the standard library only (no pandas). First write_file({name:'analysis.py',content:<your script text>}), then run_command({language:'python',script:'analysis.py',inputs:['original.csv'],outputs:['result.json']}). Substitute the actual input and output names. The script field is a filename; put code only in write_file.content. calculate_csv accepts granted uploads only. If a call fails, do not repeat identical arguments. A string input names a private workspace file first, or exactly one granted upload with that original filename. For ambiguous upload names pass {fileId,name}; pass transferred artifacts as {artifactId,name}. Your script reads /workspace/<name> and writes /outputs/<name>. Never paste or paraphrase the rows of an assigned upload into the script, and never compute from memorised values: declare the upload in inputs and open /workspace/<name> during the run, so the produced numbers depend on the actual staged bytes. No shell, package installation, network or host filesystem. Verify with read_file. Cite only real artifacts returned by successful tools. Report failures." : childPrompt),
      customTools: [
        ...(executionEnabled ? [
          delegated({name:"read_file",label:"Read scoped file",description:"Supply exactly one of name, fileId, or artifactId; omit the other two fields entirely.",readOnly:true,parameters:Type.Object({name:Type.Optional(id),fileId:Type.Optional(id),artifactId:Type.Optional(id)},{...closed,oneOf:[{required:["name"]},{required:["fileId"]},{required:["artifactId"]}]})}),
          delegated({name:"write_file",label:"Write private file",description:"Write UTF-8 content to a flat filename in this child's private workspace.",parameters:Type.Object({name:id,content:Type.String()},closed)}),
          delegated({name:"run_command",label:"Run offline analysis",description:"Execute a private script in WASI. Python uses standard libraries. For language 'node', write a QuickJS .mjs file with `import * as std from 'qjs:std'`. Read text with `std.loadFile('/workspace/input.txt')`. To write, use `const f = std.open('/outputs/result.json', 'w'); f.puts(JSON.stringify(value)); f.close();`. There is no std.fs or Node built-in module. Use absolute paths under /outputs in the script and list only the basename result.json in outputs.",parameters:Type.Object({language:Type.Union([Type.Literal("node"),Type.Literal("python")]),script:id,inputs:Type.Array(source,{maxItems:ANALYSIS_LIMITS.maxFiles,description:"Required. Include the original CSV filename for an attachment analysis. Use [] if there are no inputs."}),outputs:Type.Array(id,{maxItems:ANALYSIS_LIMITS.maxFiles,uniqueItems:true,description:"Basenames declared for publication. The script writes each file under /outputs."}),args:Type.Optional(Type.Array(Type.String(),{maxItems:ANALYSIS_LIMITS.maxArgs}))},closed)}),
        ] : []),
        delegated({ name: "read", label: "Read granted file", description: "Read the assigned text file with {}. Specify fileId only to select an exact ID from the task.", readOnly: true,
          parameters: Type.Object({ fileId: uniqueGrant }, closed) }),
        ...Array.from(builtins.values()).filter(entry => entry.role === role).map(entry => delegated({
          name:entry.binding.identity.alias, label:entry.binding.identity.displayName,
          description:entry.description, parameters:entry.parameters,
        })),
      ],
    };
  }
}
