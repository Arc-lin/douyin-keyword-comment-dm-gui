import test from "node:test";
import assert from "node:assert/strict";
import {
  parseKeywords,
  normalizeDisplayName,
  resultsToCsv,
  sampleWithoutReplacement,
  validateConfig
} from "../lib/core.mjs";

test("parseKeywords supports commas, Chinese commas and newlines with dedupe", () => {
  assert.deepEqual(parseKeywords("买,购买，想买\n买"), ["买", "购买", "想买"]);
});

test("normalizeDisplayName ignores decorative symbols but preserves the name", () => {
  assert.equal(normalizeDisplayName("⭐小🐟马⭐"), "小马");
  assert.equal(
    normalizeDisplayName("F1n3⚡️（黑屋毁灭者）"),
    normalizeDisplayName("F1n3（黑屋毁灭者）")
  );
});

test("preview does not require message but send does", () => {
  const config = { query: "显卡", keywords: "买", videoCount: 2, matchesPerVideo: 1 };
  assert.equal(validateConfig(config, "preview").errors.includes("发送模式下私信内容不能为空"), false);
  assert.equal(validateConfig(config, "send").errors.includes("发送模式下私信内容不能为空"), true);
});

test("sampleWithoutReplacement never duplicates items", () => {
  const values = sampleWithoutReplacement([1, 2, 3, 4], 4, () => 0.25);
  assert.equal(values.length, 4);
  assert.equal(new Set(values).size, 4);
});

test("resultsToCsv escapes values and emits UTF-8 BOM", () => {
  const csv = resultsToCsv([
    {
      videoTitle: '标题 "A"',
      username: "用户甲",
      commentText: "想买,\n看看",
      status: "sent"
    }
  ]);
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.match(csv, /"标题 ""A"""/);
  assert.match(csv, /"想买,\n看看"/);
});
