import { z } from "zod";
import { callModel, extractJson } from "../llm/client.js";
import { implementPrompt } from "../llm/prompts.js";
import { TaskType, type FileEdit, type ImplementResult, type IssueSpec } from "../types.js";
import { fileTree } from "../utils/git.js";
import { applyEdits, type AppliedEdit } from "../utils/patch.js";
import { selectContextFiles } from "./context.js";
import { logger } from "../utils/logger.js";

const ImplementSchema = z.object({
  commitMessage: z.string().optional(),
  summary: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        action: z.enum(["create", "modify", "delete"]).default("modify"),
        content: z.string().default(""),
      }),
    )
    .default([]),
});

export interface ImplementOutcome {
  result: ImplementResult;
  applied: AppliedEdit[];
}

/** Parse the sentinel-delimited implement format. Returns null if no @@FILE blocks found. */
function parseDelimited(text: string): ImplementResult | null {
  const blockRe =
    /@@FILE[ \t]+(\S+)[ \t]+(create|modify|delete)[ \t]*\r?\n([\s\S]*?)\r?\n?@@END/g;
  const files: FileEdit[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    files.push({
      path: m[1],
      action: m[2] as FileEdit["action"],
      content: m[2] === "delete" ? "" : m[3],
    });
  }
  if (files.length === 0) return null;

  const commitMessage = text.match(/^COMMIT:[ \t]*(.+)$/m)?.[1]?.trim() || "ai-dev: implement changes";
  const summary = text.match(/^SUMMARY:[ \t]*(.+)$/m)?.[1]?.trim() || "";
  return { commitMessage, summary, files };
}

/** Fallback: parse the older JSON implement format if the model used it. */
function parseJsonFallback(text: string): ImplementResult | null {
  try {
    const parsed = ImplementSchema.parse(extractJson<unknown>(text));
    if (parsed.files.length === 0) return null;
    return {
      commitMessage: parsed.commitMessage || "ai-dev: implement changes",
      summary: parsed.summary || "",
      files: parsed.files,
    };
  } catch {
    return null;
  }
}

/**
 * Implement (or fix) changes with the code model: gather repo context, request
 * full-file edits as JSON, validate, and apply them to the working tree.
 */
export async function implementChanges(args: {
  jobId: number;
  dir: string;
  spec: IssueSpec;
  steps: string[];
  fixInstructions?: string;
  extraContextFiles?: string[];
  attempt?: number;
  pro?: boolean;
}): Promise<ImplementOutcome> {
  const tree = await fileTree(args.dir);
  const files = await selectContextFiles(args.dir, args.spec, args.extraContextFiles ?? []);

  const prompt = implementPrompt({
    spec: args.spec,
    steps: args.steps,
    files,
    fileTree: tree,
    fixInstructions: args.fixInstructions,
  });

  const response = await callModel(TaskType.IMPLEMENT, {
    system: prompt.system,
    user: prompt.user,
    jobId: args.jobId,
    attempt: args.attempt,
    pro: args.pro,
  });

  const result = parseDelimited(response.text) ?? parseJsonFallback(response.text);
  if (!result || result.files.length === 0) {
    throw new Error("implement response contained no parseable file edits");
  }

  const applied = applyEdits(args.dir, result.files);
  logger.info(
    { jobId: args.jobId, files: applied.map((a) => `${a.action}:${a.path}`) },
    "patch applied",
  );
  return { result, applied };
}
