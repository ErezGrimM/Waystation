import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const outDir = join(root, "dist");
const assetsDir = join(outDir, "assets");

// Clean dist
rmSync(outDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/main.tsx")],
  outdir: assetsDir,
  naming: {
    entry: "[name]-[hash].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
  minify: true,
  sourcemap: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Find the JS and CSS outputs
const jsOutput = result.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js"));
const cssOutput = result.outputs.find((o) => o.path.endsWith(".css"));

if (!jsOutput) {
  console.error("Build produced no JS entry-point output.");
  process.exit(1);
}

function basename(path: string): string {
  const name = path.split(/[\\/]/).pop();
  if (!name) throw new Error(`Cannot extract basename from: ${path}`);
  return name;
}

const jsName = basename(jsOutput.path);
const cssName = cssOutput ? basename(cssOutput.path) : null;

// Generate index.html matching the Vite output layout
const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Waystation</title>
    ${cssName ? `<link rel="stylesheet" crossorigin href="/assets/${cssName}">` : ""}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" crossorigin src="/assets/${jsName}"></script>
  </body>
</html>`;

writeFileSync(join(outDir, "index.html"), html);

// Copy favicon if present
const faviconSrc = join(root, "favicon.ico");
if (existsSync(faviconSrc)) {
  copyFileSync(faviconSrc, join(outDir, "favicon.ico"));
}

console.log(`Built ${result.outputs.length} files to. ${outDir}`);
