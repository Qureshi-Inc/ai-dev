const ERROR_PATTERN =
  /(error|fail(ed|ure)?|exception|traceback|assert|npm err|\bENOENT\b|cannot find|unexpected|✕|✗|FAIL )/i;

/**
 * Reduce a large raw CI log into a focused excerpt: error-matching lines (with a
 * little context) plus the tail of the log, capped to a character budget.
 */
export function extractRelevantLogs(raw: string, maxChars = 7000): string {
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const keep = new Set<number>();
  const context = 2;
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_PATTERN.test(lines[i])) {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
        keep.add(j);
      }
    }
  }

  // Always include the tail, where failures usually surface.
  const tailStart = Math.max(0, lines.length - 200);
  for (let i = tailStart; i < lines.length; i++) keep.add(i);

  const ordered = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -2;
  for (const idx of ordered) {
    if (idx !== prev + 1 && out.length > 0) out.push("  ... ...");
    out.push(lines[idx]);
    prev = idx;
  }

  let excerpt = out.join("\n");
  if (excerpt.length > maxChars) {
    excerpt = `...[head truncated]\n${excerpt.slice(excerpt.length - maxChars)}`;
  }
  return excerpt.trim() || text.slice(-maxChars);
}
