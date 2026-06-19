#!/usr/bin/env bash
# Builds the real Fundamental game logic for headless (Node) execution.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)/Fundamental"
git clone --depth 1 https://github.com/awWhy/Fundamental.git "$WORK"
# Guard only the browser "Start everything" boot block; keep all init + exports.
perl -0pi -e 's/\ntry \{ \/\/Start everything/\nif (!globalThis.__HEADLESS__) try { \/\/Start everything/' "$WORK/Source_TS/Main.ts"
cat > "$WORK/tsconfig.node.json" <<JSON
{ "compilerOptions": { "target":"ES2022","module":"commonjs","moduleResolution":"node","esModuleInterop":true,
  "outDir":"$DIR/build","rootDir":"Source_TS","lib":["ESNext","DOM","DOM.Iterable"],"skipLibCheck":true,
  "noEmitOnError":false,"removeComments":true,"strict":false,"noUnusedLocals":false,"noUnusedParameters":false,
  "noImplicitAny":false,"noImplicitReturns":false,"allowUnreachableCode":true,"allowUnusedLabels":true },
  "include":["Source_TS/**/*.ts"] }
JSON
( cd "$WORK" && npx -p typescript tsc -p tsconfig.node.json || true )
echo "Built game modules to $DIR/build"
