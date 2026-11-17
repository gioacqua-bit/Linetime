// Linetime — smoke test of the built desktop app.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copies the fixture project to a temporary folder, starts the real app with
// LINETIME_SMOKE_DIR pointing at it, and waits for src/js/smoke.js to drive
// the interface inside the system webview and report back. Exits with 0 when
// every check passed.
//
// Usage: node scripts/smoke.mjs [--binary path/to/app-executable]
// Without --binary, the script looks for a release build, then a debug build.

import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const exists = p => stat(p).then(() => true, () => false);

async function findBinary() {
  const i = process.argv.indexOf("--binary");
  if (i > 0) return process.argv[i + 1];
  const target = join(repo, "src-tauri", "target");
  for (const profile of ["release", "debug"]) {
    if (process.platform === "darwin") {
      const macos = join(target, profile, "bundle", "macos", "Linetime.app", "Contents", "MacOS");
      if (await exists(macos)) return join(macos, (await readdir(macos))[0]);
    }
    const bin = join(target, profile, process.platform === "win32" ? "linetime.exe" : "linetime");
    if (await exists(bin)) return bin;
  }
  throw new Error("No build found. Run `npm run build` (or `npx tauri build --debug`) first, or pass --binary.");
}

const binary = await findBinary();
const work = await mkdtemp(join(tmpdir(), "linetime-smoke-"));
const project = join(work, "Test collection");
const config = join(work, "config");
const out = join(work, "result.json");
await cp(join(repo, "tests", "fixtures", "project"), project, { recursive: true });

const env = { ...process.env, LINETIME_SMOKE_DIR: project, LINETIME_CONFIG_DIR: config, LINETIME_SMOKE_OUT: out };
let cmd = binary, args = [];
if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  cmd = "xvfb-run";
  args = ["-a", binary];
}
console.log(`Smoke test: ${binary}`);
const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", d => (output += d));
child.stderr.on("data", d => (output += d));
const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
const code = await new Promise(r => child.on("exit", c => r(c ?? 1)));
clearTimeout(timer);

let result = null;
try { result = JSON.parse(await readFile(out, "utf8")); } catch { /* reported below */ }
if (result) {
  for (const line of result.log) console.log("  " + line);
  console.log(`  webview: ${result.userAgent}`);
} else {
  console.log(output.trim() || "(no output)");
}
await rm(work, { recursive: true, force: true });
const passed = code === 0 && result && result.ok;
console.log(passed ? "Smoke test passed." : `Smoke test FAILED (exit code ${code}).`);
process.exit(passed ? 0 : 1);
