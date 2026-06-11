export const HARD_SEND_LIMIT = 20;

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
  navigationTimeoutMs: 60_000,
  minDelayMs: 3_000,
  maxDelayMs: 8_000
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
    navigationTimeoutMs: integer(raw.navigationTimeoutMs, DEFAULT_CONFIG.navigationTimeoutMs),
    minDelayMs: integer(raw.minDelayMs, DEFAULT_CONFIG.minDelayMs),
    maxDelayMs: integer(raw.maxDelayMs, DEFAULT_CONFIG.maxDelayMs)
  };
}

export function validateConfig(raw, mode = "preview") {
  const value = normalizeConfig(raw);
  const errors = [];
  const keywords = parseKeywords(value.keywords);

  if (!value.query) errors.push("搜索词不能为空");
  if (value.query.length > 100) errors.push("搜索词不能超过 100 个字符");
  if (!PUBLISH_TIMES.has(value.publishTime)) errors.push("发布时间筛选无效");
  if (!SORT_ORDERS.has(value.sortOrder)) errors.push("排序方式无效");
  if (!Number.isInteger(value.videoCount) || value.videoCount < 1 || value.videoCount > 20) {
    errors.push("随机视频数必须是 1 到 20 的整数");
  }
  if (
    !Number.isInteger(value.matchesPerVideo) ||
    value.matchesPerVideo < 1 ||
    value.matchesPerVideo > 20
  ) {
    errors.push("每视频目标人数必须是 1 到 20 的整数");
  }
  if (value.videoCount * value.matchesPerVideo > HARD_SEND_LIMIT) {
    errors.push(`视频数 × 每视频人数不能超过 ${HARD_SEND_LIMIT}`);
  }
  if (!keywords.length) errors.push("至少填写一个评论关键词");
  if (keywords.length > 20) errors.push("评论关键词不能超过 20 个");
  if (keywords.some((keyword) => keyword.length > 50)) {
    errors.push("单个评论关键词不能超过 50 个字符");
  }
  if (mode === "send" && !value.message.trim()) errors.push("发送模式下私信内容不能为空");
  if (value.message.length > 500) errors.push("私信内容不能超过 500 个字符");

  const ranges = [
    ["候选视频扫描上限", value.candidateLimit, 1, 100],
    ["每视频评论扫描上限", value.maxComments, 1, 500],
    ["评论滚动轮数", value.maxScrolls, 1, 50],
    ["操作超时", value.actionTimeoutMs, 1_000, 60_000],
    ["导航超时", value.navigationTimeoutMs, 5_000, 180_000],
    ["最小发送间隔", value.minDelayMs, 0, 60_000],
    ["最大发送间隔", value.maxDelayMs, 0, 120_000]
  ];

  for (const [label, actual, min, max] of ranges) {
    if (!Number.isInteger(actual) || actual < min || actual > max) {
      errors.push(`${label}必须是 ${min} 到 ${max} 的整数`);
    }
  }
  if (value.minDelayMs > value.maxDelayMs) {
    errors.push("最小发送间隔不能大于最大发送间隔");
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

export function containsAnyKeyword(text, keywords) {
  const haystack = String(text).toLocaleLowerCase();
  return keywords.some((keyword) => haystack.includes(String(keyword).toLocaleLowerCase()));
}

export function randomInteger(min, max, random = Math.random) {
  if (max <= min) return min;
  return Math.floor(random() * (max - min + 1)) + min;
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
