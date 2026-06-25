import fs from "node:fs";
import path from "node:path";
import {
  extractUserId,
  humanDelay,
  normalizeDisplayName,
  parseSearchCardText,
  randomInteger
} from "./core.mjs";

export async function humanPause(page, baseMs, ratio = 0.35) {
  await page.waitForTimeout(humanDelay(baseMs, ratio));
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

const SORT_FILTER_INDEX = new Map([
  ["综合排序", 0],
  ["最新发布", 1],
  ["最多点赞", 2]
]);

const PUBLISH_FILTER_INDEX = new Map([
  ["不限", 0],
  ["一天内", 1],
  ["一周内", 2],
  ["半年内", 3]
]);

export function discoverBrowserExecutable(overridePath) {
  const candidates = [overridePath, ...CHROME_PATHS].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(
      "未找到 Chrome 或 Edge。可在页面“高级设置”里填写 Chrome/Edge 路径，或通过 CHROME_PATH 环境变量指定。"
    );
  }
  return executable;
}

export async function clickTextNative(page, text) {
  const matches = page.getByText(text, { exact: true });
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    const locator = matches.nth(index);
    if (await locator.isVisible().catch(() => false)) {
      await locator.evaluate((element) => element.click());
      return;
    }
  }
  throw new Error(`未找到可见控件：${text}`);
}

async function waitForSearchResults(page, timeoutMs) {
  return page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || "";
      const challenge = document.querySelector(
        '#captcha_container, [id*="captcha" i], iframe[src*="captcha" i], iframe[src*="verify" i]'
      );
      if (challenge) {
        const rect = challenge.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return "gate";
      }
      return (
        document.querySelectorAll(".search-result-card").length > 0 ||
        /没有找到|暂无相关|搜索结果为空/.test(bodyText)
      )
        ? "results"
        : false;
    },
    null,
    { timeout: timeoutMs }
  );
}

// 抖音搜索结果页特有标记：列表容器 [data-e2e="scroll-list"] 里实际渲染出卡片。
// 验证码/二次验证覆盖层不会带着这个结构，可用来确认结果页是否真正稳定下来。
async function hasSearchResultsMarker(page) {
  return page.evaluate(() => {
    const lists = document.querySelectorAll('[data-e2e="scroll-list"]');
    for (const list of lists) {
      if (list.querySelector(".search-result-card")) return true;
    }
    return false;
  });
}

function pageGateError(gate) {
  const error = new Error(gate.detail);
  error.gate = gate;
  return error;
}

export async function selectSearchFilterOption(
  page,
  { groupIndex, optionIndex, label, timeoutMs = 10_000 }
) {
  const selector = `[data-index1="${groupIndex}"][data-index2="${optionIndex}"]`;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const option = page.locator(`${selector}:visible`).first();
    if (await option.count()) {
      const gate = await detectPageGate(page);
      if (gate) throw pageGateError(gate);
      await option.evaluate((element) => element.click());
      await humanPause(page, 450);
      return;
    }

    try {
      await clickTextNative(page, "筛选");
      await page.locator(`${selector}:visible`).first().waitFor({
        state: "visible",
        timeout: Math.min(timeoutMs, 3_500)
      });
      const gate = await detectPageGate(page);
      if (gate) throw pageGateError(gate);
      await page.locator(`${selector}:visible`).first().evaluate((element) => element.click());
      await humanPause(page, 450);
      return;
    } catch (error) {
      lastError = error;
      await humanPause(page, 500 * attempt);
    }
  }

  throw new Error(
    `无法打开筛选并选择“${label}”${lastError?.message ? `：${lastError.message}` : ""}`
  );
}

export async function detectPageGate(page) {
  const structuralChallenge = page.locator(
    '#captcha_container, [id*="captcha" i], iframe[src*="captcha" i], iframe[src*="verify" i]'
  );
  const structuralChallengeCount = await structuralChallenge.count();
  for (let index = 0; index < structuralChallengeCount; index += 1) {
    if (await structuralChallenge.nth(index).isVisible().catch(() => false)) {
      return {
        type: "login",
        detail: "页面出现验证码或人工安全验证覆盖层"
      };
    }
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const restrictedPatterns = [
    /操作频繁/,
    /发送过于频繁/,
    /账号异常/,
    /账号受限/,
    /私信功能.*限制/,
    /存在安全风险/,
    /违反.*规定/
  ];
  if (restrictedPatterns.some((pattern) => pattern.test(bodyText))) {
    return { type: "restricted", detail: "页面提示操作频繁、账号受限或安全风险" };
  }

  const challengePatterns = [
    /请完成验证/,
    /拖动滑块/,
    /设备验证/,
    /安全验证/,
    /请输入验证码/,
    /扫码登录/
  ];
  if (challengePatterns.some((pattern) => pattern.test(bodyText))) {
    return { type: "login", detail: "页面需要登录或人工安全验证" };
  }

  const loginButton = page.getByRole("button", { name: "登录", exact: true });
  if ((await loginButton.count()) && (await loginButton.first().isVisible().catch(() => false))) {
    return { type: "login", detail: "抖音账号尚未登录" };
  }
  return null;
}

export async function readCurrentUser(page, navigationTimeoutMs) {
  await page.goto("https://www.douyin.com/user/self", {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs
  });
  await humanPause(page, 1_500);
  const gate = await detectPageGate(page);
  if (gate) return { gate };

  const userId = extractUserId(page.url());
  const username = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    if (heading?.textContent?.trim()) return heading.textContent.trim();

    const lines = (document.body.innerText || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const accountIndex = lines.findIndex((line) => line.startsWith("抖音号："));
    if (accountIndex < 0) return "";
    for (let index = accountIndex - 1; index >= Math.max(0, accountIndex - 8); index -= 1) {
      const line = lines[index];
      if (
        line &&
        !/^(关注|粉丝|获赞|私信|分享主页|\d+)$/.test(line) &&
        !line.includes("IP属地")
      ) {
        return line;
      }
    }
    return "";
  });

  return { userId, username };
}

export async function applySearch(page, config) {
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(config.query)}?type=video`;
  const resultTimeoutMs = Math.min(config.navigationTimeoutMs, 12_000);
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs
      });
      await humanPause(page, 1_500);

      const gate = await detectPageGate(page);
      if (gate) return { gate, searchUrl };

      const searchState = await waitForSearchResults(page, resultTimeoutMs);
      if ((await searchState.jsonValue()) === "gate") {
        return { gate: await detectPageGate(page), searchUrl };
      }

      if (config.sortOrder !== "综合排序") {
        await selectSearchFilterOption(page, {
          groupIndex: 0,
          optionIndex: SORT_FILTER_INDEX.get(config.sortOrder),
          label: config.sortOrder,
          timeoutMs: config.actionTimeoutMs
        });
      }
      if (config.publishTime !== "不限") {
        await selectSearchFilterOption(page, {
          groupIndex: 1,
          optionIndex: PUBLISH_FILTER_INDEX.get(config.publishTime),
          label: config.publishTime,
          timeoutMs: config.actionTimeoutMs
        });
      }
      const filteredState = await waitForSearchResults(
        page,
        resultTimeoutMs
      );
      if ((await filteredState.jsonValue()) === "gate") {
        return { gate: await detectPageGate(page), searchUrl };
      }
      await humanPause(page, 300);
      const filterGate = await detectPageGate(page);
      if (filterGate) return { gate: filterGate, searchUrl };

      // 抖音有时会在结果渲染完成后才延迟弹出二次验证。先确认结果页专属标记已出现，
      // 再等 5 秒重新检查：标记还在才认为页面真正稳定，没了就当作被验证打断处理。
      if (await hasSearchResultsMarker(page)) {
        await page.waitForTimeout(5_000);
        if (!(await hasSearchResultsMarker(page))) {
          const stabilityGate = await detectPageGate(page);
          if (stabilityGate) return { gate: stabilityGate, searchUrl };
          throw new Error("搜索结果在等待期间消失，页面状态不稳定");
        }
      }

      return { searchUrl, retried: attempt > 1 };
    } catch (error) {
      if (error.gate) return { gate: error.gate, searchUrl };
      lastError = error;
      if (attempt < 2) {
        try {
          await page.goto("https://www.douyin.com/jingxuan", {
            waitUntil: "domcontentloaded",
            timeout: config.navigationTimeoutMs
          });
          await humanPause(page, 2_500);
          const recoveryGate = await detectPageGate(page);
          if (recoveryGate) return { gate: recoveryGate, searchUrl };
        } catch (recoveryError) {
          lastError = new Error(
            `${error.message}；搜索页恢复失败：${recoveryError.message}`
          );
        }
      }
    }
  }

  throw new Error(
    `搜索结果区域持续空白或筛选未完成：${lastError?.message || "未知错误"}`
  );
}

export async function extractSearchCandidates(page, limit) {
  const rawCards = await page.evaluate((candidateLimit) => {
    const explicit = Array.from(document.querySelectorAll(".search-result-card"));
    let nodes = explicit;

    if (!nodes.length) {
      const durationNodes = Array.from(document.querySelectorAll("div")).filter((node) => {
        const directText = Array.from(node.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent?.trim())
          .filter(Boolean)
          .join(" ");
        return /^\d{1,2}:\d{2}$/.test(directText) && node.closest("div")?.querySelector("img");
      });
      nodes = durationNodes.map((node) => node.closest("div:has(img)") || node.parentElement);
    }

    return [...new Set(nodes)].slice(0, candidateLimit).map((node, cardIndex) => {
      const html = node.outerHTML || "";
      const idMatch = html.match(
        /(?:aweme_id|group_id|modal_id)[^0-9]{0,30}(\d{18,20})/i
      );
      const hrefMatch = html.match(/\/video\/(\d{18,20})/);
      return {
        cardIndex,
        text: (node.innerText || "").trim(),
        videoId: idMatch?.[1] || hrefMatch?.[1] || ""
      };
    });
  }, limit);

  return rawCards
    .map((card) => {
      const parsed = parseSearchCardText(card.text);
      return parsed ? { ...card, ...parsed } : null;
    })
    .filter(Boolean);
}

export async function scrollSearchResults(page, scrollAmount) {
  await page.evaluate((amount) => {
    const canScroll = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return (
        element.scrollHeight > element.clientHeight + 50 &&
        !["hidden", "clip"].includes(style.overflowY)
      );
    };

    const containers = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll("*")
    ]
      .filter(canScroll)
      .sort(
        (a, b) =>
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
      );
    const target = containers[0] || document.scrollingElement || document.documentElement;
    target.scrollBy({ top: amount, behavior: "instant" });
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new Event("scroll"));
  }, scrollAmount);

  // 抖音的分页加载常绑定在内部虚拟列表的真实滚轮事件上，直接改 scrollTop 未必触发，
  // 这里同时再发一次真实滚轮输入兜底。
  await page.mouse.wheel(0, scrollAmount);
}

export async function collectSearchCandidates(page, config, onProgress) {
  let previousCount = 0;
  let unchangedRounds = 0;
  let candidates = [];

  for (let round = 0; round < config.searchScrollRounds; round += 1) {
    const gate = await detectPageGate(page);
    if (gate) return { gate, candidates: candidates.slice(0, config.candidateLimit) };

    candidates = await extractSearchCandidates(page, config.candidateLimit);
    await onProgress?.(candidates.length);
    if (candidates.length >= config.candidateLimit) break;

    if (candidates.length === previousCount) unchangedRounds += 1;
    else unchangedRounds = 0;
    if (unchangedRounds >= 5) break;

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/暂时没有更多视频了|没有更多视频了/.test(bodyText)) break;

    previousCount = candidates.length;
    await scrollSearchResults(page, randomInteger(1_100, 1_700));
    // 滚动后要等下一页接口请求返回，太快读取不到新卡片。
    await humanPause(page, 1_500);
  }
  return { candidates: candidates.slice(0, config.candidateLimit) };
}

export async function openCandidate(
  page,
  candidate,
  searchUrl,
  config,
  detailPage = page
) {
  if (candidate.videoId) {
    await detailPage.goto(`https://www.douyin.com/video/${candidate.videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs
    });
    return candidate.videoId;
  }

  const currentUrl = new URL(page.url());
  const expectedUrl = new URL(searchUrl);
  if (
    currentUrl.origin !== expectedUrl.origin ||
    currentUrl.pathname !== expectedUrl.pathname
  ) {
    const result = await applySearch(page, config);
    if (result.gate) return { gate: result.gate };
  }

  if (new URL(page.url()).searchParams.has("modal_id")) {
    await page.keyboard.press("Escape").catch(() => {});
    await page
      .waitForFunction(() => !new URL(location.href).searchParams.has("modal_id"), null, {
        timeout: config.actionTimeoutMs
      })
      .catch(async () => {
        const result = await applySearch(page, config);
        if (result.gate) throw pageGateError(result.gate);
      });
  }

  let card = page.locator(".search-result-card").filter({ hasText: candidate.title }).first();
  if (!(await card.count())) {
    const title = page.getByText(candidate.title, { exact: true }).first();
    if (!(await title.count())) throw new Error(`无法重新定位视频卡片：${candidate.title}`);
    card = title.locator("xpath=ancestor::div[contains(@class,'search-result-card')][1]");
  }
  await card.scrollIntoViewIfNeeded();
  const gate = await detectPageGate(page);
  if (gate) return { gate };
  const box = await card.boundingBox();
  if (!box) throw new Error(`视频卡片当前不可点击：${candidate.title}`);
  await page.mouse.click(
    box.x + box.width / 2,
    box.y + Math.min(100, box.height / 2)
  );
  await page.waitForFunction(
    () =>
      new URL(location.href).searchParams.has("modal_id") ||
      /\/video\/\d{18,20}/.test(location.pathname),
    null,
    { timeout: config.actionTimeoutMs }
  );

  const openedUrl = new URL(page.url());
  const modalId =
    openedUrl.searchParams.get("modal_id") ||
    openedUrl.pathname.match(/\/video\/(\d{18,20})/)?.[1];
  if (!modalId) throw new Error(`打开视频后未获得视频 ID：${candidate.title}`);

  if (detailPage !== page) {
    await page.keyboard.press("Escape").catch(() => {});
    await page
      .waitForFunction(() => !new URL(location.href).searchParams.has("modal_id"), null, {
        timeout: config.actionTimeoutMs
      })
      .catch(() => {});
  }

  await detailPage.goto(`https://www.douyin.com/video/${modalId}`, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs
  });
  return modalId;
}

export async function extractTopLevelComments(page, maxComments = 80) {
  return page.evaluate((limit) => {
    const explicitSelectors = [
      '[data-role="top-level-comment"]',
      '[data-e2e="comment-item"]'
    ];
    const explicit = explicitSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    );
    const containers = [];

    function addContainer(container) {
      if (!container || containers.includes(container)) return;
      const nestedReply = container.closest(
        '[data-role="reply"], [data-e2e*="reply"], [class*="reply-item"], [class*="ReplyItem"], [class*="replyContainer"], [class*="ReplyContainer"]'
      );
      if (nestedReply && nestedReply !== container) return;
      if (!container.querySelector('a[href*="/user/"]')) return;
      containers.push(container);
    }

    explicit.forEach(addContainer);

    if (!containers.length) {
      for (const link of document.querySelectorAll('a[href*="/user/"]')) {
        let current = link.parentElement;
        for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
          const text = current.innerText || "";
          if (text.includes("分享") && text.includes("回复") && text.length < 2_000) {
            addContainer(current);
            break;
          }
        }
      }
    }

    function cleanFallbackText(container, username) {
      const ignored = [
        username,
        "...",
        "分享",
        "回复",
        "作者",
        "置顶"
      ];
      const lines = (container.innerText || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !ignored.includes(line))
        .filter((line) => !/^\d+$/.test(line))
        .filter((line) => !/^(展开|收起)\d*条?回复/.test(line))
        .filter((line) => !/^\d+(秒|分钟|小时|天|周|月|年)前/.test(line))
        .filter((line) => !/^\d{1,2}[-月]\d{1,2}/.test(line))
        .filter((line) => !line.includes("·"));
      return lines[0] || "";
    }

    const results = [];
    const seen = new Set();
    for (const container of containers) {
      const userLinks = Array.from(
        container.querySelectorAll('a[href*="/user/"]')
      );
      const userLink =
        userLinks.find(
          (link) => (link.innerText || link.textContent || "").trim()
        ) || userLinks[0];
      const href = userLink?.getAttribute("href") || "";
      const rawUsername = (userLink?.innerText || userLink?.textContent || "").trim();
      const username = rawUsername
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line && line !== "作者")
        .join(" ");
      let primaryBlock = userLink?.parentElement;
      for (
        let depth = 0;
        primaryBlock && depth < 8;
        depth += 1, primaryBlock = primaryBlock.parentElement
      ) {
        const text = primaryBlock.innerText || "";
        if (text.includes("分享") && text.includes("回复")) break;
      }
      const textElement = (primaryBlock || container).querySelector(
        '[data-role="comment-text"], [data-e2e="comment-level-1"], [data-e2e="comment-text"], [class*="comment-content"], [class*="CommentContent"]'
      );
      const commentText =
        (textElement?.innerText || textElement?.textContent || "").trim() ||
        cleanFallbackText(primaryBlock || container, username);
      const authorBadgeInLink = Array.from(
        userLink?.querySelectorAll("*") || []
      ).some((element) => (element.textContent || "").trim() === "作者");
      const authorBadgeNextToLink = Array.from(
        userLink?.parentElement?.children || []
      ).some(
        (element) =>
          element !== userLink && (element.textContent || "").trim() === "作者"
      );
      const authorBadgeSibling =
        (userLink?.nextElementSibling?.textContent || "").trim() === "作者";
      const key = `${href}\u0000${commentText}`;
      if (!href || !username || !commentText || seen.has(key)) continue;
      seen.add(key);
      results.push({
        username,
        userHref: href.startsWith("//")
          ? `https:${href}`
          : new URL(
              href,
              location.origin && location.origin !== "null"
                ? location.origin
                : "https://www.douyin.com"
            ).href,
        userId: (href.match(/\/user\/([^/?#]+)/) || [])[1] || "",
        commentText,
        isAuthor:
          authorBadgeInLink || authorBadgeNextToLink || authorBadgeSibling
      });
      if (results.length >= limit) break;
    }
    return results;
  }, maxComments);
}

export async function scrollComments(page) {
  await page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll("div"))
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 100 &&
          /(auto|scroll)/.test(style.overflowY) &&
          (element.innerText || "").includes("评论")
        );
      })
      .sort((a, b) => a.clientWidth - b.clientWidth);
    const target = scrollables[0];
    if (target) target.scrollBy(0, Math.max(600, target.clientHeight * 0.8));
    else window.scrollBy(0, 900);
  });
}

export async function waitForComments(page, actionTimeoutMs) {
  const heading = page.getByText(/全部评论/).first();
  await heading.waitFor({
    state: "visible",
    timeout: actionTimeoutMs
  });
  await heading.scrollIntoViewIfNeeded();
  await humanPause(page, 350);
  await page.waitForFunction(
    () => {
      let commentRoot = document.querySelector(".comment-mainContent");
      if (!commentRoot) {
        const heading = Array.from(document.querySelectorAll("*")).find(
          (element) => (element.textContent || "").trim() === "全部评论"
        );
        let current = heading?.parentElement;
        while (current) {
          const nestedRoot = current.querySelector(".comment-mainContent");
          if (nestedRoot) {
            commentRoot = nestedRoot;
            break;
          }
          if (
            current.querySelector(
              '[data-role="top-level-comment"], [data-e2e="comment-item"]'
            )
          ) {
            commentRoot = current;
            break;
          }
          current = current.parentElement;
        }
      }
      if (!commentRoot) return false;

      const rootText = commentRoot.innerText || "";
      if (
        /暂无评论|还没有评论|评论已关闭|评论区已关闭|评论加载失败/.test(
          rootText
        )
      ) {
        return true;
      }

      const explicitComments = Array.from(
        commentRoot.querySelectorAll(
          '[data-role="top-level-comment"], [data-e2e="comment-item"]'
        )
      );
      const hasExtractableComment = explicitComments.some((container) => {
        const userLinks = Array.from(
          container.querySelectorAll('a[href*="/user/"]')
        );
        const userLink =
          userLinks.find(
            (link) => (link.innerText || link.textContent || "").trim()
          ) || userLinks[0];
        if (!userLink) return false;

        let primaryBlock = userLink.parentElement;
        for (
          let depth = 0;
          primaryBlock && primaryBlock !== container.parentElement && depth < 8;
          depth += 1, primaryBlock = primaryBlock.parentElement
        ) {
          const text = primaryBlock.innerText || "";
          if (text.includes("分享") && text.includes("回复")) break;
        }
        if (!primaryBlock) return false;
        const blockText = primaryBlock.innerText || "";
        if (!blockText.includes("分享") || !blockText.includes("回复")) {
          return false;
        }

        const username = (userLink.innerText || userLink.textContent || "")
          .trim()
          .split(/\n+/)
          .map((line) => line.trim())
          .filter((line) => line && line !== "作者");
        return blockText
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .some(
            (line) =>
              !username.includes(line) &&
              !["...", "分享", "回复", "作者", "作者赞过", "置顶"].includes(
                line
              ) &&
              !/^\d+$/.test(line) &&
              !/^(展开|收起)\d*条?回复/.test(line) &&
              !/^\d+(秒|分钟|小时|天|周|月|年)前/.test(line) &&
              !line.includes("·")
          );
      });
      if (hasExtractableComment) return true;

      if (
        explicitComments.length &&
        /暂时没有更多评论|没有更多评论/.test(rootText)
      ) {
        return true;
      }

      return false;
    },
    null,
    { timeout: actionTimeoutMs }
  );
  await humanPause(page, 300);
}

async function waitForProfileMessageEntry(page, timeoutMs, expectedUsername) {
  return page.evaluate(
    ({ timeout, expected }) =>
      new Promise((resolve) => {
        const isVisible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const readState = () => {
          const bodyText = document.body?.innerText || "";
          const challenge = Array.from(
            document.querySelectorAll(
              '#captcha_container, [id*="captcha" i], iframe[src*="captcha" i], iframe[src*="verify" i]'
            )
          ).some(isVisible);
          if (challenge || /请完成验证|拖动滑块|设备验证|安全验证/.test(bodyText)) {
            return { state: "gate" };
          }
          if (/操作频繁|账号异常|账号受限|私信功能.*限制|存在安全风险/.test(bodyText)) {
            return { state: "restricted" };
          }
          if (/用户不存在|账号已注销|页面不见了|内容不存在/.test(bodyText)) {
            return { state: "unavailable", detail: "用户主页不可用" };
          }

          const heading = Array.from(document.querySelectorAll("h1")).find(isVisible);
          const button = Array.from(
            document.querySelectorAll('button, [role="button"]')
          ).find(
            (element) =>
              isVisible(element) &&
              (element.innerText || element.textContent || "").trim() === "私信"
          );
          const profileUsername = (heading?.innerText || heading?.textContent || "").trim();
          if (button && (profileUsername || !expected)) {
            return { state: "ready", profileUsername };
          }
          return null;
        };

        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          const state = readState();
          if (state) finish(state);
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        });
        const timer = setTimeout(
          () => finish({ state: "timeout" }),
          timeout
        );
        check();
      }),
    { timeout: timeoutMs, expected: expectedUsername }
  );
}

async function waitForMessagePanel(page, timeoutMs, targetUsername) {
  return page.evaluate(
    ({ timeout, target }) =>
      new Promise((resolve) => {
        const normalize = (value) =>
          String(value || "")
            .normalize("NFKC")
            .replace(/^@/u, "")
            .toLocaleLowerCase()
            .replace(/[\p{P}\p{S}\p{Z}\s\u200D\uFE0F]/gu, "");
        const isVisible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        let lastConversation = "";
        const readState = () => {
          const bodyText = document.body?.innerText || "";
          const challenge = Array.from(
            document.querySelectorAll(
              '#captcha_container, [id*="captcha" i], iframe[src*="captcha" i], iframe[src*="verify" i]'
            )
          ).some(isVisible);
          if (challenge || /请完成验证|拖动滑块|设备验证|安全验证/.test(bodyText)) {
            return { state: "gate" };
          }
          if (/操作频繁|发送过于频繁|账号受限|私信功能.*限制|存在安全风险/.test(bodyText)) {
            return { state: "restricted" };
          }
          if (/无法发送|不允许私信/.test(bodyText)) {
            return { state: "blocked" };
          }

          const editors = Array.from(
            document.querySelectorAll('[contenteditable="true"]')
          ).filter(isVisible);
          for (let index = editors.length - 1; index >= 0; index -= 1) {
            const editor = editors[index];
            const panel = editor.closest(
              'div[class*="componentsRightPanelwrapper"]'
            );
            const header = panel?.querySelector(".RightPanelHeadertitle");
            const activeConversation = (
              header?.innerText ||
              header?.textContent ||
              ""
            ).trim();
            if (activeConversation) lastConversation = activeConversation;
            if (
              target &&
              activeConversation &&
              normalize(target) !== normalize(activeConversation)
            ) {
              continue;
            }
            return { state: "ready", activeConversation };
          }
          return null;
        };

        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          const state = readState();
          if (state) finish(state);
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        });
        const timer = setTimeout(
          () =>
            finish({
              state: lastConversation ? "conversation_mismatch" : "timeout",
              activeConversation: lastConversation
            }),
          timeout
        );
        check();
      }),
    { timeout: timeoutMs, target: targetUsername }
  );
}

async function resolveMessageEditor(page, targetUsername) {
  const editors = page.locator('[contenteditable="true"]:visible');
  const count = await editors.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const editor = editors.nth(index);
    const panel = editor.locator(
      'xpath=ancestor::div[contains(@class,"componentsRightPanelwrapper")][1]'
    );
    const header = panel.locator(".RightPanelHeadertitle").first();
    const activeConversation =
      (await panel.count()) && (await header.count())
        ? (await header.innerText()).trim()
        : "";
    if (
      !targetUsername ||
      !activeConversation ||
      normalizeDisplayName(targetUsername) ===
        normalizeDisplayName(activeConversation)
    ) {
      return { editor, activeConversation };
    }
  }
  return null;
}

async function waitForMessageSent(
  page,
  text,
  previous,
  timeoutMs,
  targetUsername
) {
  return page.evaluate(
    ({ message, before, timeout, target }) =>
      new Promise((resolve) => {
        const normalize = (value) =>
          String(value || "")
            .normalize("NFKC")
            .replace(/^@/u, "")
            .toLocaleLowerCase()
            .replace(/[\p{P}\p{S}\p{Z}\s\u200D\uFE0F]/gu, "");
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const checkSent = () => {
          const editors = Array.from(
            document.querySelectorAll('[contenteditable="true"]')
          ).filter(isVisible);
          const editor = editors
            .slice()
            .reverse()
            .find((candidate) => {
              if (!target) return true;
              const panel = candidate.closest(
                'div[class*="componentsRightPanelwrapper"]'
              );
              const header = panel?.querySelector(".RightPanelHeadertitle");
              const activeConversation = (
                header?.innerText ||
                header?.textContent ||
                ""
              ).trim();
              return (
                !activeConversation ||
                normalize(activeConversation) === normalize(target)
              );
            });
          const editorText = (editor?.innerText || "")
            .replace(/\u200B/g, "")
            .trim();
          const matching = Array.from(
            document.querySelectorAll("span, pre, div")
          ).filter(
            (element) =>
              element.children.length === 0 &&
              !element.closest('[contenteditable="true"]') &&
              (element.textContent || "").trim() === message
          ).length;
          return !editorText && matching > before;
        };

        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          if (checkSent()) finish(true);
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        });
        const timer = setTimeout(() => finish(false), timeout);
        check();
      }),
    {
      message: text,
      before: previous,
      timeout: timeoutMs,
      target: targetUsername
    }
  );
}

export async function sendDirectMessage(
  page,
  userHref,
  message,
  config,
  { expectedUsername = "", onStage } = {}
) {
  await page.goto(userHref, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs
  });

  const gate = await detectPageGate(page);
  if (gate) return { status: gate.type === "restricted" ? "blocked" : "waiting_login", gate };

  const profileState = await waitForProfileMessageEntry(
    page,
    config.dmReadyTimeoutMs ?? config.actionTimeoutMs,
    expectedUsername
  );
  if (profileState.state === "gate") {
    return {
      status: "waiting_login",
      gate: { type: "login", detail: "用户主页需要登录或人工安全验证" }
    };
  }
  if (profileState.state === "restricted") {
    return {
      status: "blocked",
      gate: { type: "restricted", detail: "平台提示操作频繁或账号受限" }
    };
  }
  if (profileState.state !== "ready") {
    return {
      status: "unavailable",
      detail:
        profileState.detail ||
        `用户主页在 ${config.dmReadyTimeoutMs ?? config.actionTimeoutMs}ms 内未加载可用的私信入口`
    };
  }

  const startedAt = Date.now();
  const targetUsername = profileState.profileUsername || expectedUsername;
  const attempts = 1 + (config.dmOpenRetries ?? 2);
  let panelState = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const button = page.locator('button:has-text("私信"):visible').filter({
      hasText: /^私信$/
    }).first();
    if (!(await button.count())) {
      return { status: "unavailable", detail: "用户主页没有可用的私信按钮" };
    }
    await button.click({ timeout: config.actionTimeoutMs });
    await onStage?.(
      `${attempt === 1 ? "已打开" : `第 ${attempt} 次唤起`} ${expectedUsername || "用户"} 的私信浮窗，监听输入框和会话切换`
    );

    panelState = await waitForMessagePanel(
      page,
      config.dmReadyTimeoutMs ?? config.actionTimeoutMs,
      targetUsername
    );
    if (panelState.state === "ready") break;
    if (panelState.state === "gate") {
      return {
        status: "waiting_login",
        gate: { type: "login", detail: "私信页面需要登录或人工安全验证" }
      };
    }
    if (panelState.state === "restricted") {
      return {
        status: "blocked",
        detail: "平台限制向该用户发送私信",
        gate: { type: "restricted", detail: "平台提示操作频繁或私信功能受限" }
      };
    }
    if (panelState.state === "blocked") {
      return { status: "blocked", detail: "平台限制向该用户发送私信" };
    }
    if (attempt < attempts) {
      await onStage?.(
        `${expectedUsername || "用户"} 的私信浮窗尚未就绪，保留当前页面并重新唤起（${attempt}/${attempts}）`
      );
    }
  }

  if (panelState?.state !== "ready") {
    if (panelState?.state === "conversation_mismatch") {
      return {
        status: "failed",
        detail: `私信浮窗未切换到目标会话，当前为“${panelState.activeConversation}”`
      };
    }
    return {
      status: "unavailable",
      detail: `私信浮窗经过 ${attempts} 次 DOM 监听仍未加载输入框`
    };
  }

  let resolvedEditor = await resolveMessageEditor(page, targetUsername);
  if (!resolvedEditor) {
    return {
      status: "failed",
      detail: "私信浮窗已加载，但无法定位目标会话的输入框"
    };
  }

  await onStage?.(
    `${expectedUsername || "用户"} 的私信输入框已就绪，正在发送`
  );
  const beforeCount = await page.evaluate((text) => {
    return Array.from(document.querySelectorAll("span, pre, div")).filter(
      (element) =>
        element.children.length === 0 &&
        !element.closest('[contenteditable="true"]') &&
        (element.textContent || "").trim() === text
    ).length;
  }, message);

  try {
    await resolvedEditor.editor.fill(message);

    // Slate removes or replaces the placeholder editor after input. Resolve the
    // currently visible contenteditable again before sending.
    resolvedEditor = await resolveMessageEditor(page, targetUsername);
    if (!resolvedEditor) throw new Error("填入内容后无法重新定位目标会话输入框");
    await resolvedEditor.editor.focus();
    await onStage?.(
      `${expectedUsername || "用户"} 的私信内容已填入，正在触发发送`
    );
    await page.keyboard.press("Enter");
    await onStage?.(
      `${expectedUsername || "用户"} 已触发发送，正在核验结果`
    );

    const sent = await waitForMessageSent(
      page,
      message,
      beforeCount,
      config.actionTimeoutMs,
      targetUsername
    );
    if (!sent) throw new Error("发送结果 DOM 核验超时");
  } catch (error) {
    const remainingEditor = await resolveMessageEditor(page, targetUsername);
    const remainingText = remainingEditor
      ? await remainingEditor.editor.innerText().catch(() => "")
      : "";
    const detail = remainingText.replace(/\u200B/g, "").trim()
      ? "私信内容已填入，但未能触发发送或完成页面核验"
      : `私信发送后未能完成页面核验：${error.message}`;
    return { status: "failed", detail };
  }

  return { status: "sent", detail: `输入框等待 ${Date.now() - startedAt}ms` };
}

export function artifactLabel(candidate, suffix) {
  const base = candidate.videoId || candidate.title || "video";
  return `${path.basename(String(base)).slice(0, 40)}-${suffix}`;
}
