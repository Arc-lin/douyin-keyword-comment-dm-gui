import fs from "node:fs";
import path from "node:path";
import { extractUserId, parseSearchCardText } from "./core.mjs";

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
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

export function discoverBrowserExecutable() {
  const executable = CHROME_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error("未找到 Chrome 或 Edge。可通过 CHROME_PATH 环境变量指定浏览器路径。");
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
      await page.waitForTimeout(450);
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
      await page.waitForTimeout(450);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500 * attempt);
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
  await page.waitForTimeout(1_500);
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
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(config.query)}?type=general`;
  const resultTimeoutMs = Math.min(config.navigationTimeoutMs, 12_000);
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs
      });
      await page.waitForTimeout(1_500);

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
      await selectSearchFilterOption(page, {
        groupIndex: 4,
        optionIndex: 1,
        label: "视频",
        timeoutMs: config.actionTimeoutMs
      });

      await page.waitForTimeout(500);
      const filteredState = await waitForSearchResults(
        page,
        resultTimeoutMs
      );
      if ((await filteredState.jsonValue()) === "gate") {
        return { gate: await detectPageGate(page), searchUrl };
      }
      await page.waitForTimeout(300);
      const filterGate = await detectPageGate(page);
      if (filterGate) return { gate: filterGate, searchUrl };
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
          await page.waitForTimeout(2_500);
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

export async function collectSearchCandidates(page, config, onProgress) {
  let previousCount = 0;
  let unchangedRounds = 0;
  let candidates = [];

  for (let round = 0; round < 12; round += 1) {
    candidates = await extractSearchCandidates(page, config.candidateLimit);
    await onProgress?.(candidates.length);
    if (candidates.length >= config.candidateLimit) break;

    if (candidates.length === previousCount) unchangedRounds += 1;
    else unchangedRounds = 0;
    if (unchangedRounds >= 3) break;

    previousCount = candidates.length;
    await page.mouse.wheel(0, 1_400);
    await page.waitForTimeout(650);
  }
  return candidates.slice(0, config.candidateLimit);
}

export async function openCandidate(page, candidate, searchUrl, config) {
  if (candidate.videoId) {
    await page.goto(`https://www.douyin.com/video/${candidate.videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs
    });
    return candidate.videoId;
  }

  if (!page.url().startsWith(searchUrl)) {
    const result = await applySearch(page, config);
    if (result.gate) return { gate: result.gate };
  }

  let card = page.locator(".search-result-card").filter({ hasText: candidate.title }).first();
  if (!(await card.count())) {
    const title = page.getByText(candidate.title, { exact: true }).first();
    if (!(await title.count())) throw new Error(`无法重新定位视频卡片：${candidate.title}`);
    card = title.locator("xpath=ancestor::div[contains(@class,'search-result-card')][1]");
  }
  await card.scrollIntoViewIfNeeded();
  await card.evaluate((element) => (element.querySelector("img") || element).click());
  await page.waitForTimeout(1_200);

  const modalId = new URL(page.url()).searchParams.get("modal_id");
  if (!modalId) throw new Error(`打开视频后未获得视频 ID：${candidate.title}`);
  await page.goto(`https://www.douyin.com/video/${modalId}`, {
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
  await page.waitForTimeout(350);
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
  await page.waitForTimeout(300);
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
  await page.waitForTimeout(1_000);

  const gate = await detectPageGate(page);
  if (gate) return { status: gate.type === "restricted" ? "blocked" : "waiting_login", gate };

  const button = page.locator('button:has-text("私信"):visible').first();
  if (!(await button.count())) {
    return { status: "unavailable", detail: "用户主页没有可用的私信按钮" };
  }
  await button.click({ timeout: config.actionTimeoutMs });
  await onStage?.(`已打开 ${expectedUsername || "用户"} 的私信浮窗，等待输入框加载`);

  const startedAt = Date.now();
  const preferredEditor = page.locator(
    '[contenteditable="true"][data-placeholder="发送消息"]:visible'
  ).last();
  const fallbackEditor = page.locator('[contenteditable="true"]:visible').last();
  let editor = preferredEditor;

  while (Date.now() - startedAt < config.actionTimeoutMs) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/无法发送|不允许私信|私信功能.*限制|操作频繁/.test(bodyText)) {
      if (/操作频繁|私信功能.*限制/.test(bodyText)) {
        return {
          status: "blocked",
          detail: "平台限制向该用户发送私信",
          gate: { type: "restricted", detail: "平台提示操作频繁或私信功能受限" }
        };
      }
      return { status: "blocked", detail: "平台限制向该用户发送私信" };
    }

    if (await preferredEditor.count()) {
      editor = preferredEditor;
      break;
    }
    if (await fallbackEditor.count()) {
      editor = fallbackEditor;
      break;
    }
    await page.waitForTimeout(250);
  }

  if (!(await editor.count())) {
    return {
      status: "unavailable",
      detail: `私信浮窗已打开，但 ${config.actionTimeoutMs}ms 内未加载输入框`
    };
  }

  await page.waitForTimeout(300);
  const profileHeading = page.locator("h1:visible").first();
  const profileUsername = (await profileHeading.count())
    ? await profileHeading.innerText()
    : expectedUsername;
  const activePanel = editor.locator(
    'xpath=ancestor::div[contains(@class,"componentsRightPanelwrapper")][1]'
  );
  const activeHeader = activePanel.locator(".RightPanelHeadertitle").first();
  const activeConversationUsername =
    (await activePanel.count()) && (await activeHeader.count())
      ? await activeHeader.innerText()
      : "";
  if (
    profileUsername.trim() &&
    activeConversationUsername.trim() &&
    profileUsername.trim() !== activeConversationUsername.trim()
  ) {
    return {
      status: "failed",
      detail: `私信浮窗当前会话为“${activeConversationUsername.trim()}”，目标主页为“${profileUsername.trim()}”`
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
    await editor.fill(message);

    // Slate removes or replaces the placeholder editor after input. Resolve the
    // currently visible contenteditable again before sending.
    const activeEditor = page.locator('[contenteditable="true"]:visible').last();
    await activeEditor.waitFor({
      state: "visible",
      timeout: config.actionTimeoutMs
    });
    await activeEditor.focus();
    await onStage?.(
      `${expectedUsername || "用户"} 的私信内容已填入，正在触发发送`
    );
    await page.keyboard.press("Enter");
    await onStage?.(
      `${expectedUsername || "用户"} 已触发发送，正在核验结果`
    );

    await page.waitForFunction(
      ({ text, previous }) => {
        const editors = Array.from(
          document.querySelectorAll('[contenteditable="true"]')
        ).filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const editorElement = editors.at(-1);
        const editorText = (editorElement?.innerText || "")
          .replace(/\u200B/g, "")
          .trim();
        const matching = Array.from(
          document.querySelectorAll("span, pre, div")
        ).filter(
          (element) =>
            element.children.length === 0 &&
            !element.closest('[contenteditable="true"]') &&
            (element.textContent || "").trim() === text
        ).length;
        return !editorText && matching > previous;
      },
      { text: message, previous: beforeCount },
      { timeout: config.actionTimeoutMs }
    );
  } catch (error) {
    const remainingText = await page
      .locator('[contenteditable="true"]:visible')
      .last()
      .innerText()
      .catch(() => "");
    const detail = remainingText.replace(/\u200B/g, "").trim()
      ? "私信内容已填入，但未能触发发送或完成页面核验"
      : `私信发送后未能完成页面核验：${error.message}`;
    return { status: "failed", detail };
  }

  await page.waitForTimeout(400);
  return { status: "sent", detail: `输入框等待 ${Date.now() - startedAt}ms` };
}

export function artifactLabel(candidate, suffix) {
  const base = candidate.videoId || candidate.title || "video";
  return `${path.basename(String(base)).slice(0, 40)}-${suffix}`;
}
