// First-run config bootstrap for `aow run`. If the cwd has no
// agent-orchestrator.yaml, write a minimal flat config and register the
// project in the global config (~/.agent-orchestrator/config.yaml) by
// calling AO core's registerProjectInGlobalConfig. AO core remains the
// single source of truth for global state — bootstrap only calls into it,
// never writes the file directly.
//
// Note: registerProjectInGlobalConfig adds a hash suffix to project ids
// for collision safety. The returned BootstrapResult.projectId reflects
// the registered (hashed) id. The engine resolves the project by cwd-path
// match (see ao-client.ts), so a workflow.yaml's `project_id` field is a
// human-readable label, not a binding key.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { generateSessionPrefix, registerProjectInGlobalConfig } from "@aoagents/ao-core";

import { WorkflowError } from "../errors.js";

export interface BootstrapResult {
  configPath: string;
  projectId: string;
  created: boolean;
}

const SCHEMA_URL =
  "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json";

function sanitizeProjectId(raw: string): string {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9_-]/g, "_");
  const trimmed = replaced.replace(/_+$/g, "");
  return trimmed || "project";
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseProjectId(yamlText: string, fallback: string): string {
  // Flat config: `name: foo` at top level.
  const nameMatch = yamlText.match(/^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/m);
  if (nameMatch) return sanitizeProjectId(nameMatch[1]);
  // Wrapped config: first key under `projects:`.
  const projIdx = yamlText.search(/^projects:\s*$/m);
  if (projIdx >= 0) {
    const after = yamlText.slice(projIdx);
    const keyMatch = after.match(/^\s{2,}([A-Za-z0-9_.-]+):\s*$/m);
    if (keyMatch) return sanitizeProjectId(keyMatch[1]);
  }
  return fallback;
}

function renderFlatConfig(projectId: string, cwd: string): string {
  return [
    `$schema: ${SCHEMA_URL}`,
    `name: ${projectId}`,
    `path: ${cwd}`,
    `defaultBranch: main`,
    `sessionPrefix: aow`,
    `agent: claude-code`,
    `workspace: worktree`,
    ``,
  ].join("\n");
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, { flag: "wx" });
  try {
    await rename(tmp, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
}

export async function ensureAowConfig(cwd: string): Promise<BootstrapResult> {
  const yamlPath = join(cwd, "agent-orchestrator.yaml");
  const ymlPath = join(cwd, "agent-orchestrator.yml");
  try {
    const existing = (await readIfExists(yamlPath)) ?? (await readIfExists(ymlPath));
    if (existing !== null) {
      const path = (await readIfExists(yamlPath)) !== null ? yamlPath : ymlPath;
      const fallback = sanitizeProjectId(basename(cwd));
      const localId = parseProjectId(existing, fallback);
      const projectId = ensureRegistered(localId, cwd);
      return { configPath: path, projectId, created: false };
    }

    await mkdir(cwd, { recursive: true });
    const localId = sanitizeProjectId(basename(cwd));
    const contents = renderFlatConfig(localId, cwd);
    try {
      await atomicWrite(yamlPath, contents);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const raced = (await readIfExists(yamlPath)) ?? "";
        const racedLocalId = parseProjectId(raced, localId);
        const projectId = ensureRegistered(racedLocalId, cwd);
        return { configPath: yamlPath, projectId, created: false };
      }
      throw err;
    }
    const projectId = ensureRegistered(localId, cwd);
    return { configPath: yamlPath, projectId, created: true };
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError(
      "WF_AO_CONTEXT",
      `Failed to ensure agent-orchestrator.yaml in ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function ensureRegistered(localId: string, cwd: string): string {
  try {
    return registerProjectInGlobalConfig(localId, localId, cwd, {
      defaultBranch: "main",
      sessionPrefix: generateSessionPrefix(localId),
    });
  } catch {
    return localId;
  }
}
