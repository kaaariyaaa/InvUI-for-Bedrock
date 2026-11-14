/*
 * Entry-point guard test.
 *
 * bin/cli.js must only run main() when it is the process entry, and importing it
 * must never throw just because process.argv[1] cannot be resolved. `node -`
 * leaves argv[1] as "-", which is not a file; that is the cheap portable stand-in
 * for a script that vanished between startup and import.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const cliUrl = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js"),
).href;

test("importing the CLI does not throw when process.argv[1] is not a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invui-cli-entry-"));
  try {
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-"],
      {
        cwd: dir,
        encoding: "utf8",
        input: `await import(${JSON.stringify(cliUrl)});\nprocess.stdout.write("imported");\n`,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "imported");
    assert.equal(run.stderr, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
