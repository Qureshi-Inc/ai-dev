// ---------------------------------------------------------------------------
// Verification Runner — deterministic verification pipeline
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../utils/exec.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationCheck {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  stdout: string;   // truncated to 5000 chars
  stderr: string;   // truncated to 5000 chars
  durationMs: number;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

const MAX_OUTPUT_LENGTH = 5000;

// ---------------------------------------------------------------------------
// Verification Runner
// ---------------------------------------------------------------------------

export class VerificationRunner {
  private log = logger.child({ component: "VerificationRunner" });

  /**
   * Run a set of verification commands against the worktree.
   * All commands run sequentially. The result is "passed" only if ALL commands pass.
   */
  async run(worktreePath: string, commands: string[]): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    this.log.info({ commandCount: commands.length, worktreePath }, "running verification");

    for (const command of commands) {
      const check = await this.runSingleCheck(worktreePath, command);
      checks.push(check);

      this.log.info(
        { name: check.name, passed: check.passed, durationMs: check.durationMs },
        "verification check completed",
      );

      // Continue running all checks even if one fails (for full diagnostic output)
    }

    const passed = checks.length > 0 && checks.every((c) => c.passed);

    return { passed, checks };
  }

  /**
   * Auto-discover verification commands from the worktree.
   * Checks package.json scripts, Makefile targets, etc.
   */
  discoverCommands(worktreePath: string): string[] {
    const commands: string[] = [];

    // 1. package.json scripts
    const pkgPath = join(worktreePath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};

        // Priority order: typecheck > lint > test > build
        if (scripts["typecheck"] || scripts["type-check"]) {
          commands.push(`npm run ${scripts["typecheck"] ? "typecheck" : "type-check"}`);
        } else if (scripts["tsc"]) {
          commands.push("npm run tsc");
        }

        if (scripts["lint"]) {
          commands.push("npm run lint");
        }

        if (scripts["test"]) {
          commands.push("npm run test");
        }

        if (scripts["build"]) {
          commands.push("npm run build");
        }
      } catch {
        // Invalid package.json, skip
      }
    }

    // 2. Makefile targets
    const makefilePath = join(worktreePath, "Makefile");
    if (existsSync(makefilePath)) {
      try {
        const content = readFileSync(makefilePath, "utf8");
        const targetMap: Array<{ target: string; priority: number }> = [
          { target: "check", priority: 1 },
          { target: "lint", priority: 2 },
          { target: "test", priority: 3 },
          { target: "build", priority: 4 },
        ];

        for (const { target } of targetMap) {
          // Match targets like "test:" at the start of a line
          if (new RegExp(`^${target}:`, "m").test(content)) {
            commands.push(`make ${target}`);
          }
        }
      } catch {
        // Can't read Makefile
      }
    }

    // 3. Check for standalone tsconfig.json (direct tsc invocation)
    if (commands.length === 0) {
      const tsconfigPath = join(worktreePath, "tsconfig.json");
      if (existsSync(tsconfigPath)) {
        commands.push("npx tsc --noEmit");
      }
    }

    return commands;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async runSingleCheck(worktreePath: string, command: string): Promise<VerificationCheck> {
    const startTime = Date.now();

    // Parse command into executable + args
    const parts = command.split(/\s+/);
    const executable = parts[0];
    const args = parts.slice(1);

    // Derive a human-readable name from the command
    const name = this.deriveCheckName(command);

    try {
      const result = await run(executable, args, {
        cwd: worktreePath,
        allowFailure: true,
        timeout: 120_000, // 2 minute timeout per check
      });

      const durationMs = Date.now() - startTime;

      return {
        name,
        command,
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        stdout: this.truncate(result.stdout),
        stderr: this.truncate(result.stderr),
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      return {
        name,
        command,
        exitCode: 1,
        passed: false,
        stdout: "",
        stderr: this.truncate(message),
        durationMs,
      };
    }
  }

  private deriveCheckName(command: string): string {
    if (command.includes("typecheck") || command.includes("type-check") || command.includes("tsc")) {
      return "typecheck";
    }
    if (command.includes("lint")) return "lint";
    if (command.includes("test")) return "test";
    if (command.includes("build")) return "build";
    if (command.includes("check")) return "check";

    // Fallback: use the command itself
    return command.length > 30 ? command.slice(0, 30) + "..." : command;
  }

  private truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    return text.slice(0, MAX_OUTPUT_LENGTH) + "\n... [truncated]";
  }
}
