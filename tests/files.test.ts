import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectFileError, readProjectFile } from "../runtime/files.ts";
import { directoryLink } from './platform-test-helpers.ts';

test("project reads return file bytes and reject traversal, symlinks, directories and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "athena-files-"));
  try {
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "paper.txt"), "A measured result: 42.\n");
    await writeFile(join(directory, "private.txt"), "outside");
    await symlink(join(directory, "private.txt"), join(project, "escape.txt"));
    await directoryLink(directory, join(project, "escape-directory"));
    await symlink(join(project, "paper.txt"), join(project, "internal-link"));
    await writeFile(join(project, "large.txt"), Buffer.alloc(256 * 1024 + 1));

    assert.equal(await readProjectFile(project, "paper.txt"), "A measured result: 42.\n");
    for (const path of ["../private.txt", join(directory, "private.txt"), "escape.txt",
      "escape-directory/private.txt", "internal-link", ".", "large.txt"]) {
      await assert.rejects(readProjectFile(project, path), ProjectFileError, path);
    }
    await assert.rejects(readProjectFile(project, "missing.txt"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
