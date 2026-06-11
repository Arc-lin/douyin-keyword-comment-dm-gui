import test from "node:test";
import assert from "node:assert/strict";
import { processMatchedUsers } from "../lib/douyin-runner.mjs";

test("preview mode records candidates without invoking the sender", async () => {
  const results = [];
  let sendCalls = 0;
  const run = {
    addResult(result) {
      results.push(result);
    },
    throwIfStopped() {},
    log() {}
  };

  await processMatchedUsers({
    mode: "preview",
    matches: [{ username: "用户甲", commentText: "我想买", userId: "a" }],
    run,
    send: async () => {
      sendCalls += 1;
    }
  });

  assert.equal(sendCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "preview");
});
