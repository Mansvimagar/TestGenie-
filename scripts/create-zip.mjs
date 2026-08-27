// Zips the project for distribution using the system `zip` binary (no extra
// npm dependency). Excludes node_modules, .next, .env*, and git metadata.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const OUTPUT = "testgenie-mvp.zip";
const EXCLUDES = [
  "node_modules/*",
  "node_modules/**/*",
  ".next/*",
  ".next/**/*",
  ".git/*",
  ".git/**/*",
  ".env",
  ".env.local",
  "*.env.local",
  OUTPUT,
];

if (existsSync(OUTPUT)) rmSync(OUTPUT);

const args = ["-r", OUTPUT, ".", "-x", ...EXCLUDES];
const result = spawnSync("zip", args, { stdio: "inherit" });

if (result.error) {
  console.error(
    "The `zip` command was not found on this system. Install it (e.g. `apt install zip` " +
      "or `brew install zip`) and re-run `npm run zip`."
  );
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Created ${OUTPUT}`);
