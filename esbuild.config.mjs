import esbuild from "esbuild";
import { copyFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const prod = process.argv[2] === "production";

// Directories/files to skip when copying node-pty (source, tests, build scripts)
const SKIP_DIRS = new Set(["src", "deps", "scripts", "node_modules", ".github"]);
const SKIP_FILES = new Set(["binding.gyp", ".npmignore", ".travis.yml"]);

async function copyDir(src, dest, skipDirs = new Set()) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    if (!entry.isDirectory() && SKIP_FILES.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

async function bundleNodePty() {
  // Copy node-pty JS + typings + native binaries into the plugin's own
  // node_modules/node-pty so main.js can require() it via __dirname.
  const src = "node_modules/node-pty";
  const dest = "node_modules_bundled/node-pty";
  if (!existsSync(src)) {
    console.warn("node-pty not found — run npm install first");
    return;
  }
  await copyDir(src, dest, SKIP_DIRS);
  console.log(`Bundled node-pty into ${dest}`);
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
    // Node built-ins — available in Electron without bundling
    "fs", "path", "os", "child_process", "util", "crypto", "events",
  ],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: prod ? false : "inline",
  minify: prod,
  logLevel: "info",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}

await bundleNodePty();
