import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { resultsToCsv, validateConfig } from "./lib/core.mjs";
import {
  FatalRunError,
  runDouyinTask,
  StoppedError
} from "./lib/douyin-runner.mjs";
import { pickBrowserPath } from "./lib/browser-picker.mjs";
import { Storage } from "./lib/storage.mjs";

const { name: APP_NAME, version: APP_VERSION } =
  createRequire(import.meta.url)("./package.json");
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const TERMINAL_STATUSES = new Set(["completed", "stopped", "failed"]);

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function text(response, status, value, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(value);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class RunController {
  constructor({ id, mode, config, storage, taskRunner = runDouyinTask }) {
    this.id = id;
    this.mode = mode;
    this.config = config;
    this.storage = storage;
    this.taskRunner = taskRunner;
    this.status = "idle";
    this.message = "等待开始";
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.results = [];
    this.events = [];
    this.listeners = new Set();
    this.abortRequested = false;
    this.continueResolver = null;
    this.counts = {
      candidateVideos: 0,
      selectedVideos: 0,
      scannedComments: 0,
      matchedUsers: 0,
      sent: 0,
      blocked: 0,
      failed: 0
    };
  }

  snapshot() {
    return {
      id: this.id,
      mode: this.mode,
      status: this.status,
      message: this.message,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      counts: this.counts,
      results: this.results
    };
  }

  emit(type, data = {}) {
    this.updatedAt = new Date().toISOString();
    const event = {
      id: randomUUID(),
      timestamp: this.updatedAt,
      type,
      ...data,
      snapshot: this.snapshot()
    };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    const { snapshot: _snapshot, ...persistedEvent } = event;
    this.storage.appendRunEvent(this.id, persistedEvent).catch(() => {});
    for (const listener of this.listeners) listener(event);
  }

  setStatus(status, message = this.message) {
    this.status = status;
    this.message = message;
    this.emit("status", { status, message });
  }

  log(level, message) {
    this.emit("log", { level, message });
  }

  updateCounts(partial) {
    this.counts = { ...this.counts, ...partial };
    this.emit("counts", { counts: this.counts });
  }

  addResult(result) {
    this.results.push(result);
    this.emit("result", { result });
    this.storage.writeRunResults(this.id, this.results).catch(() => {});
  }

  throwIfStopped() {
    if (this.abortRequested) throw new StoppedError();
  }

  waitForContinue() {
    if (this.abortRequested) throw new StoppedError();
    return new Promise((resolve) => {
      this.continueResolver = resolve;
    });
  }

  continue() {
    const resolver = this.continueResolver;
    this.continueResolver = null;
    resolver?.();
  }

  stop() {
    this.abortRequested = true;
    this.continue();
    this.log("warn", "已请求停止，将在当前原子操作结束后退出");
  }

  async start() {
    await this.storage.prepareRun(this.id);
    this.emit("created", { mode: this.mode, config: this.config });
    try {
      await this.taskRunner(this, this.storage);
      this.throwIfStopped();
      this.setStatus("completed", this.mode === "preview" ? "预览完成" : "发送任务完成");
    } catch (error) {
      if (error instanceof StoppedError) {
        this.setStatus("stopped", "任务已停止");
      } else {
        const message =
          error instanceof FatalRunError ? error.message : `任务失败：${error.message}`;
        this.log("error", message);
        this.setStatus("failed", message);
      }
    } finally {
      await this.storage.writeRunResults(this.id, this.results);
    }
  }
}

export async function createApplication({
  rootDir = ROOT_DIR,
  dataDir = process.env.DOUYIN_DATA_DIR || path.join(rootDir, "data"),
  taskRunner = runDouyinTask
} = {}) {
  const storage = new Storage(rootDir, dataDir);
  await storage.initialize();
  const runs = new Map();
  let activeRun = null;

  async function serveIndex(response) {
    try {
      const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
      text(response, 200, html, "text/html; charset=utf-8");
    } catch (error) {
      text(response, 500, `无法读取界面：${error.message}`);
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "GET" && pathname === "/") {
        await serveIndex(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/health") {
        json(response, 200, {
          app: APP_NAME,
          version: APP_VERSION
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/config") {
        json(response, 200, await storage.readConfig());
        return;
      }

      if (request.method === "POST" && pathname === "/api/browsers/pick") {
        try {
          const selectedPath = await pickBrowserPath();
          json(response, 200, { path: selectedPath });
        } catch (error) {
          json(response, 500, { error: error.message });
        }
        return;
      }

      if (request.method === "PUT" && pathname === "/api/config") {
        const body = await readJsonBody(request);
        const validation = validateConfig(body, "preview");
        if (validation.errors.length) {
          json(response, 400, { errors: validation.errors });
          return;
        }
        await storage.saveConfig(validation.value);
        json(response, 200, validation.value);
        return;
      }

      if (request.method === "GET" && pathname === "/api/runs/current") {
        json(response, 200, activeRun?.snapshot() ?? null);
        return;
      }

      if (request.method === "POST" && pathname === "/api/runs") {
        if (activeRun && !TERMINAL_STATUSES.has(activeRun.status)) {
          json(response, 409, { error: "已有任务正在运行" });
          return;
        }

        const body = await readJsonBody(request);
        const mode = body.mode === "send" ? "send" : "preview";
        const validation = validateConfig(body.config, mode);
        if (validation.errors.length) {
          json(response, 400, { errors: validation.errors });
          return;
        }

        await storage.saveConfig(validation.value);
        const run = new RunController({
          id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
          mode,
          config: validation.value,
          storage,
          taskRunner
        });
        runs.set(run.id, run);
        activeRun = run;
        run.setStatus("searching", "正在准备任务");
        run.start().catch(() => {});
        json(response, 201, run.snapshot());
        return;
      }

      const continueMatch = pathname.match(/^\/api\/runs\/([^/]+)\/continue$/);
      if (request.method === "POST" && continueMatch) {
        const run = runs.get(continueMatch[1]);
        if (!run) {
          json(response, 404, { error: "任务不存在" });
          return;
        }
        run.continue();
        json(response, 200, run.snapshot());
        return;
      }

      const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const run = runs.get(stopMatch[1]);
        if (!run) {
          json(response, 404, { error: "任务不存在" });
          return;
        }
        run.stop();
        json(response, 200, run.snapshot());
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const run = runs.get(eventsMatch[1]);
        if (!run) {
          json(response, 404, { error: "任务不存在" });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        response.write(`event: snapshot\ndata: ${JSON.stringify(run.snapshot())}\n\n`);
        const listener = (event) => {
          response.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
        };
        run.listeners.add(listener);
        request.on("close", () => run.listeners.delete(listener));
        return;
      }

      const csvMatch = pathname.match(/^\/api\/runs\/([^/]+)\/results\.csv$/);
      if (request.method === "GET" && csvMatch) {
        const run = runs.get(csvMatch[1]);
        if (!run) {
          json(response, 404, { error: "任务不存在" });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="douyin-run-${run.id}.csv"`,
          "cache-control": "no-store"
        });
        response.end(resultsToCsv(run.results));
        return;
      }

      text(response, 404, "Not Found");
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });

  return { server, storage, runs, getActiveRun: () => activeRun };
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openBrowser(url) {
  if (process.platform !== "win32") return;
  const openers = [
    ["explorer.exe", [url]],
    ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
  ];
  let lastError;
  for (const [command, args] of openers) {
    try {
      await spawnDetached(command, args);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function listenOnAvailablePort(
  server,
  { host = "127.0.0.1", preferredPort = 3210, maxAttempts = 20 } = {}
) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65535) break;
    try {
      await listenOnce(server, port, host);
      return { host, port, url: `http://${host}:${port}` };
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(
    `No available port found from ${preferredPort} to ${Math.min(
      preferredPort + maxAttempts - 1,
      65535
    )}`
  );
}

export async function main() {
  const { server } = await createApplication();
  const host = "127.0.0.1";
  const preferredPort = Number.parseInt(process.env.PORT || "3210", 10);
  const listening = await listenOnAvailablePort(server, {
    host,
    preferredPort
  });
  console.log(`抖音评论关键词私信 GUI 已启动：${listening.url}`);
  if (process.env.OPEN_BROWSER === "1") await openBrowser(listening.url);
  return listening;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
