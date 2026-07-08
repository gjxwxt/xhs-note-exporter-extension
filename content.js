const DETAIL_WAIT_TIMEOUT_MS = 4000;
const DETAIL_WAIT_INTERVAL_MS = 150;
const AUTO_CAPTURE_ROUTE_CHECK_MS = 600;
const AUTO_CAPTURE_ROUTE_SETTLE_MS = 900;
const AUTO_CAPTURE_TOAST_DURATION_MS = 2600;

let observedRouteHref = location.href;
let autoCaptureTimerId = 0;
let autoCaptureInFlight = false;
let lastAutoCaptureHref = "";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_CURRENT_NOTE") {
    handleCaptureCurrentNote().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "AUTO_CAPTURE_SETTINGS_CHANGED") {
    handleAutoCaptureSettingsChanged().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});

initializeAutoCaptureWatcher();
initializeContentErrorHooks();

async function handleCaptureCurrentNote() {
  const detailSnapshot = await waitForDetailReady();
  const pageSnapshot = await getPageState().catch(() => null);
  const detailBundle = extractCurrentDetail(pageSnapshot);

  if (!detailSnapshot.isReady && !detailBundle.detail) {
    throw new Error("请先手动打开一个帖子详情页后，再点击采集当前帖子。");
  }

  const user = extractUserInfo(pageSnapshot?.state, detailBundle.detail, detailSnapshot);
  const note = normalizeCurrentDetail(user, detailBundle, detailSnapshot);

  if (!note.title && !note.content && !note.noteUrl) {
    throw new Error("当前页面未识别到可采集的帖子详情内容。");
  }

  return {
    ok: true,
    note
  };
}

async function waitForDetailReady() {
  const startedAt = Date.now();
  let lastSnapshot = readDetailSnapshot();

  while (Date.now() - startedAt < DETAIL_WAIT_TIMEOUT_MS) {
    const snapshot = readDetailSnapshot();
    lastSnapshot = snapshot;

    if (snapshot.isReady) {
      return snapshot;
    }

    await sleep(DETAIL_WAIT_INTERVAL_MS);
  }

  return lastSnapshot;
}

async function getPageState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_PAGE_STATE" });
  if (!response?.ok) {
    throw new Error(response?.error || "无法读取页面状态");
  }
  return response.payload;
}

async function getAutoCaptureContext() {
  const response = await chrome.runtime.sendMessage({ type: "GET_AUTO_CAPTURE_CONTEXT" });
  if (!response?.ok) {
    throw new Error(response?.error || "无法读取自动采集配置");
  }
  return response.context || { enabled: false, activeTaskId: "", activeTaskName: "" };
}

async function reportExtensionError(payload) {
  try {
    await chrome.runtime.sendMessage({
      type: "REPORT_EXTENSION_ERROR",
      payload
    });
  } catch (_error) {
    // Ignore reporting failures to avoid recursive noise.
  }
}

async function handleAutoCaptureSettingsChanged() {
  scheduleAutoCaptureCheck({ force: true });
  return { ok: true };
}

function initializeAutoCaptureWatcher() {
  window.setInterval(() => {
    if (location.href === observedRouteHref) {
      return;
    }

    observedRouteHref = location.href;
    scheduleAutoCaptureCheck();
  }, AUTO_CAPTURE_ROUTE_CHECK_MS);

  window.addEventListener("popstate", () => {
    observedRouteHref = location.href;
    scheduleAutoCaptureCheck();
  });

  window.addEventListener("hashchange", () => {
    observedRouteHref = location.href;
    scheduleAutoCaptureCheck();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleAutoCaptureCheck();
    }
  });

  window.setTimeout(() => {
    scheduleAutoCaptureCheck({ force: true });
  }, 1200);
}

function scheduleAutoCaptureCheck(options = {}) {
  const routeKey = getCurrentNoteRouteKey();
  if (!routeKey) {
    lastAutoCaptureHref = "";
    return;
  }

  if (autoCaptureTimerId) {
    window.clearTimeout(autoCaptureTimerId);
  }

  autoCaptureTimerId = window.setTimeout(() => {
    autoCaptureTimerId = 0;
    void runAutoCapture(routeKey, Boolean(options.force));
  }, AUTO_CAPTURE_ROUTE_SETTLE_MS);
}

function getCurrentNoteRouteKey() {
  const path = location.pathname || "";
  const match = path.match(/^\/explore\/([^/?#]+)/);
  if (!match) {
    return "";
  }
  return `${location.origin}/explore/${match[1]}`;
}

async function runAutoCapture(routeKey, force) {
  if (autoCaptureInFlight) {
    return;
  }

  const context = await getAutoCaptureContext().catch(() => null);
  if (!context?.enabled || !context.activeTaskId) {
    return;
  }

  const currentHref = location.href;
  if (!force && currentHref === lastAutoCaptureHref) {
    return;
  }

  autoCaptureInFlight = true;

  try {
    const captureResponse = await handleCaptureCurrentNote();
    const storeResponse = await chrome.runtime.sendMessage({
      type: "STORE_CAPTURED_NOTE",
      note: captureResponse.note,
      source: "auto"
    });

    if (!storeResponse?.ok) {
      throw new Error(storeResponse?.error || "自动写入任务失败");
    }

    if (storeResponse.capture?.mode === "skipped") {
      lastAutoCaptureHref = currentHref;
      showPageToast(
        `已跳过重复帖子：${storeResponse.capture?.note?.title || "未命名帖子"}`,
        "info"
      );
      return;
    }

    lastAutoCaptureHref = currentHref;
    showPageToast(
      `${storeResponse.capture?.mode === "updated" ? "自动更新完成" : "自动采集完成"}：${storeResponse.capture?.note?.title || "未命名帖子"}`,
      "success"
    );
  } catch (error) {
    showPageToast(`自动采集失败：${error.message}`, "error");
    void reportExtensionError({
      source: "content",
      context: "autoCapture",
      message: String(error?.message || error || "自动采集失败")
    });
  } finally {
    autoCaptureInFlight = false;
  }
}

function initializeContentErrorHooks() {
  window.addEventListener("error", (event) => {
    const message = String(event?.message || "页面脚本发生未知错误");
    showPageToast(`扩展异常：${message}`, "error");
    void reportExtensionError({
      source: "content",
      context: "global",
      message
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const message = reason instanceof Error
      ? String(reason.message || reason.name || "Promise 异常")
      : String(reason || "Promise 异常");
    showPageToast(`扩展异常：${message}`, "error");
    void reportExtensionError({
      source: "content",
      context: "promise",
      message
    });
  });
}

function extractCurrentDetail(payload) {
  const state = payload?.state ?? {};
  const noteState = payload?.state?.note ?? {};
  const detailMap = noteState.noteDetailMap ?? {};
  const currentId = noteState.currentNoteId;

  let detail = currentId ? detailMap[currentId] : undefined;
  if (!detail && detailMap && typeof detailMap === "object") {
    detail = Object.values(detailMap).find(Boolean);
  }

  return {
    href: payload?.href || location.href,
    detail,
    currentId,
    serverTime: Number(state?.global?.serverTime || 0) || Date.now()
  };
}

function extractUserInfo(state, detail, detailSnapshot) {
  const basicInfo = state?.user?.userPageData?.basicInfo ?? {};
  const notePayload = extractNotePayload(detail);
  const noteUser = notePayload?.user ?? {};

  return {
    nickname: firstNonEmpty([
      basicInfo.nickname,
      noteUser.nickname,
      detailSnapshot.author,
      deepFindString(detail, ["nickname", "displayName", "userName"])
    ]),
    redId: firstNonEmpty([
      basicInfo.redId,
      detailSnapshot.redId,
      noteUser.redId,
      deepFindString(detail, ["redId"])
    ])
  };
}

function normalizeCurrentDetail(user, detailBundle, detailSnapshot) {
  const detail = detailBundle.detail;
  const notePayload = extractNotePayload(detail);
  const interactInfo = notePayload?.interactInfo ?? {};
  const publishTimestamp = firstNonEmpty([
    notePayload?.time,
    deepFindScalar(notePayload, ["time", "publishTime", "publishDate"]),
    deepFindScalar(detail, ["publishTime", "publishDate", "time"])
  ]);
  const referenceTime = Number(detailBundle.serverTime || Date.now()) || Date.now();
  const fallbackYear = inferPublishYear(publishTimestamp, referenceTime);
  const title = firstNonEmpty([
    notePayload?.title,
    detailSnapshot.title,
    deepFindString(notePayload, ["title", "displayTitle"]),
    deepFindString(detail, ["title", "displayTitle"]),
    readText(document, [
      ".title",
      ".note-content .title",
      ".content .title"
    ])
  ]);

  const content = cleanText(
    firstNonEmpty([
      notePayload?.desc,
      detailSnapshot.content,
      deepFindString(notePayload, ["desc", "content", "description"]),
      deepFindString(detail, ["desc", "content", "description"]),
      readText(document, [
        ".desc",
        ".note-text",
        ".content",
        ".note-content"
      ])
    ])
  );

  const publishTime = cleanText(
    normalizePublishTimeValue(
      firstNonEmpty([
        publishTimestamp,
        detailSnapshot.publishTime,
        deepFindScalar(notePayload, ["publishTime", "publishDate", "lastUpdateTime"]),
        deepFindScalar(detail, ["publishTime", "publishDate", "time", "lastUpdateTime"]),
        readVisibleText([
          ".date",
          ".time",
          ".publish-time",
          ".note-date",
          "[class*='publish']",
          "[class*='date']"
        ]),
        findTimeLikeText(document.body?.innerText || "")
      ]),
      { referenceTime, fallbackYear }
    )
  );

  const likes = parseMetricCount(
    firstNonEmpty([
      detailSnapshot.likesText,
      interactInfo.likedCount,
      deepFindScalar(notePayload, ["likedCount"]),
      deepFindScalar(detail, ["likedCount"]),
      readVisibleMetricCount([
        ".like-wrapper .count",
        "[class*='like-wrapper'] .count"
      ]),
      0
    ])
  );

  const comments = parseMetricCount(
    firstNonEmpty([
      detailSnapshot.commentsText,
      interactInfo.commentCount,
      deepFindScalar(notePayload, ["commentCount", "commentsCount", "commentTotal", "comments"]),
      deepFindScalar(detail, ["commentCount", "commentsCount", "commentTotal", "comments"]),
      readVisibleMetricCount([
        ".chat-wrapper .count",
        "[class*='chat-wrapper'] .count",
        ".comment-wrapper .count",
        "[class*='comment-wrapper'] .count"
      ]),
      0
    ])
  );

  const noteType = firstNonEmpty([
    notePayload?.type,
    deepFindString(notePayload, ["type", "noteType"]),
    deepFindString(detail, ["type", "noteType"]),
    inferNoteTypeFromDom()
  ]);

  const coverImageUrl = resolveCoverImageUrl({
    notePayload,
    detail,
    detailSnapshot,
    noteType
  });

  const noteUrl = extractNoteUrl(detail, detailBundle.href || detailSnapshot.noteUrl);
  const accountName = cleanText(user.redId || user.nickname || "");
  const remarkList = [];
  if (!coverImageUrl && cleanText(noteType).toLowerCase() !== "video") {
    remarkList.push("封面图缺失");
  }
  if (!publishTime) {
    remarkList.push("发布时间缺失");
  }
  if (!accountName) {
    remarkList.push("作者信息缺失");
  }

  return {
    noteKey: noteUrl || `${accountName}::${publishTime}::${title}`,
    coverImageUrl,
    author: cleanText(user.nickname || ""),
    redId: accountName,
    publishMonth: deriveMonthLabel(publishTime),
    publishTime,
    title: cleanText(title),
    content,
    likes,
    comments,
    noteType,
    noteUrl,
    status: remarkList.length ? "部分成功" : "成功",
    remark: remarkList.join("；")
  };
}

function extractNotePayload(detail) {
  if (!detail || typeof detail !== "object") {
    return null;
  }

  if (detail.note && typeof detail.note === "object") {
    return detail.note;
  }

  return detail;
}

function readDetailSnapshot() {
  const metricSnapshot = readDetailMetricSnapshot();
  const title = readVisibleText([
    ".note-content .title",
    ".content .title",
    ".title"
  ]);
  const content = cleanText(readVisibleText([
    ".desc",
    ".note-text",
    ".note-content",
    ".content"
  ]));
  const publishTime = readVisibleText([
    ".date",
    ".time",
    ".publish-time",
    ".note-date",
    "[class*='publish']",
    "[class*='date']"
  ]);
  const likesText = metricSnapshot.likesText;
  const commentsText = metricSnapshot.commentsText;
  const author = readVisibleText([
    ".author .name",
    ".author-wrapper .username",
    ".username",
    "[class*='author-wrapper'] [class*='username']",
    "[class*='username']",
    "[class*='author'] [class*='name']",
    ".user .name",
    "[class*='user'] [class*='name']"
  ]);
  const redId = readVisibleText([
    "[class*='red-id']",
    "[class*='user-id']"
  ]);
  const coverImageUrl = readDetailCoverImageUrl();

  return {
    title,
    content,
    publishTime,
    likesText,
    commentsText,
    author,
    redId,
    coverImageUrl,
    noteUrl: location.href,
    isReady: Boolean(title || content || publishTime || likesText || commentsText || coverImageUrl)
  };
}

function readText(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const text = cleanText(element?.textContent || "");
    if (text) {
      return text;
    }
  }
  return "";
}

function readVisibleText(selectors) {
  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      if (!isProbablyDetailElement(element)) {
        continue;
      }

      const text = cleanText(element.textContent || "");
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function readVisibleMetricCount(selectors) {
  return readVisibleText(selectors);
}

function readDetailMetricSnapshot() {
  const root = findDetailMetricRoot();
  if (!root) {
    return {
      likesText: "",
      commentsText: ""
    };
  }

  return {
    likesText: readMetricTextWithin(root, [
      ".like-wrapper .count",
      "[class*='like-wrapper'] .count"
    ]),
    commentsText: readMetricTextWithin(root, [
      ".chat-wrapper .count",
      "[class*='chat-wrapper'] .count",
      ".comment-wrapper .count",
      "[class*='comment-wrapper'] .count"
    ])
  };
}

function findDetailMetricRoot() {
  const selectorList = [
    ".engage-bar .input-box",
    "[class*='engage-bar'] .input-box",
    ".input-box",
    "[class*='input-box']",
    ".engage-bar",
    "[class*='engage-bar']"
  ];
  const candidateSet = new Set();

  for (const selector of selectorList) {
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (!isProbablyDetailElement(element)) {
        continue;
      }

      const metricHits = countMetricWrappers(element);
      if (!metricHits) {
        continue;
      }

      candidateSet.add(element);
    }
  }

  return [...candidateSet]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const className = cleanText(element.className || "");
      const metricHits = countMetricWrappers(element);
      const engageScore = /(engage-bar|input-box)/.test(className) ? 2 : 0;
      return {
        element,
        metricHits,
        engageScore,
        area: rect.width * rect.height,
        bottom: rect.bottom
      };
    })
    .sort((left, right) => {
      if (right.metricHits !== left.metricHits) {
        return right.metricHits - left.metricHits;
      }

      if (right.engageScore !== left.engageScore) {
        return right.engageScore - left.engageScore;
      }

      if (right.bottom !== left.bottom) {
        return right.bottom - left.bottom;
      }

      return right.area - left.area;
    })[0]?.element || null;
}

function countMetricWrappers(root) {
  let hits = 0;
  if (root.querySelector(".like-wrapper, [class*='like-wrapper']")) {
    hits += 1;
  }
  if (root.querySelector(".chat-wrapper, [class*='chat-wrapper'], .comment-wrapper, [class*='comment-wrapper']")) {
    hits += 1;
  }
  return hits;
}

function readMetricTextWithin(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const text = cleanText(element?.textContent || "");
    if (text) {
      return text;
    }
  }
  return "";
}

function readBestVisibleImageUrl(root = document) {
  const imageNodes = root instanceof Document
    ? Array.from(root.images)
    : Array.from(root.querySelectorAll("img"));

  const images = imageNodes
    .filter((image) => isProbablyDetailImage(image))
    .map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        src: normalizeImageUrl(image.currentSrc || image.src || ""),
        area: rect.width * rect.height
      };
    })
    .filter((item) => item.src)
    .sort((left, right) => right.area - left.area);

  return images[0]?.src || "";
}

function isProbablyDetailImage(image) {
  if (!(image instanceof HTMLImageElement)) {
    return false;
  }

  if (!isProbablyDetailElement(image)) {
    return false;
  }

  if (image.closest("section.note-item")) {
    return false;
  }

  if (image.closest("[class*='avatar']")) {
    return false;
  }

  if (image.closest(".comment-list, .comment-item, [class*='comment-list'], [class*='comment-item'], .comments-container")) {
    return false;
  }

  const src = normalizeImageUrl(image.currentSrc || image.src || "");
  if (!src.includes("xhscdn")) {
    return false;
  }

  const rect = image.getBoundingClientRect();
  return rect.width >= 120 && rect.height >= 120;
}

function isProbablyDetailElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.closest("section.note-item")) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function inferNoteTypeFromDom() {
  const noteContainer = getDetailNoteContainer();
  if (noteContainer?.getAttribute("data-type") === "video" || noteContainer?.querySelector("video")) {
    return "video";
  }

  return document.querySelector("video") ? "video" : "normal";
}

function extractNoteUrl(detail, href) {
  const notePayload = extractNotePayload(detail);
  if (href && /\/explore\//.test(href)) {
    return href;
  }

  const noteId = cleanText(String(firstNonEmpty([
    notePayload?.noteId,
    deepFindScalar(notePayload, ["noteId", "note_id"]),
    deepFindScalar(detail, ["noteId", "note_id"])
  ])));
  const xsecToken = cleanText(String(firstNonEmpty([
    notePayload?.xsecToken,
    deepFindScalar(notePayload, ["xsecToken", "xsec_token"]),
    deepFindScalar(detail, ["xsecToken", "xsec_token"])
  ])));

  if (noteId && xsecToken) {
    return `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_user`;
  }

  if (noteId) {
    return `https://www.xiaohongshu.com/explore/${noteId}`;
  }

  return href || location.href;
}

function deepFindString(root, keys) {
  const value = deepFindValue(root, (key, currentValue) => {
    return keys.includes(key) && typeof currentValue === "string" && currentValue.trim();
  });
  return typeof value === "string" ? value : "";
}

function deepFindScalar(root, keys) {
  return deepFindValue(root, (key, currentValue) => {
    return keys.includes(key) && (typeof currentValue === "string" || typeof currentValue === "number");
  });
}

function deepFindImageUrl(root) {
  const value = deepFindValue(root, (key, currentValue) => {
    if (typeof currentValue !== "string") {
      return false;
    }

    if (!currentValue.includes("xhscdn")) {
      return false;
    }

    return ["urlDefault", "urlPre", "url"].includes(key);
  });

  return normalizeImageUrl(typeof value === "string" ? value : "");
}

function deepFindValue(root, matcher, visited = new WeakSet()) {
  if (!root || typeof root !== "object") {
    return undefined;
  }

  if (visited.has(root)) {
    return undefined;
  }
  visited.add(root);

  if (Array.isArray(root)) {
    for (const item of root) {
      const found = deepFindValue(item, matcher, visited);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(root)) {
    if (matcher(key, value)) {
      return value;
    }

    if (value && typeof value === "object") {
      const found = deepFindValue(value, matcher, visited);
      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}

function parseMetricCount(input) {
  const raw = String(input || "").trim().replace(/\+/g, "");
  if (!raw) {
    return 0;
  }

  const numeric = Number(raw.replace(/,/g, ""));
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const matched = raw.match(/^([\d.]+)\s*([万千kK])$/);
  if (!matched) {
    const digits = raw.match(/[\d.]+/);
    return digits ? Number(digits[0]) : 0;
  }

  const value = Number(matched[1]);
  const unit = matched[2];

  if (unit === "万") {
    return Math.round(value * 10_000);
  }

  if (unit === "千" || unit === "k" || unit === "K") {
    return Math.round(value * 1_000);
  }

  return Math.round(value);
}

function normalizePublishTimeValue(value, options = {}) {
  const referenceTime = Number(options.referenceTime || Date.now()) || Date.now();
  const fallbackYear = Number(options.fallbackYear || new Date(referenceTime).getFullYear());

  if (typeof value === "number" && Number.isFinite(value)) {
    return formatTimestamp(value);
  }

  const raw = cleanText(value);
  if (!raw) {
    return "";
  }

  if (/^\d{10,13}$/.test(raw)) {
    return formatTimestamp(Number(raw));
  }

  const token = extractTimeToken(raw);
  if (!token) {
    return raw;
  }

  const normalized = parseTimeToken(token, referenceTime, fallbackYear);
  if (normalized) {
    return normalized;
  }

  if (/^\d{10,13}$/.test(token)) {
    return formatTimestamp(Number(token));
  }

  if (token !== raw) {
    return token;
  }

  return raw;
}

function formatTimestamp(value) {
  const timestamp = String(value).length === 10 ? value * 1000 : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function deriveMonthLabel(publishTime) {
  const raw = cleanText(publishTime);
  if (!raw) {
    return "";
  }

  const fullDate = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (fullDate) {
    return `${fullDate[1]}-${pad2(Number(fullDate[2]))}`;
  }

  return "";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function findTimeLikeText(input) {
  return extractTimeToken(String(input || ""));
}

function normalizeImageUrl(url) {
  if (!url) {
    return "";
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  if (url.startsWith("http://")) {
    return `https://${url.slice("http://".length)}`;
  }

  return url;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
}

function resolveCoverImageUrl({ notePayload, detail, detailSnapshot, noteType }) {
  const normalizedType = cleanText(noteType).toLowerCase();
  if (normalizedType === "video") {
    return "";
  }

  return firstNonEmpty([
    pickPrimaryImageUrl(notePayload),
    readDetailCoverImageUrl(),
    deepFindImageUrl(notePayload),
    deepFindImageUrl(detail),
    detailSnapshot.coverImageUrl,
    readBestVisibleImageUrl(getDetailNoteContainer() || document)
  ]);
}

function getDetailNoteContainer() {
  return document.querySelector("#noteContainer, .note-container");
}

function readDetailCoverImageUrl() {
  const noteContainer = getDetailNoteContainer();
  if (!(noteContainer instanceof HTMLElement)) {
    return "";
  }

  const noteType = cleanText(noteContainer.getAttribute("data-type") || "");
  if (noteType.toLowerCase() === "video" || noteContainer.querySelector("video, .player-container, .xg-poster")) {
    return "";
  }

  const mediaRoot = noteContainer.querySelector(".media-container, .xhs-slider-container, .note-slider, .swiper") || noteContainer;

  return firstNonEmpty([
    readIndexedSlideImageUrl(mediaRoot),
    readIndexedSlideBackgroundUrl(mediaRoot),
    readFirstMediaImageUrl(mediaRoot)
  ]);
}

function readIndexedSlideImageUrl(root) {
  const selectors = [
    ".swiper-slide[data-swiper-slide-index='0'] img",
    ".swiper-slide[data-index='0'] img",
    ".swiper-slide-active[data-swiper-slide-index='0'] img",
    ".swiper-slide-active[data-index='0'] img",
    ".swiper-slide:not(.swiper-slide-duplicate) img"
  ];

  for (const selector of selectors) {
    const image = root.querySelector(selector);
    const src = normalizeImageUrl(image?.currentSrc || image?.src || "");
    if (src && src.includes("xhscdn")) {
      return src;
    }
  }

  return "";
}

function readIndexedSlideBackgroundUrl(root) {
  const selectors = [
    ".swiper-slide[data-swiper-slide-index='0']",
    ".swiper-slide[data-index='0']",
    ".swiper-slide-active[data-swiper-slide-index='0']",
    ".swiper-slide-active[data-index='0']",
    ".swiper-slide:not(.swiper-slide-duplicate)"
  ];

  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const src = extractBackgroundImageUrl(element);
    if (src) {
      return src;
    }
  }

  return "";
}

function readFirstMediaImageUrl(root) {
  const images = Array.from(root.querySelectorAll("img"))
    .filter((image) => isProbablyDetailImage(image))
    .map((image) => normalizeImageUrl(image.currentSrc || image.src || ""))
    .filter(Boolean);

  return images[0] || "";
}

function extractBackgroundImageUrl(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  const backgroundImage = String(element.style.backgroundImage || getComputedStyle(element).backgroundImage || "");
  const match = backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
  if (!match) {
    return "";
  }

  const src = normalizeImageUrl(match[2] || "");
  return src.includes("xhscdn") ? src : "";
}

function pickPrimaryImageUrl(notePayload) {
  const images = Array.isArray(notePayload?.imageList) ? notePayload.imageList : [];
  const firstImage = images[0];
  if (!firstImage) {
    return "";
  }

  const candidate = normalizeImageUrl(firstNonEmpty([
    firstImage?.urlDefault,
    firstImage?.urlPre,
    Array.isArray(firstImage?.infoList) ? firstImage.infoList.find((item) => item?.url)?.url : "",
    firstImage?.url
  ]));

  return candidate;
}

function inferPublishYear(value, referenceTime) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(normalizeTimestamp(value)).getFullYear();
  }

  const raw = cleanText(value);
  const fullDateMatch = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (fullDateMatch) {
    return Number(fullDateMatch[1]);
  }

  return new Date(referenceTime || Date.now()).getFullYear();
}

function extractTimeToken(raw) {
  const text = cleanText(raw)
    .replace(/^编辑于\s*/, "")
    .replace(/^发布于\s*/, "")
    .replace(/^发表于\s*/, "");

  if (!text) {
    return "";
  }

  const patterns = [
    /\b\d{10,13}\b/,
    /[几\d]+\s*(?:秒钟?|分钟|小时|天|周|个月|月|年)前/,
    /(?:今天|昨天|前天)(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?/,
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?\b/,
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?\b/,
    /\b\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return cleanText(match[0]);
    }
  }

  return "";
}

function parseTimeToken(token, referenceTime, fallbackYear) {
  const normalizedToken = cleanText(token);
  if (!normalizedToken) {
    return "";
  }

  const relativeMatch = normalizedToken.match(/^([几\d]+)\s*(秒钟?|分钟|小时|天|周|个月|月|年)前$/);
  if (relativeMatch) {
    const rawAmount = relativeMatch[1];
    const amount = rawAmount === "几" ? 3 : Number(rawAmount);
    const unit = relativeMatch[2];
    const delta = convertRelativeUnitToMs(amount, unit);
    if (delta > 0) {
      return formatTimestamp(referenceTime - delta);
    }
  }

  const dayShiftMatch = normalizedToken.match(/^(今天|昨天|前天)(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (dayShiftMatch) {
    const shifted = new Date(referenceTime);
    shifted.setSeconds(0, 0);
    if (dayShiftMatch[1] === "今天") {
      // Keep today's date, just set time if provided
    } else {
      shifted.setDate(shifted.getDate() - (dayShiftMatch[1] === "昨天" ? 1 : 2));
    }
    if (dayShiftMatch[2] !== undefined) {
      shifted.setHours(Number(dayShiftMatch[2]), Number(dayShiftMatch[3] || 0), Number(dayShiftMatch[4] || 0), 0);
      return formatTimestamp(shifted.getTime());
    }
    return formatDateOnly(shifted);
  }

  const fullDateMatch = normalizedToken.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (fullDateMatch) {
    const date = buildDate(
      Number(fullDateMatch[1]),
      Number(fullDateMatch[2]),
      Number(fullDateMatch[3]),
      Number(fullDateMatch[4] || 0),
      Number(fullDateMatch[5] || 0),
      Number(fullDateMatch[6] || 0)
    );
    if (date) {
      return fullDateMatch[4] !== undefined ? formatTimestamp(date.getTime()) : formatDateOnly(date);
    }
  }

  const monthDayMatch = normalizedToken.match(/^(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (monthDayMatch) {
    let year = Number(fallbackYear || new Date(referenceTime).getFullYear());
    let date = buildDate(
      year,
      Number(monthDayMatch[1]),
      Number(monthDayMatch[2]),
      Number(monthDayMatch[3] || 0),
      Number(monthDayMatch[4] || 0),
      Number(monthDayMatch[5] || 0)
    );

    if (!date) {
      return "";
    }

    if (date.getTime() > referenceTime + 36 * 60 * 60 * 1000) {
      date = buildDate(
        year - 1,
        Number(monthDayMatch[1]),
        Number(monthDayMatch[2]),
        Number(monthDayMatch[3] || 0),
        Number(monthDayMatch[4] || 0),
        Number(monthDayMatch[5] || 0)
      );
    }

    if (date) {
      return monthDayMatch[3] !== undefined ? formatTimestamp(date.getTime()) : formatDateOnly(date);
    }
  }

  return "";
}

function convertRelativeUnitToMs(amount, unit) {
  const size = Number(amount || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }

  if (unit.includes("秒")) {
    return size * 1000;
  }

  if (unit === "分钟") {
    return size * 60 * 1000;
  }

  if (unit === "小时") {
    return size * 60 * 60 * 1000;
  }

  if (unit === "天") {
    return size * 24 * 60 * 60 * 1000;
  }

  if (unit === "周") {
    return size * 7 * 24 * 60 * 60 * 1000;
  }

  if (unit === "个月" || unit === "月") {
    return size * 30 * 24 * 60 * 60 * 1000;
  }

  if (unit === "年") {
    return size * 365 * 24 * 60 * 60 * 1000;
  }

  return 0;
}

function buildDate(year, month, day, hours = 0, minutes = 0, seconds = 0) {
  const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatDateOnly(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeTimestamp(value) {
  return String(value).length === 10 ? value * 1000 : value;
}

function showPageToast(message, tone = "info") {
  const host = ensureToastHost();
  const toast = document.createElement("div");
  toast.textContent = cleanText(message);
  toast.style.cssText = [
    "min-width: 220px",
    "max-width: 360px",
    "padding: 12px 14px",
    "border-radius: 14px",
    "box-shadow: 0 14px 30px rgba(31, 26, 22, 0.18)",
    "color: #fff",
    "font-size: 13px",
    "line-height: 1.5",
    "opacity: 0",
    "transform: translateY(-6px)",
    "transition: opacity 180ms ease, transform 180ms ease",
    tone === "error"
      ? "background: linear-gradient(135deg, #c53f32 0%, #e46a4d 100%)"
      : tone === "success"
        ? "background: linear-gradient(135deg, #267a4b 0%, #37a36a 100%)"
        : "background: linear-gradient(135deg, #3f4f69 0%, #5c7192 100%)"
  ].join(";");

  host.appendChild(toast);
  window.requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, AUTO_CAPTURE_TOAST_DURATION_MS);
}

function ensureToastHost() {
  const hostId = "__xhs_capture_toast_host__";
  let host = document.getElementById(hostId);
  if (host) {
    return host;
  }

  host = document.createElement("div");
  host.id = hostId;
  host.style.cssText = [
    "position: fixed",
    "top: 20px",
    "right: 20px",
    "z-index: 2147483647",
    "display: flex",
    "flex-direction: column",
    "gap: 10px",
    "pointer-events: none"
  ].join(";");
  document.documentElement.appendChild(host);
  return host;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
