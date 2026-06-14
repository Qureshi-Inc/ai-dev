import type { IssueSpec } from "../types.js";

export interface Prompt {
  system: string;
  user: string;
}

export function parseIssuePrompt(title: string, body: string): Prompt {
  return {
    system: [
      "You are a senior software engineer extracting a precise, structured work item from a GitHub issue.",
      "Respond with ONLY a JSON object matching this TypeScript type:",
      "{",
      '  "title": string,',
      '  "summary": string,            // 1-3 sentence restatement of the goal',
      '  "requirements": string[],     // concrete, testable requirements',
      '  "acceptanceCriteria": string[],// how we know it is done',
      '  "affectedAreas": string[],    // files/dirs/modules likely involved (best guess)',
      '  "notes": string               // constraints, edge cases, or "" if none',
      "}",
      "Do not invent requirements that are not implied by the issue. Be specific and concise.",
    ].join("\n"),
    user: `ISSUE TITLE:\n${title}\n\nISSUE BODY:\n${body || "(no body provided)"}`,
  };
}

export function planPrompt(spec: IssueSpec): Prompt {
  return {
    system: [
      "You are a tech lead turning a work item into an ordered implementation plan.",
      "Respond with ONLY a JSON object: { \"steps\": string[] }.",
      "Each step is a short, actionable engineering task in execution order.",
      "Keep it to 3-8 steps. Include a step for adding/updating tests.",
    ].join("\n"),
    user: JSON.stringify(spec, null, 2),
  };
}

export interface RepoFileContext {
  path: string;
  content: string;
}

function renderRepoContext(files: RepoFileContext[]): string {
  if (files.length === 0) return "(repository is empty or no files were selected as context)";
  return files
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
    .join("\n\n");
}

export function implementPrompt(args: {
  spec: IssueSpec;
  steps: string[];
  files: RepoFileContext[];
  fileTree: string;
  fixInstructions?: string;
  /** When set, implement ONLY this plan step (0-based); earlier steps are already applied. */
  stepIndex?: number;
  /** Epic mode: gate new behavior behind a feature flag so each commit stays shippable. */
  epic?: boolean;
  /** Retry mode: forbid @@EDIT and require full-file @@FILE ... modify rewrites. */
  forceFullFile?: boolean;
}): Prompt {
  const stepwise = typeof args.stepIndex === "number";
  // NOTE: deliberately NOT JSON. Embedding whole files (HTML/code with quotes and
  // newlines) inside a JSON string is where models reliably produce invalid JSON.
  // A sentinel-delimited format keeps file contents raw, so no escaping is needed.
  const system = [
    "You are an expert software engineer implementing changes in an existing repository.",
    "You are given a spec, a plan, a file tree, and the contents of relevant files.",
    "",
    "Respond in EXACTLY this plain-text format (NOT JSON, and DO NOT wrap in markdown code fences):",
    "",
    "COMMIT: <concise conventional-commit style message>",
    "SUMMARY: <one or two sentences describing the change>",
    "",
    "Then emit one or more change blocks. There are TWO block types:",
    "",
    "1. SURGICAL EDIT of an existing file (PREFER THIS for modifying files that already exist):",
    "@@EDIT <repo-relative-path>",
    "<<<<<<< SEARCH",
    "<exact existing lines to find (verbatim, including indentation/whitespace)>",
    "=======",
    "<replacement lines>",
    ">>>>>>> REPLACE",
    "",
    "The `>>>>>>> REPLACE` line ENDS the edit block. Do NOT write @@END after it.",
    "",
    "2. FULL FILE for brand-new files or deletes:",
    "@@FILE <repo-relative-path> <create|delete>",
    "<the full raw file content goes here, starting on this line; empty for delete>",
    "@@END",
    "",
    "Rules:",
    "- PREFER @@EDIT for any file that ALREADY EXISTS: emit only the minimal changed",
    "  region plus a few unique surrounding lines as an anchor. Do NOT reproduce the",
    "  whole file. This keeps responses small and avoids output truncation on large files.",
    "- Use @@FILE only for brand-new files (create) or removals (delete).",
    "- For @@EDIT, the SEARCH text MUST match the CURRENT file contents EXACTLY",
    "  (character-for-character, including whitespace). Keep SEARCH blocks small but",
    "  large enough to be UNIQUE within the file.",
    "- You may emit multiple @@EDIT blocks, including several for the same file.",
    "- The content/SEARCH/REPLACE text is raw text. Do NOT escape it.",
    "- For a @@FILE delete action, put no content between the header and @@END.",
    "- Never emit the tokens @@FILE, @@EDIT, or @@END inside file/SEARCH/REPLACE content.",
    "- Do NOT use markdown code fences anywhere in your response.",
    "- Only include files you actually change. Keep changes minimal and focused on the spec.",
    "- Ensure the project still builds and tests can run. Prefer editing existing files over duplicates.",
    "- Produce complete, standards-valid files. Any HTML document MUST begin with",
    "  `<!DOCTYPE html>` as its very first line, before <html>.",
    "- The ORIGINAL ISSUE below is the source of truth for required CONTENT and facts.",
    "  Include all specific details it states (proper nouns, names, exact section content,",
    "  values) VERBATIM. Do not genericize, summarize away, or invent placeholder content.",
  ];
  if (stepwise) {
    system.push(
      "",
      "INCREMENTAL MODE: Implement ONLY the CURRENT STEP marked below. The repository",
      "already contains the changes from earlier steps. Make just the changes this step",
      "requires; do not redo earlier steps or jump ahead. If this step needs no file",
      "changes, output a COMMIT/SUMMARY and no @@EDIT/@@FILE blocks.",
    );
  }
  if (args.epic) {
    system.push(
      "",
      "EPIC MODE: This is part of a large multi-step feature. Put any NEW user-facing",
      "behavior behind a feature flag that defaults to OFF (e.g. an env var or a flag",
      "constant), so every commit is safe to ship even while the epic is incomplete.",
      "Keep the project building and existing behavior unchanged when the flag is off.",
    );
  }
  if (args.forceFullFile) {
    system.push(
      "",
      "RETRY — FULL-FILE MODE: A previous attempt's @@EDIT SEARCH text did not match the",
      "file. Do NOT use @@EDIT this time. For every file you change, emit the COMPLETE new",
      "file content as `@@FILE <repo-relative-path> modify` ... @@END (full raw contents,",
      "not a diff). Reproduce the existing file faithfully and apply only the change this",
      "step requires. This is the only reliable way when an exact SEARCH anchor can't be found.",
    );
  }
  const systemStr = system.join("\n");

  const { originalRequest, ...specForJson } = args.spec;
  const userParts = [];
  if (originalRequest) {
    userParts.push(`ORIGINAL ISSUE (authoritative source for content/facts):\n${originalRequest}`);
  }
  const planRendered = args.steps
    .map((s, i) => `${i + 1}. ${s}${stepwise && i === args.stepIndex ? "   <-- CURRENT STEP" : ""}`)
    .join("\n");
  userParts.push(
    `SPEC (distilled):\n${JSON.stringify(specForJson, null, 2)}`,
    `PLAN:\n${planRendered}`,
    `REPO FILE TREE:\n${args.fileTree}`,
    `RELEVANT FILE CONTENTS:\n${renderRepoContext(args.files)}`,
  );

  if (args.fixInstructions) {
    userParts.push(
      `IMPORTANT - A previous attempt failed CI. Apply this fix guidance from the debugging analysis:\n${args.fixInstructions}`,
    );
  }

  return { system: systemStr, user: userParts.join("\n\n") };
}

export function debugPrompt(args: {
  spec: IssueSpec;
  logsExcerpt: string;
  changedFiles: RepoFileContext[];
  fileTree: string;
}): Prompt {
  const system = [
    "You are a debugging and root-cause-analysis expert.",
    "A CI run failed. Analyse the logs and the current changes to find the root cause and a fix plan.",
    "Respond with ONLY a JSON object matching this TypeScript type:",
    "{",
    '  "rootCause": string,        // the underlying reason CI failed',
    '  "fixInstructions": string,  // precise, actionable instructions for the implementer',
    '  "suspectedFiles": string[]  // repo-relative paths most likely needing changes',
    "}",
    "Be concrete. Reference exact errors, file names, and line numbers from the logs when possible.",
  ].join("\n");

  const { originalRequest, ...specForJson } = args.spec;
  const user = [
    `SPEC:\n${JSON.stringify(specForJson, null, 2)}`,
    `REPO FILE TREE:\n${args.fileTree}`,
    `CURRENT CHANGED FILES:\n${renderRepoContext(args.changedFiles)}`,
    `CI FAILURE LOGS (excerpt):\n${args.logsExcerpt}`,
  ].join("\n\n");

  return { system, user };
}
