// ---------------------------------------------------------------------------
// Context Builder — bounded context manifests for the coding agent
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import type { Project, ProjectTask, ProjectPhase } from "../types.js";
import type { ClassifiedFailure } from "./failureClassifier.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContextManifest {
  objective: string;
  acceptanceCriteria: string[];
  scope: { include: string[]; exclude: string[] };
  startingCommitSha: string;
  relevantFiles: Array<{ path: string; excerpt?: string; reason: string }>;
  previousFailure?: { type: string; message: string; attempt: number };
  verificationCommands: string[];
  tokenEstimate: number;
}

export interface ContextBudget {
  maxInputTokens: number;    // default 10000
  maxFiles: number;          // default 15
  maxExcerptSize: number;    // default 2000 chars per file
  maxHistoryItems: number;   // default 3
}

const DEFAULT_BUDGET: ContextBudget = {
  maxInputTokens: 10000,
  maxFiles: 15,
  maxExcerptSize: 2000,
  maxHistoryItems: 3,
};

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

export class ContextBuilder {
  private log = logger.child({ component: "ContextBuilder" });
  private budget: ContextBudget;

  constructor(budget?: Partial<ContextBudget>) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async build(params: {
    task: ProjectTask;
    project: Project;
    worktreePath: string;
    previousFailure?: ClassifiedFailure;
    attemptNumber: number;
  }): Promise<ContextManifest> {
    const { task, project, worktreePath, previousFailure, attemptNumber } = params;

    this.log.info({ taskId: task.id, attemptNumber }, "building context manifest");

    // Get the starting commit SHA
    const shaResult = await run("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      allowFailure: true,
    });
    const startingCommitSha = shaResult.stdout.trim();

    // Parse subtasks from task
    const subtasks = task.subtasks ? JSON.parse(task.subtasks) as string[] : [];

    // Build acceptance criteria from subtasks + description
    const acceptanceCriteria = this.extractAcceptanceCriteria(task, subtasks);

    // Determine scope
    const scope = this.determineScope(task);

    // Discover relevant files in the worktree
    const relevantFiles = await this.discoverRelevantFiles(worktreePath, task);

    // Discover verification commands
    const verificationCommands = await this.discoverVerificationCommands(worktreePath);

    // Build the objective
    const objective = this.buildObjective(task, project);

    // Build previous failure context if applicable
    const failureContext = previousFailure
      ? { type: previousFailure.type, message: previousFailure.message, attempt: attemptNumber - 1 }
      : undefined;

    // Build the manifest
    const manifest: ContextManifest = {
      objective,
      acceptanceCriteria,
      scope,
      startingCommitSha,
      relevantFiles,
      previousFailure: failureContext,
      verificationCommands,
      tokenEstimate: 0,
    };

    // Estimate total tokens
    manifest.tokenEstimate = this.estimateManifestTokens(manifest);

    this.log.info(
      { tokenEstimate: manifest.tokenEstimate, fileCount: relevantFiles.length },
      "context manifest built",
    );

    return manifest;
  }

  /**
   * Estimate token count for a string (~4 chars per token approximation).
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private buildObjective(task: ProjectTask, project: Project): string {
    return [
      `Implement task "${task.title}" for project "${project.title}".`,
      "",
      task.description,
    ].join("\n");
  }

  private extractAcceptanceCriteria(task: ProjectTask, subtasks: string[]): string[] {
    const criteria: string[] = [];

    // Extract from subtasks
    for (const subtask of subtasks) {
      criteria.push(subtask);
    }

    // If no subtasks, derive from description
    if (criteria.length === 0) {
      criteria.push(`Complete: ${task.title}`);
      if (task.description) {
        // Look for bullet points in description
        const bullets = task.description.split("\n")
          .filter((line) => line.match(/^[-*]\s+/))
          .map((line) => line.replace(/^[-*]\s+/, "").trim());
        criteria.push(...bullets);
      }
    }

    return criteria.slice(0, this.budget.maxHistoryItems * 5);
  }

  private determineScope(task: ProjectTask): { include: string[]; exclude: string[] } {
    const include: string[] = [];
    const exclude: string[] = [
      ".github/workflows/",
      "node_modules/",
      ".git/",
      "dist/",
      "build/",
    ];

    // Try to infer scope from task description
    const pathPatterns = task.description.match(/(?:src|lib|app|components|pages|api)\/[^\s,)]+/g);
    if (pathPatterns) {
      for (const pattern of pathPatterns) {
        include.push(pattern);
      }
    }

    // Dependencies listed in task metadata hint at files
    if (task.dependencies) {
      try {
        const deps = JSON.parse(task.dependencies) as number[];
        if (deps.length > 0) {
          // When there are dependencies, the task likely builds on existing files
          include.push("src/");
        }
      } catch {
        // Not JSON array, ignore
      }
    }

    return { include, exclude };
  }

  private async discoverRelevantFiles(
    worktreePath: string,
    task: ProjectTask,
  ): Promise<Array<{ path: string; excerpt?: string; reason: string }>> {
    const results: Array<{ path: string; excerpt?: string; reason: string }> = [];
    let tokenBudget = this.budget.maxInputTokens;

    // 1. Check for files explicitly mentioned in task description
    const mentionedPaths = this.extractMentionedPaths(task.description);
    for (const filePath of mentionedPaths.slice(0, this.budget.maxFiles)) {
      const fullPath = join(worktreePath, filePath);
      if (existsSync(fullPath)) {
        const excerpt = this.readExcerpt(fullPath);
        const tokens = this.estimateTokens(excerpt);
        if (tokenBudget - tokens < 0) break;
        tokenBudget -= tokens;
        results.push({ path: filePath, excerpt, reason: "mentioned in task description" });
      }
    }

    // 2. Look for key project files
    const keyFiles = [
      { path: "package.json", reason: "project configuration" },
      { path: "tsconfig.json", reason: "TypeScript configuration" },
      { path: "CLAUDE.md", reason: "project instructions" },
    ];

    for (const { path, reason } of keyFiles) {
      if (results.length >= this.budget.maxFiles) break;
      const fullPath = join(worktreePath, path);
      if (existsSync(fullPath)) {
        const excerpt = this.readExcerpt(fullPath);
        const tokens = this.estimateTokens(excerpt);
        if (tokenBudget - tokens < 0) break;
        tokenBudget -= tokens;
        results.push({ path, excerpt, reason });
      }
    }

    // 3. Use git ls-files + grep to find files matching keywords from the task title
    const keywords = task.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["task", "implement", "create", "add", "update", "the", "for", "and", "with"].includes(w));

    if (keywords.length > 0 && results.length < this.budget.maxFiles) {
      const lsResult = await run("git", ["-C", worktreePath, "ls-files"], { allowFailure: true });
      const allFiles = lsResult.stdout.split("\n").filter(Boolean);

      for (const file of allFiles) {
        if (results.length >= this.budget.maxFiles) break;
        if (results.some((r) => r.path === file)) continue;

        const fileLower = file.toLowerCase();
        const matchedKeyword = keywords.find((kw) => fileLower.includes(kw));
        if (matchedKeyword) {
          const fullPath = join(worktreePath, file);
          if (existsSync(fullPath)) {
            const excerpt = this.readExcerpt(fullPath);
            const tokens = this.estimateTokens(excerpt);
            if (tokenBudget - tokens < 0) break;
            tokenBudget -= tokens;
            results.push({ path: file, excerpt, reason: `filename matches keyword "${matchedKeyword}"` });
          }
        }
      }
    }

    return results;
  }

  private async discoverVerificationCommands(worktreePath: string): Promise<string[]> {
    const commands: string[] = [];

    // Check package.json for scripts
    const pkgPath = join(worktreePath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};

        // Prioritize verification commands
        const verifyScripts = ["typecheck", "type-check", "tsc", "lint", "test", "build"];
        for (const name of verifyScripts) {
          if (scripts[name]) {
            commands.push(`npm run ${name}`);
          }
        }

        // Check for "check" or "validate" scripts
        for (const [name] of Object.entries(scripts)) {
          if ((name.includes("check") || name.includes("validate")) && !commands.includes(`npm run ${name}`)) {
            commands.push(`npm run ${name}`);
          }
        }
      } catch {
        // Invalid package.json
      }
    }

    // Check for Makefile targets
    const makefilePath = join(worktreePath, "Makefile");
    if (existsSync(makefilePath)) {
      const content = readFileSync(makefilePath, "utf8");
      const targets = ["test", "lint", "check", "build", "verify"];
      for (const target of targets) {
        if (content.includes(`${target}:`)) {
          commands.push(`make ${target}`);
        }
      }
    }

    return commands;
  }

  private extractMentionedPaths(description: string): string[] {
    // Match file paths in backticks or with common extensions
    const patterns = [
      /`([^`]+\.[a-z]{1,4})`/g,           // `path/to/file.ts`
      /(?:^|\s)(src\/[^\s,)]+)/gm,        // src/something
      /(?:^|\s)(lib\/[^\s,)]+)/gm,        // lib/something
      /(?:^|\s)(app\/[^\s,)]+)/gm,        // app/something
    ];

    const paths = new Set<string>();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(description)) !== null) {
        const path = match[1].trim();
        if (path && !path.includes("*") && path.length < 200) {
          paths.add(path);
        }
      }
    }

    return [...paths];
  }

  private readExcerpt(filePath: string): string {
    try {
      const content = readFileSync(filePath, "utf8");
      if (content.length <= this.budget.maxExcerptSize) {
        return content;
      }
      return content.slice(0, this.budget.maxExcerptSize) + "\n... [truncated]";
    } catch {
      return "";
    }
  }

  private estimateManifestTokens(manifest: ContextManifest): number {
    let total = 0;
    total += this.estimateTokens(manifest.objective);
    total += this.estimateTokens(manifest.acceptanceCriteria.join("\n"));
    total += this.estimateTokens(JSON.stringify(manifest.scope));
    for (const file of manifest.relevantFiles) {
      total += this.estimateTokens(file.path + (file.excerpt ?? "") + file.reason);
    }
    if (manifest.previousFailure) {
      total += this.estimateTokens(JSON.stringify(manifest.previousFailure));
    }
    total += this.estimateTokens(manifest.verificationCommands.join("\n"));
    return total;
  }
}
