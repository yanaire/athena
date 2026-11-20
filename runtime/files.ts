import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export class ProjectFileError extends Error {
  readonly code = "PROJECT_FILE_DENIED";
}

const MAX_BYTES = 256 * 1024;

/** Reject symlinks in every component, including links back into the project. */
export async function readProjectFile(projectDir: string, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const root = await realpath(projectDir);
  const target = resolve(root, path);
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new ProjectFileError("Read paths must identify a file inside this project.");
  }
  let component = root;
  for (const part of local.split(sep)) {
    component = resolve(component, part);
    if ((await lstat(component)).isSymbolicLink()) {
      throw new ProjectFileError("Symbolic links are not readable.");
    }
  }
  const canonical = await realpath(target);
  if (canonical !== target) throw new ProjectFileError("The file path changed during resolution.");
  const expected = await lstat(canonical);
  if (!expected.isFile() || expected.size > MAX_BYTES) {
    throw new ProjectFileError("Read requires a regular UTF-8 file no larger than 256 KiB.");
  }
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino
      || await realpath(target) !== canonical) {
      throw new ProjectFileError("The file changed during opening.");
    }
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw new ProjectFileError("File exceeds the 256 KiB read limit.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export function createProjectReadTool(projectDir: string) {
  return defineTool({
    name: "read",
    label: "Read project file",
    description: "Read a UTF-8 file within the current project. Supply a project-relative path. No symlinks or files over 256 KiB.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, signal) {
      const text = await readProjectFile(projectDir, params.path, signal);
      return { content: [{ type: "text", text }], details: { path: params.path } };
    },
  });
}
