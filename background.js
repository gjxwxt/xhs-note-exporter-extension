importScripts("vendor/exceljs.min.js");

const CAPTURE_TASKS_KEY = "xhsManualCaptureTasks";
const ACTIVE_TASK_ID_KEY = "xhsManualActiveTaskId";
const AUTO_CAPTURE_ENABLED_KEY = "xhsAutoCaptureEnabled";
const RECENT_ERRORS_KEY = "xhsRecentErrors";
const SESSION_COUNT_KEY = "xhsSessionCaptureCount";
const MAX_RECENT_ERRORS = 12;
const IMAGE_DOWNLOAD_CONCURRENCY = 5;
const IMAGE_DOWNLOAD_MAX_RETRIES = 2;
const IMAGE_QUALITY_MAP = { hd: 1600, standard: 800, thumbnail: 400 };
const IMAGE_MAX_EDGE = 1600;
const IMAGE_CELL = {
  columnWidth: 18,
  rowHeightPt: 104,
  maxWidthPx: 84,
  maxHeightPx: 112,
  offsetX: 10,
  offsetY: 8
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_CAPTURE_STATE") {
    handleGetCaptureState().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "CREATE_CAPTURE_TASK") {
    handleCreateCaptureTask(message.name).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "SELECT_CAPTURE_TASK") {
    handleSelectCaptureTask(message.taskId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "DELETE_CAPTURE_TASK") {
    handleDeleteCaptureTask(message.taskId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "CLEAR_CAPTURE_TASK") {
    handleClearCaptureTask(message.taskId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "DELETE_CAPTURE_NOTE") {
    handleDeleteCaptureNote(message.noteKey, message.taskId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "CAPTURE_CURRENT_NOTE") {
    handleCaptureCurrentNote().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "STORE_CAPTURED_NOTE") {
    handleStoreCapturedNote(message.note, message.source).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "EXPORT_CAPTURE_TASK") {
    handleExportCaptureTask(message.taskId, message.mode, message.batchSize, message.imageQuality).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "GET_PAGE_STATE") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "无法定位当前标签页。" });
      return false;
    }

    handleGetPageState(tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "GET_AUTO_CAPTURE_CONTEXT") {
    handleGetAutoCaptureContext().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "SET_AUTO_CAPTURE_ENABLED") {
    handleSetAutoCaptureEnabled(message.enabled).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "REPORT_EXTENSION_ERROR") {
    handleReportExtensionError(message.payload).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "RESET_SESSION_COUNT") {
    handleResetSessionCount().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});

self.addEventListener("error", (event) => {
  void appendRecentError({
    source: "background",
    context: "global",
    message: event?.message || "后台脚本发生未知错误"
  });
});

self.addEventListener("unhandledrejection", (event) => {
  void appendRecentError({
    source: "background",
    context: "promise",
    message: stringifyUnknownError(event?.reason)
  });
});

async function handleGetCaptureState() {
  const state = await loadCaptureState();
  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleCreateCaptureTask(rawName) {
  const state = await loadCaptureState();
  const name = sanitizeTaskName(rawName) || defaultTaskName();
  const normalizedName = normalizeTaskName(name);

  if (state.tasks.some((task) => normalizeTaskName(task.name) === normalizedName)) {
    throw new Error("已经存在同名采集任务，请换一个名称。");
  }

  const task = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: []
  };

  state.tasks.unshift(task);
  state.activeTaskId = task.id;
  await saveCaptureState(state);
  await notifyCaptureSettingsChanged();

  return {
    ok: true,
    state: summarizeState(state),
    task: summarizeTask(task)
  };
}

async function handleSelectCaptureTask(taskId) {
  const state = await loadCaptureState();
  const nextTaskId = String(taskId || "");

  if (nextTaskId && !state.tasks.find((task) => task.id === nextTaskId)) {
    throw new Error("找不到对应的采集任务。");
  }

  state.activeTaskId = nextTaskId;
  await saveCaptureState(state);
  await notifyCaptureSettingsChanged();

  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleDeleteCaptureTask(taskId) {
  const state = await loadCaptureState();
  const targetId = String(taskId || state.activeTaskId || "");

  if (!targetId) {
    throw new Error("当前没有选中的采集任务。");
  }

  const nextTasks = state.tasks.filter((task) => task.id !== targetId);
  if (nextTasks.length === state.tasks.length) {
    throw new Error("没有找到要删除的采集任务。");
  }

  state.tasks = nextTasks;
  state.activeTaskId = state.tasks[0]?.id || "";
  if (!state.activeTaskId) {
    state.autoCaptureEnabled = false;
  }

  await saveCaptureState(state);
  await notifyCaptureSettingsChanged();

  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleClearCaptureTask(taskId) {
  const state = await loadCaptureState();
  const task = getTaskById(state, taskId || state.activeTaskId);

  if (!task) {
    throw new Error("当前没有选中的采集任务。");
  }

  task.notes = [];
  task.updatedAt = new Date().toISOString();
  sortTasksInPlace(state.tasks);
  await saveCaptureState(state);

  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleDeleteCaptureNote(noteKey, taskId) {
  const state = await loadCaptureState();
  const task = getTaskById(state, taskId || state.activeTaskId);

  if (!task) {
    throw new Error("当前没有选中的采集任务。");
  }

  const targetKey = cleanText(noteKey || "");
  if (!targetKey) {
    throw new Error("缺少要删除的记录标识。");
  }

  const nextNotes = task.notes.filter((note) => computeNoteKey(note) !== targetKey);
  if (nextNotes.length === task.notes.length) {
    throw new Error("没有找到要删除的采集记录。");
  }

  task.notes = nextNotes;
  resequenceTaskNotes(task);
  task.updatedAt = new Date().toISOString();
  sortTasksInPlace(state.tasks);
  await saveCaptureState(state);

  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleCaptureCurrentNote() {
  const state = await loadCaptureState();

  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("没有找到当前标签页。");
  }

  if (!String(tab.url || "").includes("xiaohongshu.com")) {
    throw new Error("请先切到小红书帖子详情页。");
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_CURRENT_NOTE" });
  } catch (error) {
    throw new Error("当前页面还没注入扩展脚本。请刷新帖子页面后再试一次。");
  }

  if (!response?.ok || !response.note) {
    throw new Error(response?.error || "没有拿到当前帖子详情数据。");
  }

  const capture = storeCapturedNoteInState(state, response.note, { source: "manual" });
  await saveCaptureState(state);

  return {
    ok: true,
    state: summarizeState(state),
    capture
  };
}

async function handleStoreCapturedNote(note, source) {
  const state = await loadCaptureState();
  const capture = storeCapturedNoteInState(state, note, {
    source: source === "auto" ? "auto" : "manual"
  });
  await saveCaptureState(state);

  return {
    ok: true,
    state: summarizeState(state),
    capture
  };
}

async function handleExportCaptureTask(taskId, mode, batchSize, imageQuality) {
  const state = await loadCaptureState();
  const task = getTaskById(state, taskId || state.activeTaskId);

  if (!task) {
    throw new Error("请先选择一个采集任务。");
  }

  if (!task.notes.length) {
    throw new Error("当前任务还没有采集记录。");
  }

  const parsedBatchSize = Number(batchSize) || 0;
  const isBatch = parsedBatchSize > 0 && parsedBatchSize < task.notes.length;

  if (!isBatch) {
    const filename = await exportTaskWorkbook(task, {
      includeImages: mode !== "fast",
      mode: mode === "fast" ? "fast" : "full",
      imageQuality: imageQuality || "hd"
    });

    return {
      ok: true,
      filename,
      batchCount: 1,
      state: summarizeState(state)
    };
  }

  const allNotes = [...task.notes].sort(
    (left, right) => Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0)
  );
  const batchCount = Math.ceil(allNotes.length / parsedBatchSize);
  let lastFilename = "";

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const batchNotes = allNotes.slice(batchIndex * parsedBatchSize, (batchIndex + 1) * parsedBatchSize);
    const batchTask = {
      ...task,
      notes: batchNotes
    };
    lastFilename = await exportTaskWorkbook(batchTask, {
      includeImages: mode !== "fast",
      mode: mode === "fast" ? "fast" : "full",
      batchIndex: batchCount > 1 ? batchIndex + 1 : 0,
      batchTotal: batchCount,
      imageQuality: imageQuality || "hd"
    });
  }

  state.activeTaskId = task.id;
  return {
    ok: true,
    filename: lastFilename,
    batchCount,
    state: summarizeState(state)
  };
}

async function handleGetPageState(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const snapshot = window.__INITIAL_STATE__ ?? {};
      let serializableState = null;

      try {
        serializableState = JSON.parse(JSON.stringify({
          global: {
            serverTime: snapshot.global?.serverTime ?? 0
          },
          user: {
            userPageData: {
              basicInfo: snapshot.user?.userPageData?.basicInfo ?? {}
            }
          },
          note: {
            currentNoteId: snapshot.note?.currentNoteId ?? "",
            noteDetailMap: snapshot.note?.noteDetailMap ?? {},
            serverRequestInfo: snapshot.note?.serverRequestInfo ?? {}
          }
        }));
      } catch (error) {
        serializableState = null;
      }

      return {
        href: window.location.href,
        title: document.title,
        state: serializableState
      };
    }
  });

  return {
    ok: true,
    payload: result?.result ?? null
  };
}

async function handleGetAutoCaptureContext() {
  const state = await loadCaptureState();
  return {
    ok: true,
    context: {
      enabled: Boolean(state.autoCaptureEnabled),
      activeTaskId: state.activeTaskId || "",
      activeTaskName: getTaskById(state, state.activeTaskId)?.name || ""
    }
  };
}

async function handleSetAutoCaptureEnabled(enabled) {
  const state = await loadCaptureState();
  const nextEnabled = Boolean(enabled);

  if (nextEnabled && !state.activeTaskId) {
    throw new Error("请先新建或选择一个采集任务，再开启自动采集。");
  }

  state.autoCaptureEnabled = nextEnabled;
  await saveCaptureState(state);
  await notifyCaptureSettingsChanged();

  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleReportExtensionError(payload) {
  await appendRecentError(payload);
  const state = await loadCaptureState();
  return {
    ok: true,
    state: summarizeState(state)
  };
}

async function handleResetSessionCount() {
  await chrome.storage.local.set({ [SESSION_COUNT_KEY]: 0 });
  return { ok: true };
}

async function exportTaskWorkbook(task, options = {}) {
  const includeImages = options.includeImages !== false;
  const exportMode = options.mode === "fast" ? "fast" : "full";
  const imageQuality = options.imageQuality || "hd";
  const imageMaxEdge = IMAGE_QUALITY_MAP[imageQuality] || IMAGE_MAX_EDGE;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex";
  workbook.created = new Date();

  const detailSheet = workbook.addWorksheet("笔记明细", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  const summarySheet = workbook.addWorksheet("月度汇总");
  const metaSheet = workbook.addWorksheet("采集信息");

  detailSheet.columns = [
    { header: "封面图", key: "cover", width: 18 },
    { header: "序号", key: "sourceIndex", width: 10 },
    { header: "账号/昵称", key: "redId", width: 18 },
    { header: "发布时间", key: "publishTime", width: 20 },
    { header: "标题", key: "title", width: 28 },
    { header: "正文", key: "content", width: 52 },
    { header: "点赞数", key: "likes", width: 12 },
    { header: "评论数", key: "comments", width: 12 },
    { header: "笔记类型", key: "noteType", width: 12 },
    { header: "笔记链接", key: "noteUrl", width: 28 },
    { header: "抓取状态", key: "status", width: 14 },
    { header: "备注", key: "remark", width: 22 }
  ];

  styleHeaderRow(detailSheet.getRow(1), "FFD84D35");
  detailSheet.getRow(1).height = 24;

  const notes = [...task.notes].sort((left, right) => Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0));
  const imageDownloadTasks = [];

  for (const note of notes) {
    const row = detailSheet.addRow({
      sourceIndex: note.sourceIndex ?? "",
      redId: note.redId ?? "",
      publishTime: note.publishTime ?? "",
      title: note.title ?? "",
      content: note.content ?? "",
      likes: note.likes ?? "",
      comments: note.comments ?? "",
      noteType: note.noteType ?? "",
      noteUrl: note.noteUrl ?? "",
      status: note.status ?? "",
      remark: note.remark ?? ""
    });

    row.height = 104;
    row.alignment = { vertical: "top", wrapText: true };

    if (note.noteUrl) {
      const cell = row.getCell("noteUrl");
      cell.value = {
        text: note.noteUrl,
        hyperlink: note.noteUrl
      };
      cell.font = { color: { argb: "FF0E5FD8" }, underline: true };
    }

    if (includeImages && note.coverImageUrl) {
      imageDownloadTasks.push({ row, note, rowIndex: row.number });
    }
  }

  if (imageDownloadTasks.length > 0) {
    const imageResults = await concurrentMap(
      imageDownloadTasks.map((t) => t.note),
      async (note) => {
        const image = await downloadImageWithRetry(note.coverImageUrl, IMAGE_DOWNLOAD_MAX_RETRIES, imageMaxEdge);
        return { coverImageUrl: note.coverImageUrl, success: true, image, rowIndex: null };
      },
      IMAGE_DOWNLOAD_CONCURRENCY
    );

    for (let i = 0; i < imageDownloadTasks.length; i += 1) {
      const { row, note, rowIndex } = imageDownloadTasks[i];
      const result = imageResults[i];

      if (result && result.success) {
        try {
          const imageId = workbook.addImage({
            buffer: result.image.buffer,
            extension: result.image.extension
          });
          detailSheet.addImage(imageId, {
            tl: buildImageTopLeft(rowIndex, result.image.width, result.image.height),
            ext: buildImageExt(result.image.width, result.image.height),
            editAs: "oneCell"
          });
        } catch (error) {
          row.getCell("remark").value = appendRemark(
            row.getCell("remark").value,
            `封面失败: ${error.message}`
          );
        }
      } else {
        row.getCell("remark").value = appendRemark(
          row.getCell("remark").value,
          `封面失败: 下载失败`
        );
      }
    }
  }

  styleBody(detailSheet, notes.length, detailSheet.columnCount);
  writeSummarySheet(summarySheet, notes);
  writeMetaSheet(metaSheet, task, notes, exportMode);
  styleSummarySheet(summarySheet);
  styleMetaSheet(metaSheet);

  const filename = buildFileName(task.name, exportMode, options.batchIndex, options.batchTotal);
  const buffer = await workbook.xlsx.writeBuffer();
  const url = arrayBufferToDataUrl(
    buffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  await chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });

  return filename;
}

async function loadCaptureState() {
  const stored = await chrome.storage.local.get([
    CAPTURE_TASKS_KEY,
    ACTIVE_TASK_ID_KEY,
    AUTO_CAPTURE_ENABLED_KEY,
    RECENT_ERRORS_KEY,
    SESSION_COUNT_KEY
  ]);
  const tasks = Array.isArray(stored[CAPTURE_TASKS_KEY]) ? stored[CAPTURE_TASKS_KEY] : [];
  const activeTaskId = String(stored[ACTIVE_TASK_ID_KEY] || "");
  const autoCaptureEnabled = Boolean(stored[AUTO_CAPTURE_ENABLED_KEY]);
  const recentErrors = Array.isArray(stored[RECENT_ERRORS_KEY]) ? stored[RECENT_ERRORS_KEY] : [];
  const sessionCaptureCount = Number(stored[SESSION_COUNT_KEY] || 0);

  sortTasksInPlace(tasks);

  return {
    tasks,
    autoCaptureEnabled,
    recentErrors,
    activeTaskId: activeTaskId && tasks.find((task) => task.id === activeTaskId)
      ? activeTaskId
      : "",
    sessionCaptureCount
  };
}

async function saveCaptureState(state) {
  sortTasksInPlace(state.tasks);
  await chrome.storage.local.set({
    [CAPTURE_TASKS_KEY]: state.tasks,
    [ACTIVE_TASK_ID_KEY]: state.activeTaskId || "",
    [AUTO_CAPTURE_ENABLED_KEY]: Boolean(state.autoCaptureEnabled),
    [RECENT_ERRORS_KEY]: Array.isArray(state.recentErrors) ? state.recentErrors.slice(0, MAX_RECENT_ERRORS) : [],
    [SESSION_COUNT_KEY]: Number(state.sessionCaptureCount || 0)
  });
}

function summarizeState(state) {
  const tasks = state.tasks.map(summarizeTask);
  const activeTask = tasks.find((task) => task.id === state.activeTaskId) || null;

  return {
    tasks,
    activeTaskId: state.activeTaskId || "",
    activeTask,
    autoCaptureEnabled: Boolean(state.autoCaptureEnabled),
    recentErrors: Array.isArray(state.recentErrors) ? state.recentErrors : [],
    latestError: Array.isArray(state.recentErrors) ? state.recentErrors[0] || null : null,
    sessionCaptureCount: Number(state.sessionCaptureCount || 0)
  };
}

function summarizeTask(task) {
  const notes = Array.isArray(task.notes) ? task.notes : [];
  const lastNote = [...notes]
    .sort((left, right) => {
      const leftTime = Date.parse(left.capturedAt || left.updatedAt || 0);
      const rightTime = Date.parse(right.capturedAt || right.updatedAt || 0);
      return rightTime - leftTime;
    })[0] || null;

  return {
    id: task.id,
    name: task.name,
    createdAt: task.createdAt || "",
    updatedAt: task.updatedAt || "",
    noteCount: notes.length,
    notes: [...notes]
      .sort((left, right) => Number(right.sourceIndex || 0) - Number(left.sourceIndex || 0))
      .map((note) => ({
        noteKey: computeNoteKey(note),
        sourceIndex: note.sourceIndex ?? "",
        title: note.title ?? "",
        publishTime: note.publishTime ?? "",
        status: note.status ?? "",
        author: note.author ?? "",
        redId: note.redId ?? ""
      })),
    lastNote: lastNote
      ? {
          sourceIndex: lastNote.sourceIndex ?? "",
          title: lastNote.title ?? "",
          publishTime: lastNote.publishTime ?? "",
          likes: lastNote.likes ?? 0,
          comments: lastNote.comments ?? 0,
          status: lastNote.status ?? ""
        }
      : null
  };
}

function getTaskById(state, taskId) {
  const id = String(taskId || "");
  return state.tasks.find((task) => task.id === id) || null;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function upsertNote(task, incomingNote) {
  return upsertNoteWithOptions(task, incomingNote, {});
}

function upsertNoteWithOptions(task, incomingNote, options = {}) {
  const noteKey = computeNoteKey(incomingNote);
  const existingIndex = task.notes.findIndex((note) => computeNoteKey(note) === noteKey);
  const capturedAt = new Date().toISOString();

  if (existingIndex >= 0) {
    const previous = task.notes[existingIndex];
    if (options.skipExisting) {
      return {
        mode: "skipped",
        rowNumber: previous.sourceIndex,
        note: previous
      };
    }

    const updated = {
      ...previous,
      ...incomingNote,
      sourceIndex: previous.sourceIndex,
      noteKey,
      capturedAt
    };
    task.notes.splice(existingIndex, 1, updated);
    return {
      mode: "updated",
      rowNumber: previous.sourceIndex,
      note: updated
    };
  }

  const nextIndex = task.notes.reduce((max, note) => Math.max(max, Number(note.sourceIndex || 0)), 0) + 1;
  const created = {
    ...incomingNote,
    sourceIndex: nextIndex,
    noteKey,
    capturedAt
  };
  task.notes.push(created);

  return {
    mode: "created",
    rowNumber: nextIndex,
    note: created
  };
}

function storeCapturedNoteInState(state, rawNote, options = {}) {
  const task = getTaskById(state, state.activeTaskId);
  if (!task) {
    throw new Error("请先新建或选择一个采集任务。");
  }

  const incomingNote = normalizeStoredNote(rawNote);
  const capture = upsertNoteWithOptions(task, incomingNote, {
    skipExisting: options.source === "auto"
  });

  if (capture.mode !== "skipped") {
    task.updatedAt = new Date().toISOString();
    sortTasksInPlace(state.tasks);
    state.sessionCaptureCount = Number(state.sessionCaptureCount || 0) + 1;
  }

  return capture;
}

function normalizeStoredNote(note) {
  return {
    noteKey: cleanText(note.noteKey || ""),
    coverImageUrl: normalizeImageUrl(note.coverImageUrl || ""),
    author: cleanText(note.author || ""),
    redId: cleanText(note.redId || ""),
    publishMonth: normalizeMonthLabel(note.publishMonth || deriveMonthLabel(note.publishTime || "")),
    publishTime: cleanText(note.publishTime || ""),
    title: cleanText(note.title || ""),
    content: cleanText(note.content || ""),
    likes: Number(note.likes || 0),
    comments: Number(note.comments || 0),
    noteType: cleanText(note.noteType || "normal"),
    noteUrl: cleanText(note.noteUrl || ""),
    status: cleanText(note.status || "成功"),
    remark: cleanText(note.remark || "")
  };
}

function computeNoteKey(note) {
  return cleanText(note.noteKey || note.noteUrl || `${note.redId}::${note.publishTime}::${note.title}`);
}

function sortTasksInPlace(tasks) {
  tasks.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
    const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
    return rightTime - leftTime;
  });
}

function resequenceTaskNotes(task) {
  task.notes = [...task.notes]
    .sort((left, right) => Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0))
    .map((note, index) => ({
      ...note,
      sourceIndex: index + 1
    }));
}

function defaultTaskName() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}-采集任务`;
}

function sanitizeTaskName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function normalizeTaskName(value) {
  return sanitizeTaskName(value).toLocaleLowerCase("zh-CN");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function appendRecentError(payload) {
  const stored = await chrome.storage.local.get([RECENT_ERRORS_KEY]);
  const current = Array.isArray(stored[RECENT_ERRORS_KEY]) ? stored[RECENT_ERRORS_KEY] : [];
  const entry = {
    source: cleanText(payload?.source || "unknown"),
    context: cleanText(payload?.context || "runtime"),
    message: cleanText(payload?.message || "未知异常"),
    createdAt: new Date().toISOString()
  };
  const nextErrors = [entry, ...current].slice(0, MAX_RECENT_ERRORS);
  await chrome.storage.local.set({
    [RECENT_ERRORS_KEY]: nextErrors
  });
}

function stringifyUnknownError(error) {
  if (error instanceof Error) {
    return cleanText(error.message || error.name || "未知异常");
  }

  return cleanText(String(error || "未知异常"));
}

function styleBody(sheet, noteCount, columnCount) {
  for (let rowIndex = 2; rowIndex <= noteCount + 1; rowIndex += 1) {
    for (let colIndex = 1; colIndex <= columnCount; colIndex += 1) {
      const cell = sheet.getRow(rowIndex).getCell(colIndex);
      cell.border = {
        top: { style: "thin", color: { argb: "FFE8D8CF" } },
        left: { style: "thin", color: { argb: "FFE8D8CF" } },
        bottom: { style: "thin", color: { argb: "FFE8D8CF" } },
        right: { style: "thin", color: { argb: "FFE8D8CF" } }
      };
    }
  }
}

function writeSummarySheet(sheet, notes) {
  sheet.columns = [
    { header: "发布月份", key: "publishMonth", width: 16 },
    { header: "笔记数", key: "noteCount", width: 12 },
    { header: "总点赞", key: "likesTotal", width: 12 },
    { header: "总评论", key: "commentsTotal", width: 12 }
  ];

  styleHeaderRow(sheet.getRow(1), "FF8E5336");
  const groups = groupNotesByMonth(notes);
  const months = Object.keys(groups).sort((left, right) => left.localeCompare(right));

  for (const month of months) {
    const monthNotes = groups[month];
    sheet.addRow({
      publishMonth: month,
      noteCount: monthNotes.length,
      likesTotal: sumBy(monthNotes, "likes"),
      commentsTotal: sumBy(monthNotes, "comments")
    });
  }
}

function writeMetaSheet(sheet, task, notes, exportMode = "full") {
  sheet.columns = [
    { header: "字段", key: "field", width: 18 },
    { header: "值", key: "value", width: 80 }
  ];

  styleHeaderRow(sheet.getRow(1), "FF5B6C5D");
  const rows = [
    ["任务名称", task.name],
    ["导出时间", new Date().toLocaleString()],
    ["记录数", notes.length],
    ["任务创建时间", task.createdAt || ""],
    ["任务最近更新时间", task.updatedAt || ""],
    ["导出模式", exportMode === "fast" ? "快速导出（不带封面图）" : "高清导出（带封面图）"],
    ["去重规则", "按笔记链接优先去重，缺失时退化为账号/昵称+发布时间+标题"]
  ];

  for (const [field, value] of rows) {
    sheet.addRow({ field, value });
  }

  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    sheet.getRow(rowIndex).getCell(1).font = { bold: true };
  }
}

function styleSummarySheet(sheet) {
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    for (let colIndex = 1; colIndex <= sheet.columnCount; colIndex += 1) {
      sheet.getRow(rowIndex).getCell(colIndex).border = {
        top: { style: "thin", color: { argb: "FFE8D8CF" } },
        left: { style: "thin", color: { argb: "FFE8D8CF" } },
        bottom: { style: "thin", color: { argb: "FFE8D8CF" } },
        right: { style: "thin", color: { argb: "FFE8D8CF" } }
      };
    }
  }
}

function styleMetaSheet(sheet) {
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    for (let colIndex = 1; colIndex <= sheet.columnCount; colIndex += 1) {
      sheet.getRow(rowIndex).getCell(colIndex).border = {
        top: { style: "thin", color: { argb: "FFE8D8CF" } },
        left: { style: "thin", color: { argb: "FFE8D8CF" } },
        bottom: { style: "thin", color: { argb: "FFE8D8CF" } },
        right: { style: "thin", color: { argb: "FFE8D8CF" } }
      };
    }
  }
}

function styleHeaderRow(row, color) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: color }
  };
  row.alignment = { vertical: "middle", horizontal: "center" };
}

function groupNotesByMonth(notes) {
  const groups = {};

  for (const note of notes) {
    const month = normalizeMonthLabel(note.publishMonth || deriveMonthLabel(note.publishTime || ""));
    const key = month || "未识别月份";
    groups[key] ??= [];
    groups[key].push(note);
  }

  return groups;
}

function sumBy(items, key) {
  return items.reduce((sum, item) => sum + Number(item?.[key] || 0), 0);
}

function deriveMonthLabel(publishTime) {
  const raw = cleanText(publishTime);
  if (!raw) {
    return "";
  }

  const fullDate = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (fullDate) {
    return `${fullDate[1]}-${String(Number(fullDate[2])).padStart(2, "0")}`;
  }

  return "";
}

function normalizeMonthLabel(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : "";
}

function buildFileName(taskName, mode = "full", batchIndex, batchTotal) {
  const safeName = sanitizeTaskName(taskName) || "xhs_manual_capture";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const batchSuffix = batchIndex && batchTotal
    ? `_${String(batchIndex).padStart(Math.max(2, String(batchTotal).length), "0")}of${batchTotal}`
    : "";
  return mode === "fast"
    ? `XHS-Note-Capture-Fast/${safeName}_${timestamp}${batchSuffix}.xlsx`
    : `XHS-Note-Capture/${safeName}_${timestamp}${batchSuffix}.xlsx`;
}

function appendRemark(currentValue, nextMessage) {
  const text = typeof currentValue === "string" ? currentValue : "";
  return text ? `${text}; ${nextMessage}` : nextMessage;
}

async function downloadImageWithRetry(url, maxRetries, maxEdge) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await downloadImageAsPng(url, maxEdge);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function concurrentMap(items, fn, concurrency) {
  const results = new Array(items.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (_error) {
        // Worker failure leaves results[index] as null.
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function downloadImageAsPng(url, maxEdge) {
  const effectiveMaxEdge = maxEdge || IMAGE_MAX_EDGE;
  const normalizedUrl = normalizeImageUrl(url);
  const response = await fetch(normalizedUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const sourceBlob = await response.blob();
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new Error("当前浏览器环境不支持图片转换。");
  }

  const bitmap = await createImageBitmap(sourceBlob);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  const originalMime = String(sourceBlob.type || "").toLowerCase();
  const originalExtension = pickExcelImageExtension(originalMime);
  const scale = Math.min(1, effectiveMaxEdge / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));

  if (scale === 1 && originalExtension) {
    bitmap.close();
    return {
      buffer: await sourceBlob.arrayBuffer(),
      width: originalWidth,
      height: originalHeight,
      extension: originalExtension
    };
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    bitmap.close();
    throw new Error("无法初始化画布。");
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const outputMime = originalExtension === "png" ? "image/png" : "image/jpeg";
  const pngBlob = await canvas.convertToBlob(
    outputMime === "image/png"
      ? { type: outputMime }
      : { type: outputMime, quality: 0.92 }
  );
  return {
    buffer: await pngBlob.arrayBuffer(),
    width,
    height,
    extension: outputMime === "image/png" ? "png" : "jpeg"
  };
}

function pickExcelImageExtension(mimeType) {
  if (mimeType.includes("png")) {
    return "png";
  }

  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpeg";
  }

  return "";
}

async function notifyCaptureSettingsChanged() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://www.xiaohongshu.com/*"]
  });

  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) {
      return;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "AUTO_CAPTURE_SETTINGS_CHANGED"
      });
    } catch (_error) {
      // Ignore tabs without an active content script.
    }
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildImageTopLeft(rowNumber, imageWidth, imageHeight) {
  const fitted = fitImageWithinBox(imageWidth, imageHeight);
  const cellWidthPx = excelColumnWidthToPixels(IMAGE_CELL.columnWidth);
  const cellHeightPx = pointsToPixels(IMAGE_CELL.rowHeightPt);
  const x = IMAGE_CELL.offsetX + Math.max(0, (IMAGE_CELL.maxWidthPx - fitted.width) / 2);
  const y = IMAGE_CELL.offsetY + Math.max(0, (IMAGE_CELL.maxHeightPx - fitted.height) / 2);

  return {
    col: x / cellWidthPx,
    row: (rowNumber - 1) + (y / cellHeightPx)
  };
}

function buildImageExt(imageWidth, imageHeight) {
  const fitted = fitImageWithinBox(imageWidth, imageHeight);
  return {
    width: fitted.width,
    height: fitted.height
  };
}

function fitImageWithinBox(imageWidth, imageHeight) {
  if (!imageWidth || !imageHeight) {
    return {
      width: IMAGE_CELL.maxWidthPx,
      height: IMAGE_CELL.maxHeightPx
    };
  }

  const scale = Math.min(
    IMAGE_CELL.maxWidthPx / imageWidth,
    IMAGE_CELL.maxHeightPx / imageHeight,
    1
  );

  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale))
  };
}

function excelColumnWidthToPixels(width) {
  return Math.floor(((256 * width + Math.floor(128 / 7)) / 256) * 7);
}

function pointsToPixels(points) {
  return Math.round(points * (96 / 72));
}

function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  const base64 = btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}
