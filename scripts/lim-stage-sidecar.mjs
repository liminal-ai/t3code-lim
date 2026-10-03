import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
const dest = resolve("lhc/.sidecar");
mkdirSync(dest, { recursive: true });
for (const name of ["package.json", "package-lock.json"])
  cpSync(`lhc/sidecar/${name}`, `${dest}/${name}`);
execSync("npm ci --ignore-scripts --no-audit --no-fund", { cwd: dest, stdio: "inherit" });
const pin = JSON.parse(readFileSync("lhc/sidecar.json", "utf8"));
const pkg = JSON.parse(readFileSync(`${dest}/node_modules/claude-lhc/package.json`, "utf8"));
const lock = JSON.parse(readFileSync(`${dest}/node_modules/.package-lock.json`, "utf8"));
if (
  pkg.version !== pin.version ||
  lock.packages["node_modules/claude-lhc"].integrity !== pin.integrity
)
  throw new Error("LHC pin mismatch");
