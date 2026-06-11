import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  applySearch,
  detectPageGate,
  discoverBrowserExecutable,
  extractSearchCandidates,
  extractTopLevelComments,
  openCandidate,
  selectSearchFilterOption,
  sendDirectMessage,
  waitForComments
} from "../lib/douyin-page.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withPage(callback) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: discoverBrowserExecutable()
  });
  try {
    const page = await browser.newPage();
    return await callback(page);
  } finally {
    await browser.close();
  }
}

test("DOM fixture extracts video cards and excludes graphic posts", async () => {
  await withPage(async (page) => {
    const html = await fs.readFile(path.join(TEST_DIR, "fixtures", "douyin-page.html"), "utf8");
    await page.setContent(html);
    const candidates = await extractSearchCandidates(page, 30);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, "显卡检测教程");
    assert.equal(candidates[0].author, "黑客船长");
  });
});

test("DOM fixture extracts only top-level comments", async () => {
  await withPage(async (page) => {
    const html = await fs.readFile(path.join(TEST_DIR, "fixtures", "douyin-page.html"), "utf8");
    await page.setContent(html);
    const comments = await extractTopLevelComments(page, 80);
    assert.equal(comments.length, 2);
    assert.equal(comments.some((comment) => comment.username === "回复用户"), false);
    assert.equal(comments[0].commentText, "这个在哪里买比较好");
    assert.equal(comments[1].isAuthor, true);
  });
});

test("author replies and author-liked labels do not mark the parent commenter as author", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <!doctype html>
      <html><body>
        <div data-e2e="comment-item">
          <a href="/user/buyer"><img alt="用户头像"></a>
          <div>
            <a href="/user/buyer">@想买显卡</a>
            <div data-e2e="comment-text">这个我想买 作者赞过</div>
            <span>分享</span><span>回复</span>
          </div>
          <div class="replyContainer">
            <div>
              <a href="/user/author">
                <span>视频作者</span><span>作者</span>
              </a>
              <div data-e2e="comment-text">可以看看</div>
              <span>分享</span><span>回复</span>
            </div>
          </div>
        </div>
      </body></html>
    `);
    const comments = await extractTopLevelComments(page, 80);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].username, "@想买显卡");
    assert.equal(comments[0].commentText, "这个我想买 作者赞过");
    assert.equal(comments[0].isAuthor, false);
  });
});

test("gate detection catches a visible captcha overlay without text", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <!doctype html>
      <html><body>
        <button>搜索</button>
        <div id="captcha_container" style="position:fixed;inset:0">
          <iframe src="https://verify.example.test/challenge"></iframe>
        </div>
      </body></html>
    `);
    const gate = await detectPageGate(page);
    assert.deepEqual(gate, {
      type: "login",
      detail: "页面出现验证码或人工安全验证覆盖层"
    });
  });
});

test("search blank state visits the home feed before retrying", async () => {
  await withPage(async (page) => {
    let searchVisits = 0;
    let homeVisits = 0;
    await page.route("https://www.douyin.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/jingxuan") {
        homeVisits += 1;
        await route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body>精选</body></html>"
        });
        return;
      }

      if (url.pathname.startsWith("/search/")) {
        searchVisits += 1;
        await route.fulfill({
          contentType: "text/html",
          body:
            searchVisits === 1
              ? "<!doctype html><html><body><button>筛选</button></body></html>"
              : `<!doctype html><html><body>
                  <button>筛选</button>
                  <div data-index1="4" data-index2="1">视频</div>
                  <div class="search-result-card">00:10
                    1
                    显卡测试
                    @测试用户
                    · 1小时前
                  </div>
                </body></html>`
        });
        return;
      }

      await route.continue();
    });

    const result = await applySearch(page, {
      query: "显卡",
      sortOrder: "综合排序",
      publishTime: "不限",
      actionTimeoutMs: 1_000,
      navigationTimeoutMs: 400
    });

    assert.equal(result.retried, true);
    assert.equal(searchVisits, 2);
    assert.equal(homeVisits, 1);
  });
});

test("comment wait scrolls the heading into view before accepting comments", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <!doctype html>
      <html><body style="margin:0">
        <div>
          <a href="/user/outside">推荐用户</a>
          <span>分享</span><span>回复</span>
        </div>
        <div style="height:1500px"></div>
        <h2 id="heading">全部评论</h2>
        <div class="comment-mainContent" id="comments">加载中</div>
        <script>
          const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            setTimeout(() => {
              document.querySelector("#comments").innerHTML = \`
                <div data-e2e="comment-item">
                  <a href="/user/123">用户甲</a>
                  <span>评论正文</span>
                  <span>分享</span>
                  <span>回复</span>
                </div>
              \`;
            }, 400);
            observer.disconnect();
          });
          observer.observe(document.querySelector("#heading"));
        </script>
      </body></html>
    `);
    await waitForComments(page, 3_000);
    assert.equal(await page.locator('[data-e2e="comment-item"]').count(), 1);
    assert.equal(
      await page.locator("#heading").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top < window.innerHeight && rect.bottom > 0;
      }),
      true
    );
  });
});

test("message send survives a contenteditable replacement after filling", async () => {
  await withPage(async (page) => {
    const html = `
      <!doctype html>
      <html><body>
        <button id="dm">私信</button>
        <section id="conversation"></section>
        <script>
          function handleSend(event) {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const message = document.createElement("span");
            message.textContent = event.currentTarget.innerText;
            document.querySelector("#conversation").append(message);
            event.currentTarget.innerText = "";
          }

          document.querySelector("#dm").addEventListener("click", () => {
            setTimeout(() => {
              const editor = document.createElement("div");
              editor.id = "editor";
              editor.contentEditable = "true";
              editor.dataset.placeholder = "发送消息";
              editor.style = "width:300px;height:40px";
              editor.addEventListener("input", () => {
                const replacement = editor.cloneNode(true);
                replacement.removeAttribute("data-placeholder");
                replacement.addEventListener("keydown", handleSend);
                editor.replaceWith(replacement);
              });
              editor.addEventListener("keydown", handleSend);
              document.body.append(editor);
            }, 900);
          });
        </script>
      </body></html>
    `;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const result = await sendDirectMessage(page, url, "你好", {
      actionTimeoutMs: 3_000,
      dmReadyTimeoutMs: 3_000,
      dmOpenRetries: 1,
      navigationTimeoutMs: 10_000
    });
    assert.equal(result.status, "sent");
    assert.match(result.detail, /输入框等待/);
    assert.equal(await page.getByText("你好", { exact: true }).count(), 1);
  });
});

test("message send refuses to use an editor from the wrong active conversation", async () => {
  await withPage(async (page) => {
    const html = `
      <!doctype html>
      <html><body>
        <h1>目标用户</h1>
        <button id="dm">私信</button>
        <script>
          document.querySelector("#dm").addEventListener("click", () => {
            document.body.insertAdjacentHTML("beforeend", \`
              <div class="componentsRightPanelwrapper">
                <div class="RightPanelHeadertitle">上一位用户</div>
                <div contenteditable="true" data-placeholder="发送消息"
                     style="width:300px;height:40px"></div>
              </div>
            \`);
          });
        </script>
      </body></html>
    `;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const result = await sendDirectMessage(page, url, "你好", {
      actionTimeoutMs: 1_000,
      dmReadyTimeoutMs: 500,
      dmOpenRetries: 1,
      navigationTimeoutMs: 10_000
    });
    assert.equal(result.status, "failed");
    assert.match(result.detail, /当前为“上一位用户”/);
    assert.equal(
      (await page.locator('[contenteditable="true"]').allInnerTexts()).every(
        (text) => text.trim() === ""
      ),
      true
    );
  });
});

test("message send returns a user-level failure when text remains unsent", async () => {
  await withPage(async (page) => {
    const html = `
      <!doctype html>
      <html><body>
        <button id="dm">私信</button>
        <script>
          document.querySelector("#dm").addEventListener("click", () => {
            const editor = document.createElement("div");
            editor.contentEditable = "true";
            editor.dataset.placeholder = "发送消息";
            editor.style = "width:300px;height:40px";
            document.body.append(editor);
          });
        </script>
      </body></html>
    `;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const result = await sendDirectMessage(page, url, "你好", {
      actionTimeoutMs: 600,
      dmReadyTimeoutMs: 600,
      dmOpenRetries: 1,
      navigationTimeoutMs: 10_000
    });
    assert.equal(result.status, "failed");
    assert.match(result.detail, /内容已填入/);
    assert.equal(
      (await page.locator('[contenteditable="true"]').innerText()).trim(),
      "你好"
    );
  });
});

test("message send reports a timed out floating window without navigating away early", async () => {
  await withPage(async (page) => {
    const html = `
      <!doctype html>
      <html><body>
        <button id="dm">私信</button>
        <div id="opened"></div>
        <script>
          document.querySelector("#dm").addEventListener("click", () => {
            document.querySelector("#opened").textContent = "私信浮窗已打开";
          });
        </script>
      </body></html>
    `;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const result = await sendDirectMessage(page, url, "你好", {
      actionTimeoutMs: 1_000,
      dmReadyTimeoutMs: 300,
      dmOpenRetries: 1,
      navigationTimeoutMs: 10_000
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.detail, /2 次 DOM 监听仍未加载输入框/);
    assert.equal(await page.getByText("私信浮窗已打开").count(), 1);
  });
});

test("message send catches a late panel during a DOM-observed retry", async () => {
  await withPage(async (page) => {
    const html = `
      <!doctype html>
      <html><body>
        <h1>延迟用户</h1>
        <button id="dm">私信</button>
        <section id="conversation"></section>
        <script>
          let scheduled = false;
          function send(event) {
            if (event.key !== "Enter") return;
            const message = document.createElement("span");
            message.textContent = event.currentTarget.innerText;
            document.querySelector("#conversation").append(message);
            event.currentTarget.innerText = "";
          }
          document.querySelector("#dm").addEventListener("click", () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => {
              document.body.insertAdjacentHTML("beforeend", \`
                <div class="componentsRightPanelwrapper">
                  <div class="RightPanelHeadertitle">⭐延迟用户⭐</div>
                  <div id="editor" contenteditable="true" data-placeholder="发送消息"
                       style="width:300px;height:40px"></div>
                </div>
              \`);
              document.querySelector("#editor").addEventListener("keydown", send);
            }, 450);
          });
        </script>
      </body></html>
    `;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const stages = [];
    const result = await sendDirectMessage(
      page,
      url,
      "你好",
      {
        actionTimeoutMs: 1_000,
        dmReadyTimeoutMs: 300,
        dmOpenRetries: 2,
        navigationTimeoutMs: 10_000
      },
      {
        expectedUsername: "延迟用户",
        onStage: (message) => stages.push(message)
      }
    );
    assert.equal(result.status, "sent");
    assert.equal(stages.some((message) => message.includes("重新唤起")), true);
  });
});

test("message send accepts decorative differences in the active conversation", async () => {
  await withPage(async (page) => {
    const html = `
      <!doctype html>
      <html><body>
        <h1>小马</h1>
        <button id="dm">私信</button>
        <section id="conversation"></section>
        <script>
          document.querySelector("#dm").addEventListener("click", () => {
            if (document.querySelector("#editor")) return;
            document.body.insertAdjacentHTML("beforeend", \`
              <div class="componentsRightPanelwrapper">
                <div class="RightPanelHeadertitle">⭐小🐟马⭐</div>
                <div id="editor" contenteditable="true" data-placeholder="发送消息"
                     style="width:300px;height:40px"></div>
              </div>
            \`);
            document.querySelector("#editor").addEventListener("keydown", (event) => {
              if (event.key !== "Enter") return;
              const message = document.createElement("span");
              message.textContent = event.currentTarget.innerText;
              document.querySelector("#conversation").append(message);
              event.currentTarget.innerText = "";
            });
          });
        </script>
      </body></html>
    `;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const result = await sendDirectMessage(
      page,
      url,
      "你好",
      {
        actionTimeoutMs: 1_000,
        dmReadyTimeoutMs: 1_000,
        dmOpenRetries: 1,
        navigationTimeoutMs: 10_000
      },
      { expectedUsername: "小马" }
    );
    assert.equal(result.status, "sent");
  });
});

test("openCandidate keeps search and video detail on separate pages", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: discoverBrowserExecutable()
  });
  try {
    const context = await browser.newContext();
    const searchPage = await context.newPage();
    const detailPage = await context.newPage();
    await context.route("https://www.douyin.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/video/")) {
        await route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body>视频详情</body></html>"
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body>搜索页</body></html>"
      });
    });
    const searchUrl = "https://www.douyin.com/search/test?type=general";
    await searchPage.goto(searchUrl);
    await searchPage.setContent(`<!doctype html><html><body>
      <div class="search-result-card" style="width:240px;height:180px">
        <img alt="封面" style="width:200px;height:120px">
        <span>目标视频</span>
      </div>
      <script>
        document.querySelector(".search-result-card").addEventListener("click", () => {
          history.pushState({}, "", "?modal_id=1234567890123456789&type=general");
        });
        addEventListener("keydown", (event) => {
          if (event.key === "Escape") history.pushState({}, "", "?type=general");
        });
      </script>
    </body></html>`);
    const videoId = await openCandidate(
      searchPage,
      { title: "目标视频", videoId: "" },
      searchUrl,
      { actionTimeoutMs: 2_000, navigationTimeoutMs: 10_000 },
      detailPage
    );
    assert.equal(videoId, "1234567890123456789");
    assert.equal(new URL(searchPage.url()).searchParams.has("modal_id"), false);
    assert.equal(
      detailPage.url(),
      "https://www.douyin.com/video/1234567890123456789"
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("filter option selection tolerates delayed menu rendering", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <!doctype html>
      <html><body>
        <button id="filter">筛选</button>
        <script>
          document.querySelector("#filter").addEventListener("click", () => {
            setTimeout(() => {
              const option = document.createElement("span");
              option.dataset.index1 = "1";
              option.dataset.index2 = "2";
              option.textContent = "一周内";
              option.addEventListener("click", () => document.body.dataset.selected = "week");
              document.body.append(option);
            }, 600);
          });
        </script>
      </body></html>
    `);

    await selectSearchFilterOption(page, {
      groupIndex: 1,
      optionIndex: 2,
      label: "一周内",
      timeoutMs: 3_000
    });
    assert.equal(await page.locator("body").getAttribute("data-selected"), "week");
  });
});
