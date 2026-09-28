// Bundle hooks and CLI into dependency-free single files. Plugin caches don't run
// `npm install`, so everything a hook needs must be inside the bundle. Output is .mjs so
// it runs as ESM from plugin directories that have no package.json.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const outDirs = ["dist", "plugins/claude-code/dist", "plugins/codex/dist"].map((d) => path.join(root, d));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  logLevel: "warning",
};

const entries = [
  { in: "src/hooks/main.ts", out: "hook.mjs" },
  { in: "src/cli/index.ts", out: "cli.mjs", banner: "#!/usr/bin/env node" },
];

for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

for (const e of entries) {
  const primary = path.join(outDirs[0], e.out);
  await build({
    ...common,
    entryPoints: [path.join(root, e.in)],
    outfile: primary,
    ...(e.banner ? { banner: { js: e.banner } } : {}),
  });
  fs.chmodSync(primary, 0o755);
  for (const dir of outDirs.slice(1)) {
    fs.copyFileSync(primary, path.join(dir, e.out));
    fs.chmodSync(path.join(dir, e.out), 0o755);
  }
}

// npm bin points at dist/cli.js; keep a tiny ESM shim so `npx jevcode` works.
fs.writeFileSync(path.join(outDirs[0], "cli.js"), '#!/usr/bin/env node\nimport "./cli.mjs";\n', { mode: 0o755 });

const sizes = entries.map((e) => `${e.out} ${(fs.statSync(path.join(outDirs[0], e.out)).size / 1024).toFixed(0)} KB`);
console.log(`built ${sizes.join(", ")} → ${outDirs.map((d) => path.relative(root, d)).join(", ")}`);
