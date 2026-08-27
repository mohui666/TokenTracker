const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { build } = require("esbuild");

const repoRoot = path.join(__dirname, "..", "..");

async function loadDashboardModule(relativePath) {
  const entryPoint = path.join(repoRoot, relativePath);
  const copyPluginPath = path.join(repoRoot, "dashboard", "scripts", "copy-registry-plugin.mjs");
  const { readCopyRegistry } = await import(pathToFileURL(copyPluginPath).href);
  const requireShim = `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(entryPoint)});`;
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    sourcemap: "inline",
    write: false,
    banner: { js: requireShim },
    plugins: [
      {
        name: "raw-query-loader",
        setup(build) {
          build.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
            namespace: "raw-file",
          }));
          build.onLoad({ filter: /.*/, namespace: "raw-file" }, async (args) => ({
            contents: `export default ${JSON.stringify(await fs.promises.readFile(args.path, "utf8"))};`,
            loader: "js",
          }));
        },
      },
      {
        name: "copy-registry-loader",
        setup(build) {
          build.onResolve({ filter: /^virtual:tokentracker-copy-registry$/ }, () => ({
            path: "tokentracker-copy-registry",
            namespace: "copy-registry",
          }));
          build.onLoad({ filter: /.*/, namespace: "copy-registry" }, () => ({
            contents: `export default ${JSON.stringify(readCopyRegistry())};`,
            loader: "js",
          }));
        },
      },
    ],
  });

  const source = result.outputFiles[0]?.text ?? "";
  const base64 = Buffer.from(source, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${base64}`);
}

module.exports = { loadDashboardModule };
