import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const { version: APP_VERSION } = createRequire(import.meta.url)("../package.json");
const BUILD_DIR = path.join(ROOT_DIR, "dist", ".build");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const OUTPUT_EXE = path.join(DIST_DIR, `DouyinKeywordCommentDM-v${APP_VERSION}.exe`);
const PAYLOAD_MAGIC = Buffer.from("DYAPP001", "ascii");
const RUNTIME_PATHS = [
  "package.json",
  "server.mjs",
  "lib",
  "public",
  "node_modules/playwright",
  "node_modules/playwright-core"
];

async function collectFiles(relativePath, output) {
  const absolutePath = path.join(ROOT_DIR, relativePath);
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Runtime payload cannot contain symlinks: ${relativePath}`);
  }
  if (stats.isFile()) {
    output.push(relativePath.replaceAll(path.sep, "/"));
    return;
  }
  if (!stats.isDirectory()) return;

  const children = await fs.readdir(absolutePath);
  children.sort((left, right) => left.localeCompare(right, "en"));
  for (const child of children) {
    await collectFiles(path.join(relativePath, child), output);
  }
}

async function createPayload(outputPath) {
  const relativeFiles = [];
  for (const runtimePath of RUNTIME_PATHS) {
    await collectFiles(runtimePath, relativeFiles);
  }

  const manifest = [];
  const contents = [];
  for (const relativePath of relativeFiles) {
    const content = await fs.readFile(path.join(ROOT_DIR, relativePath));
    manifest.push({ path: relativePath, size: content.length });
    contents.push(content);
  }

  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32LE(manifestBuffer.length);
  const payload = Buffer.concat([
    PAYLOAD_MAGIC,
    manifestLength,
    manifestBuffer,
    ...contents
  ]);
  const compressed = zlib.gzipSync(payload, { level: 9 });
  await fs.writeFile(outputPath, compressed);

  return {
    compressedBytes: compressed.length,
    files: relativeFiles.length,
    hash: crypto.createHash("sha256").update(compressed).digest("hex")
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result.stdout.trim();
}

await fs.rm(BUILD_DIR, { recursive: true, force: true });
await fs.mkdir(BUILD_DIR, { recursive: true });
await fs.mkdir(DIST_DIR, { recursive: true });

const payloadPath = path.join(BUILD_DIR, "app-payload.gz");
const payload = await createPayload(payloadPath);
const seaBlobPath = path.join(BUILD_DIR, "sea-prep.blob");
const seaConfigPath = path.join(BUILD_DIR, "sea-config.json");
const bootstrapPath = path.join(ROOT_DIR, "packaging", "sea-bootstrap.cjs");
await fs.writeFile(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: bootstrapPath,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: {
        "app-payload.gz": payloadPath
      }
    },
    null,
    2
  )}\n`,
  "utf8"
);

run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
await fs.copyFile(process.execPath, OUTPUT_EXE);

const postjectCli = path.join(
  ROOT_DIR,
  "node_modules",
  "postject",
  "dist",
  "cli.js"
);
run(process.execPath, [
  postjectCli,
  OUTPUT_EXE,
  "NODE_SEA_BLOB",
  seaBlobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
]);

const verification = run(OUTPUT_EXE, ["--verify-package"]);
const executableStats = await fs.stat(OUTPUT_EXE);
await fs.rm(BUILD_DIR, { recursive: true, force: true });
console.log(
  [
    `Built ${path.relative(ROOT_DIR, OUTPUT_EXE)}`,
    `Version: ${APP_VERSION}`,
    `Runtime files: ${payload.files}`,
    `Compressed payload: ${(payload.compressedBytes / 1024 / 1024).toFixed(2)} MiB`,
    `Executable: ${(executableStats.size / 1024 / 1024).toFixed(2)} MiB`,
    `Payload SHA-256: ${payload.hash}`,
    verification
  ].join("\n")
);
