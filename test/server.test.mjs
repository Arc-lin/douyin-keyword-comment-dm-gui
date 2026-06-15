import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createApplication,
  listenOnAvailablePort
} from "../server.mjs";

test("API persists config and only allows one active run", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-dm-server-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let releaseRunner;
  const runnerGate = new Promise((resolve) => {
    releaseRunner = resolve;
  });
  const taskRunner = async () => runnerGate;
  const { server } = await createApplication({ rootDir: root, taskRunner });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    releaseRunner();
    server.close();
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const config = {
    query: "显卡",
    publishTime: "一周内",
    videoCount: 2,
    matchesPerVideo: 1,
    keywords: "买",
    message: ""
  };

  const first = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "preview", config })
  });
  assert.equal(first.status, 201);
  const firstRun = await first.json();
  assert.equal(firstRun.status, "searching");

  const second = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "preview", config })
  });
  assert.equal(second.status, 409);

  const saved = await (await fetch(`${base}/api/config`)).json();
  assert.equal(saved.query, "显卡");
  assert.equal(saved.publishTime, "一周内");

  const stop = await fetch(`${base}/api/runs/${firstRun.id}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(stop.status, 200);
  releaseRunner();

  let terminal;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    terminal = await (await fetch(`${base}/api/runs/current`)).json();
    if (terminal.status === "stopped") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(terminal.status, "stopped");
});

test("server selects the next port when the preferred port is occupied", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-dm-port-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const blocker = http.createServer((_request, response) => response.end("busy"));
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const preferredPort = blocker.address().port;

  const { server } = await createApplication({ rootDir: root });
  t.after(() => server.close());
  const listening = await listenOnAvailablePort(server, {
    preferredPort,
    maxAttempts: 10
  });

  assert.ok(listening.port > preferredPort);
  const health = await (await fetch(`${listening.url}/api/health`)).json();
  assert.equal(health.app, "douyin-keyword-comment-dm-gui");
});
