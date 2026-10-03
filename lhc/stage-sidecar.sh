#!/usr/bin/env bash
# Stage the pinned claude-lhc sidecar into <prefix> (default: lhc/.sidecar) from the committed
# lock (lhc/sidecar/package-lock.json, integrity hashes for every package), then check the
# staged claude-lhc against lhc/sidecar.json. Prints the CLAUDE_LHC_SIDECAR path on success.
# The server checks the same version and integrity again at start.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
prefix="${1:-$here/.sidecar}"
mkdir -p "$prefix"
cp "$here/sidecar/package.json" "$here/sidecar/package-lock.json" "$prefix/"
npm ci --prefix "$prefix" --no-fund --no-audit --ignore-scripts >&2
node - "$here/sidecar.json" "$prefix" <<'JS'
const fs = require("node:fs");
const [pinFile, prefix] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(pinFile, "utf8"));
const staged = JSON.parse(fs.readFileSync(`${prefix}/node_modules/${pin.package}/package.json`, "utf8"));
const lock = JSON.parse(fs.readFileSync(`${prefix}/node_modules/.package-lock.json`, "utf8"));
const integrity = lock.packages?.[`node_modules/${pin.package}`]?.integrity;
if (staged.version !== pin.version) throw new Error(`staged ${pin.package}@${staged.version}, pinned ${pin.version}`);
if (integrity !== pin.integrity) throw new Error(`staged ${pin.package} integrity ${integrity}, pinned ${pin.integrity}`);
console.log(`${prefix}/node_modules/${pin.package}/dist/sidecar.js`);
JS
