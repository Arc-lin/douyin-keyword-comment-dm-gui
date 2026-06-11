import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Storage } from "../lib/storage.mjs";

test("contacted user history persists and deduplicates by user ID when loaded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-dm-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  await storage.initialize();
  await storage.appendContactedUser({ userId: "abc", username: "第一次" });
  await storage.appendContactedUser({ userId: "abc", username: "最后一次" });
  await storage.appendContactedUser({ userId: "def", username: "另一个用户" });

  const users = await storage.loadContactedUsers();
  assert.equal(users.size, 2);
  assert.equal(users.get("abc").username, "最后一次");
});

test("config is empty for business fields on first run and persists after save", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-dm-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  await storage.initialize();
  assert.equal((await storage.readConfig()).query, "");

  await storage.saveConfig({ query: "显卡", keywords: "买", message: "你好" });
  const config = await storage.readConfig();
  assert.equal(config.query, "显卡");
  assert.equal(config.message, "你好");
});
