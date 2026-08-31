import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ignored = new Set([".git", "node_modules", "dist", "coverage"]);
const extensions = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".example",
  ".sql",
]);
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Stripe live key", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["Twilio auth token", /\bSK[a-fA-F0-9]{32}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/],
];
const findings = [];
function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (extensions.has(extname(name)) || name.startsWith(".env")) {
      const source = readFileSync(path, "utf8");
      for (const [label, pattern] of rules)
        if (pattern.test(source))
          findings.push(`${relative(root, path)}: ${label}`);
    }
  }
}
walk(root);
if (findings.length)
  throw new Error(`Secret scan failed:\n${findings.join("\n")}`);
console.log("Secret scan passed.");
