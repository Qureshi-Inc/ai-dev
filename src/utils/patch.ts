import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { FileEdit } from "../types.js";
import { logger } from "./logger.js";

export interface AppliedEdit {
  path: string;
  action: FileEdit["action"];
}

/**
 * Apply a surgical SEARCH/REPLACE edit to existing file content.
 * First tries an exact substring match (first occurrence). If that fails,
 * retries with a whitespace-tolerant match (each line compared with leading/
 * trailing whitespace trimmed) over a contiguous run of lines, replacing the
 * original matched region. Throws if neither match is found.
 */
export function applySearchReplace(
  original: string,
  search: string,
  replace: string,
  relPath: string,
): string {
  // 1. Exact substring match (first occurrence).
  const idx = original.indexOf(search);
  if (idx !== -1) {
    return original.slice(0, idx) + replace + original.slice(idx + search.length);
  }

  // 2. Whitespace-tolerant, line-based match. Trimming each line absorbs cheap,
  // non-semantic differences: CRLF vs LF (trailing \r is trimmed), trailing
  // whitespace, and leading indentation. It does NOT fuzzy-match different text,
  // so a paraphrased/guessed anchor still fails loudly below.
  const fileLines = original.split("\n");
  const searchLines = search.split("\n");
  const norm = (s: string) => s.trim();
  const normSearch = searchLines.map(norm);
  // Drop trailing empty normalized lines from the search so a trailing newline
  // in the SEARCH block doesn't force an extra blank line to match.
  while (normSearch.length > 1 && normSearch[normSearch.length - 1] === "") {
    normSearch.pop();
  }
  const n = normSearch.length;

  for (let i = 0; i + n <= fileLines.length; i++) {
    let hit = true;
    for (let j = 0; j < n; j++) {
      if (norm(fileLines[i + j]) !== normSearch[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      const before = fileLines.slice(0, i);
      const after = fileLines.slice(i + n);
      const replaced = [...before, ...replace.split("\n"), ...after];
      return replaced.join("\n");
    }
  }

  throw new Error(`edit SEARCH not found in ${relPath}`);
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

    if (edit.action === "edit") {
      const original = readFileSync(abs, "utf8");
      const updated = applySearchReplace(
        original,
        edit.search ?? "",
        edit.replace ?? "",
        edit.path,
      );
      writeFileSync(abs, updated, "utf8");
      applied.push({ path: edit.path, action: "edit" });
      continue;
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, edit.content ?? "", "utf8");
    applied.push({ path: edit.path, action: edit.action });
  }

  return applied;
}
