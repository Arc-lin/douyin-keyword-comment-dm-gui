export const DEFAULT_CONFIG = Object.freeze({
  query: "",
  publishTime: "不限",
  videoCount: 2,
  matchesPerVideo: 1,
  keywords: "",
  message: "",
  sortOrder: "综合排序",
  candidateLimit: 30,
  maxComments: 80,
  maxScrolls: 10,
  actionTimeoutMs: 10_000,
  dmReadyTimeoutMs: 15_000,
  dmOpenRetries: 2,
  navigationTimeoutMs: 60_000,
  minDelayMs: 3_000,
  maxDelayMs: 8_000,
  searchScrollRounds: 80,
  chromePath: ""
});

const PUBLISH_TIMES = new Set(["不限", "一天内", "一周内", "半年内"]);
const SORT_ORDERS = new Set(["综合排序", "最新发布", "最多点赞"]);

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseKeywords(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[\n,，]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

export function normalizeConfig(raw = {}) {
  return {
    query: String(raw.query ?? DEFAULT_CONFIG.query).trim(),
    publishTime: String(raw.publishTime ?? DEFAULT_CONFIG.publishTime),
    videoCount: integer(raw.videoCount, DEFAULT_CONFIG.videoCount),
    matchesPerVideo: integer(raw.matchesPerVideo, DEFAULT_CONFIG.matchesPerVideo),
    keywords: Array.isArray(raw.keywords)
      ? raw.keywords.join("\n")
      : String(raw.keywords ?? DEFAULT_CONFIG.keywords),
    message: String(raw.message ?? DEFAULT_CONFIG.message),
    sortOrder: String(raw.sortOrder ?? DEFAULT_CONFIG.sortOrder),
    candidateLimit: integer(raw.candidateLimit, DEFAULT_CONFIG.candidateLimit),
    maxComments: integer(raw.maxComments, DEFAULT_CONFIG.maxComments),
    maxScrolls: integer(raw.maxScrolls, DEFAULT_CONFIG.maxScrolls),
    actionTimeoutMs: integer(raw.actionTimeoutMs, DEFAULT_CONFIG.actionTimeoutMs),
    dmReadyTimeoutMs: integer(raw.dmReadyTimeoutMs, DEFAULT_CONFIG.dmReadyTimeoutMs),
    dmOpenRetries: integer(raw.dmOpenRetries, DEFAULT_CONFIG.dmOpenRetries),
    navigationTimeoutMs: integer(raw.navigationTimeoutMs, DEFAULT_CONFIG.navigationTimeoutMs),
    minDelayMs: integer(raw.minDelayMs, DEFAULT_CONFIG.minDelayMs),
    maxDelayMs: integer(raw.maxDelayMs, DEFAULT_CONFIG.maxDelayMs),
    searchScrollRounds: integer(raw.searchScrollRounds, DEFAULT_CONFIG.searchScrollRounds),
    chromePath: String(raw.chromePath ?? DEFAULT_CONFIG.chromePath).trim()
  };
}

export function validateConfig(raw, mode = "preview") {
  const value = normalizeConfig(raw);
  const errors = [];
  const keywords = parseKeywords(value.keywords);

  if (!value.query) errors.push("搜索词不能为空");
  if (!PUBLISH_TIMES.has(value.publishTime)) errors.push("发布时间筛选无效");
  if (!SORT_ORDERS.has(value.sortOrder)) errors.push("排序方式无效");
  if (!Number.isInteger(value.videoCount) || value.videoCount < 1) {
    errors.push("随机视频数必须是不小于 1 的整数");
  }
  if (!Number.isInteger(value.matchesPerVideo) || value.matchesPerVideo < 1) {
    errors.push("每视频目标人数必须是不小于 1 的整数");
  }
  if (mode === "send" && !value.message.trim()) errors.push("发送模式下私信内容不能为空");

  // 不再设任何上限：仅保留保证程序能正常运行所必需的最小校验（必须是不小于下限的整数）。
  const ranges = [
    ["候选视频扫描上限", value.candidateLimit, 1],
    ["每视频评论扫描上限", value.maxComments, 1],
    ["评论滚动轮数", value.maxScrolls, 1],
    ["操作超时", value.actionTimeoutMs, 0],
    ["私信页面等待超时", value.dmReadyTimeoutMs, 0],
    ["私信浮窗重试次数", value.dmOpenRetries, 0],
    ["导航超时", value.navigationTimeoutMs, 0],
    ["最小发送间隔", value.minDelayMs, 0],
    ["最大发送间隔", value.maxDelayMs, 0],
    ["搜索结果滚动次数上限", value.searchScrollRounds, 1]
  ];

  for (const [label, actual, min] of ranges) {
    if (!Number.isInteger(actual) || actual < min) {
      errors.push(`${label}必须是不小于 ${min} 的整数`);
    }
  }
  if (value.minDelayMs > value.maxDelayMs) {
    errors.push("最小发送间隔不能大于最大发送间隔");
  }
  if (value.candidateLimit < value.videoCount) {
    errors.push("候选视频扫描上限不能小于随机视频数，否则不可能选够目标数量");
  }

  return {
    value: { ...value, keywordList: keywords },
    errors
  };
}

export function sampleWithoutReplacement(items, count, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

export function extractUserId(href = "") {
  const match = String(href).match(/\/user\/([^/?#]+)/);
  return match?.[1] ?? "";
}

export function normalizeDisplayName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^@/u, "")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s\u200D\uFE0F]/gu, "");
}

export function containsAnyKeyword(text, keywords) {
  const haystack = String(text).toLocaleLowerCase();
  return keywords.some((keyword) => haystack.includes(String(keyword).toLocaleLowerCase()));
}

export function randomInteger(min, max, random = Math.random) {
  if (max <= min) return min;
  return Math.floor(random() * (max - min + 1)) + min;
}

export function humanDelay(baseMs, ratio = 0.35, random = Math.random) {
  if (baseMs <= 0) return 0;
  const variance = Math.round(baseMs * ratio);
  return randomInteger(Math.max(0, baseMs - variance), baseMs + variance, random);
}

export function parseSearchCardText(text) {
  const lines = String(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const durationIndex = lines.findIndex((line) => /^\d{1,2}:\d{2}$/.test(line));
  if (durationIndex < 0) return null;

  const authorIndex = lines.findIndex((line, index) => index > durationIndex && line.startsWith("@"));
  const dateIndex = authorIndex >= 0 ? authorIndex + 1 : -1;
  const titleStart = durationIndex + 2;
  const titleEnd = authorIndex >= 0 ? authorIndex : lines.length;
  const title = lines.slice(titleStart, titleEnd).join(" ").trim();

  if (!title) return null;
  return {
    duration: lines[durationIndex],
    metric: lines[durationIndex + 1] ?? "",
    title,
    author: authorIndex >= 0 ? lines[authorIndex].replace(/^@/, "").trim() : "",
    publishedAt: dateIndex >= 0 ? (lines[dateIndex] ?? "").replace(/^·\s*/, "") : ""
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function resultsToCsv(results) {
  const columns = [
    ["videoTitle", "视频"],
    ["videoAuthor", "视频作者"],
    ["videoId", "视频ID"],
    ["username", "用户"],
    ["userId", "用户ID"],
    ["commentText", "命中评论"],
    ["matchedKeyword", "命中关键词"],
    ["status", "状态"],
    ["detail", "说明"],
    ["timestamp", "时间"]
  ];
  const rows = [
    columns.map(([, label]) => csvCell(label)).join(","),
    ...results.map((result) =>
      columns.map(([key]) => csvCell(result[key])).join(",")
    )
  ];
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
