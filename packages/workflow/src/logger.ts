// Consistent stdout/stderr formatting for the engine + CLI. Honors AOW_JSON=1
// for machine-readable output; otherwise uses chalk-colored prefixes on stderr
// so stdout stays clean for command results.

import chalk from "chalk";

type Level = "info" | "warn" | "error" | "success" | "step";

function jsonMode(): boolean {
  return process.env.AOW_JSON === "1";
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (jsonMode()) {
    const line = JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...(meta ?? {}),
    });
    process.stderr.write(`${line}\n`);
    return;
  }
  const prefix = prefixFor(level);
  process.stderr.write(`${prefix} ${message}\n`);
}

function prefixFor(level: Level): string {
  switch (level) {
    case "info":
      return chalk.cyan("info ");
    case "warn":
      return chalk.yellow("warn ");
    case "error":
      return chalk.red("error");
    case "success":
      return chalk.green("ok   ");
    case "step":
      return chalk.magenta("step ");
  }
}

export function info(message: string, meta?: Record<string, unknown>): void {
  emit("info", message, meta);
}

export function warn(message: string, meta?: Record<string, unknown>): void {
  emit("warn", message, meta);
}

export function error(message: string, meta?: Record<string, unknown>): void {
  emit("error", message, meta);
}

export function success(message: string, meta?: Record<string, unknown>): void {
  emit("success", message, meta);
}

export function step(label: string, message: string, meta?: Record<string, unknown>): void {
  emit("step", `[${label}] ${message}`, meta);
}

export function isJsonMode(): boolean {
  return jsonMode();
}
