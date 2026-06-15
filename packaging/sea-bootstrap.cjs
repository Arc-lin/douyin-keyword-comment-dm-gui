const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");
const { getAsset } = require("node:sea");

const APP_DIRECTORY = "DouyinKeywordCommentDM";
const PAYLOAD_ASSET = "app-payload.gz";
const PAYLOAD_MAGIC = "DYAPP001";

function appendLauncherLog(appRoot, message) {
  fs.mkdirSync(appRoot, { recursive: true });
  fs.appendFileSync(
    path.join(appRoot, "launcher.log"),
    `${new Date().toISOString()} ${message}\n`,
    "utf8"
  );
}

function showFatalError(error, logPath) {
  if (process.platform !== "win32") return;
  const detail = `${error.message || error}\n\nLog: ${logPath}`;
  const encodedDetail = Buffer.from(detail, "utf8").toString("base64");
  const script = [
    "Add-Type -AssemblyName PresentationFramework",
    `$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDetail}'))`,
    "[System.Windows.MessageBox]::Show($message, 'Douyin Launcher', 'OK', 'Error')"
  ].join("; ");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error(`Invalid payload path: ${relativePath}`);
  }
  return target;
}

function unpackPayload(compressedPayload, destination) {
  const payload = zlib.gunzipSync(compressedPayload);
  if (payload.subarray(0, 8).toString("ascii") !== PAYLOAD_MAGIC) {
    throw new Error("Invalid packaged application payload");
  }

  const manifestLength = payload.readUInt32LE(8);
  const manifestStart = 12;
  const manifestEnd = manifestStart + manifestLength;
  const manifest = JSON.parse(
    payload.subarray(manifestStart, manifestEnd).toString("utf8")
  );
  let contentOffset = manifestEnd;

  for (const entry of manifest) {
    const outputPath = resolveInside(destination, entry.path);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      payload.subarray(contentOffset, contentOffset + entry.size)
    );
    contentOffset += entry.size;
  }

  if (contentOffset !== payload.length) {
    throw new Error("Packaged application payload is truncated");
  }
}

function prepareRuntime(compressedPayload, appRoot) {
  const payloadHash = crypto
    .createHash("sha256")
    .update(compressedPayload)
    .digest("hex")
    .slice(0, 16);
  const runtimesRoot = path.join(appRoot, "runtime");
  const runtimeDir = path.join(runtimesRoot, payloadHash);
  const markerPath = path.join(runtimeDir, ".ready");

  if (fs.existsSync(markerPath)) return runtimeDir;

  fs.mkdirSync(runtimesRoot, { recursive: true });
  const temporaryDir = `${runtimeDir}.tmp-${process.pid}`;
  fs.rmSync(temporaryDir, { recursive: true, force: true });
  fs.mkdirSync(temporaryDir, { recursive: true });

  try {
    unpackPayload(compressedPayload, temporaryDir);
    fs.writeFileSync(path.join(temporaryDir, ".ready"), `${payloadHash}\n`);
    try {
      fs.renameSync(temporaryDir, runtimeDir);
    } catch (error) {
      if (!fs.existsSync(markerPath)) throw error;
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }

  return runtimeDir;
}

async function run() {
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  const appRoot = path.join(localAppData, APP_DIRECTORY);
  const compressedPayload = Buffer.from(getAsset(PAYLOAD_ASSET));
  const runtimeDir = prepareRuntime(compressedPayload, appRoot);

  process.env.DOUYIN_DATA_DIR ||= path.join(appRoot, "data");
  process.env.OPEN_BROWSER ||= "1";
  process.chdir(runtimeDir);

  const serverModule = await import(
    pathToFileURL(path.join(runtimeDir, "server.mjs")).href
  );
  if (process.argv.includes("--verify-package")) {
    console.log(`Package verified: ${runtimeDir}`);
    return;
  }
  appendLauncherLog(appRoot, `launch pid=${process.pid}`);
  const listening = await serverModule.main();
  appendLauncherLog(appRoot, `ready url=${listening.url}`);
}

run().catch((error) => {
  const message = `${new Date().toISOString()}\n${error.stack || error}\n\n`;
  let logPath;
  try {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    const logDir = path.join(localAppData, APP_DIRECTORY);
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, "launcher-error.log");
    fs.appendFileSync(logPath, message, "utf8");
  } catch {
    // The console error below is still useful when the log cannot be written.
  }
  showFatalError(error, logPath || "launcher-error.log");
  console.error(error);
  process.exitCode = 1;
});
