import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { FileEdit } from "../types.js";
import { logger } from "./logger.js";

export interface AppliedEdit {
  path: string;
  action: FileEdit["action"];
}

/** Reject paths that escape the repo root (path traversal / absolute paths). */
function safeResolve(dir: string, relPath: string): string {
  const root = resolve(dir);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`refusing to write outside repo: ${relPath}`);
  }
  if (abs.split(sep).includes(".git")) {
    throw new Error(`refusing to write into .git: ${relPath}`);
  }
  return abs;
}

/** Apply a set of file edits to the working tree. Returns what was applied. */
export function applyEdits(dir: string, edits: FileEdit[]): AppliedEdit[] {
  const applied: AppliedEdit[] = [];

  for (const edit of edits) {
    if (!edit.path || typeof edit.path !== "string") {
      logger.warn({ edit }, "skipping edit with invalid path");
      continue;
    }
    const abs = safeResolve(dir, edit.path);

    if (edit.action === "delete") {
      rmSync(abs, { force: true });
      applied.push({ path: edit.path, action: "delete" });
      continue;
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, edit.content ?? "", "utf8");
    applied.push({ path: edit.path, action: edit.action });
  }

  return applied;
}
