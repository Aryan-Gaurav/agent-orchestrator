#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "..", "node_modules", "@aoagents/ao-workflow", "dist", "cli.js");

const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
