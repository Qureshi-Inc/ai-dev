import { execa, type Options } from "execa";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command, capturing stdout/stderr. Throws on non-zero exit unless
 * `allowFailure` is set, in which case the failed result is returned.
 */
export async function run(
  command: string,
  args: string[],
  options: Options & { allowFailure?: boolean } = {},
): Promise<RunResult> {
  const { allowFailure, ...execaOptions } = options;
  try {
    const result = await execa(command, args, {
      ...execaOptions,
      stdio: "pipe",
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; exitCode?: number; message?: string };
    if (allowFailure) {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
        exitCode: e.exitCode ?? 1,
      };
    }
    throw err;
  }
}
