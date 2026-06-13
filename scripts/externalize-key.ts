/**
 * Moves an inline multi-line GITHUB_PRIVATE_KEY out of .env into a .pem file and
 * switches .env to GITHUB_PRIVATE_KEY_PATH. This avoids Docker Compose env_file's
 * single-line/quote limitations. The key is never printed.
 *
 * Uses an absolute path that is identical on host and inside the container (the
 * compose file mounts ./secrets at the same absolute path), so local dev and the
 * container both resolve it.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ENV = ".env";
const PEM_REL = "secrets/github-app.pem";
const PEM_ABS = "/home/opti3/services/ai-dev/secrets/github-app.pem";

let raw = readFileSync(ENV, "utf8");

const re = /GITHUB_PRIVATE_KEY="([\s\S]*?)"/;
const m = raw.match(re);
if (!m) {
  console.error("No quoted GITHUB_PRIVATE_KEY=\"...\" block found in .env; nothing to do.");
  process.exit(1);
}

let key = m[1];
// If it was stored with escaped newlines, normalise to real newlines for the .pem.
if (key.includes("\\n") && !key.includes("\n")) key = key.replace(/\\n/g, "\n");
if (!key.includes("BEGIN") || !key.includes("PRIVATE KEY")) {
  console.error("Extracted value does not look like a PEM private key; aborting.");
  process.exit(1);
}
if (!key.endsWith("\n")) key += "\n";

mkdirSync("secrets", { recursive: true });
writeFileSync(PEM_REL, key, { mode: 0o600 });

// Empty the inline key and point the path var at the absolute pem location.
raw = raw.replace(re, "GITHUB_PRIVATE_KEY=");
if (/^GITHUB_PRIVATE_KEY_PATH=.*/m.test(raw)) {
  raw = raw.replace(/^GITHUB_PRIVATE_KEY_PATH=.*/m, `GITHUB_PRIVATE_KEY_PATH=${PEM_ABS}`);
} else {
  raw += `\nGITHUB_PRIVATE_KEY_PATH=${PEM_ABS}\n`;
}
writeFileSync(ENV, raw);

console.log(`OK: wrote ${PEM_REL} (mode 600), set GITHUB_PRIVATE_KEY_PATH=${PEM_ABS}`);
