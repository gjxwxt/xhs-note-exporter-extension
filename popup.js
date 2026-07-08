const taskSelect = document.getElementById("taskSelect");
const newTaskButton = document.getElementById("newTaskButton");
const createTaskPanel = document.getElementById("createTaskPanel");
const taskNameInput = document.getElementById("taskNameInput");
const confirmCreateButton = document.getElementById("confirmCreateButton");
const cancelCreateButton = document.getElementById("cancelCreateButton");
const captureButton = document.getElementById("captureButton");
const exportButton = document.getElementById("exportButton");
const quickExportButton = document.getElementById("quickExportButton");
const clearButton = document.getElementById("clearButton");
const deleteTaskButton = document.getElementById("deleteTaskButton");
const autoCaptureButton = document.getElementById("autoCaptureButton");
const autoCaptureMetaEl = document.getElementById("autoCaptureMeta");
const noteCountEl = document.getElementById("noteCount");
const sessionCountEl = document.getElementById("sessionCount");
const updatedAtEl = document.getElementById("updatedAt");
const taskMetaEl = document.getElementById("taskMeta");
const lastTitleEl = document.getElementById("lastTitle");
const lastInfoEl = document.getElementById("lastInfo");
const capturedListEl = document.getElementById("capturedList");
const batchExportCheckbox = document.getElementById("batchExportCheckbox");
const batchSizeInput = document.getElementById("batchSizeInput");
const imageQualitySelect = document.getElementById("imageQualitySelect");
const statusEl = document.getElementById("status");
const runtimeIssueEl = document.getElementById("runtimeIssue");
const errorPanel = document.getElementById("errorPanel");
const errorListEl = document.getElementById("errorList");
const errorPanelClose = document.getElementById("errorPanelClose");

let captureState = {
  tasks: [],
  activeTaskId: "",
  activeTask: null,
  autoCaptureEnabled: false,
  latestError: null
};
const confirmModal = document.getElementById("confirmModal");
const confirmMessage = document.getElementById("confirmMessage");
const confirmOk = document.getElementById("confirmOk");
const confirmCancel = document.getElementById("confirmCancel");
let pendingConfirmAction = null;

let pendingActionAfterCreate = "";

function setStatus(message) {
  statusEl.textContent = message;
}

function showConfirmDialog(message, onConfirm) {
  confirmMessage.textContent = message;
  pendingConfirmAction = onConfirm;
  confirmModal.hidden = false;
  confirmOk.focus();
}

function hideConfirmDialog() {
  confirmModal.hidden = true;
  pendingConfirmAction = null;
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function defaultTaskName() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}-采集任务`;
}

function showCreatePanel(afterCreate = "") {
  pendingActionAfterCreate = afterCreate;
  createTaskPanel.hidden = false;
  taskNameInput.value = taskNameInput.value || defaultTaskName();
  taskNameInput.focus();
  taskNameInput.select();
}

function hideCreatePanel() {
  pendingActionAfterCreate = "";
  createTaskPanel.hidden = true;
  taskNameInput.value = "";
}

function renderTaskOptions() {
  const currentValue = captureState.activeTaskId || "";
  taskSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = captureState.tasks.length
    ? "请选择采集任务"
    : "还没有采集任务";
  taskSelect.appendChild(placeholder);

  for (const task of captureState.tasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${task.name} (${task.noteCount})`;
    taskSelect.appendChild(option);
  }

  taskSelect.value = currentValue;
}

function renderCapturedList(activeTask) {
  const notes = Array.isArray(activeTask?.notes) ? activeTask.notes : [];
  capturedListEl.innerHTML = "";

  if (!notes.length) {
    capturedListEl.classList.add("empty");
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "当前任务还没有采集记录。";
    capturedListEl.appendChild(empty);
    return;
  }

  capturedListEl.classList.remove("empty");

  for (const note of notes) {
    const item = document.createElement("article");
    item.className = "captured-item";

    const main = document.createElement("div");
    main.className = "captured-main";

    const title = document.createElement("p");
    title.className = "captured-title";
    title.textContent = `${note.sourceIndex || "-"}．${note.title || "未命名帖子"}`;

    const meta = document.createElement("p");
    meta.className = "captured-meta";
    meta.textContent = [
      note.publishTime ? `发布时间：${note.publishTime}` : "",
      note.status ? `状态：${note.status}` : ""
    ].filter(Boolean).join("；") || "暂无附加信息";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "delete-note-button";
    button.dataset.noteKey = note.noteKey || "";
    button.textContent = "删除";

    main.append(title, meta);
    item.append(main, button);
    capturedListEl.appendChild(item);
  }
}

function renderRuntimeIssue(latestError, recentErrors) {
  if (!latestError?.message) {
    runtimeIssueEl.hidden = true;
    runtimeIssueEl.textContent = "";
    return;
  }

  const createdAt = formatDateTime(latestError.createdAt);
  const errorCount = Array.isArray(recentErrors) ? recentErrors.length : 0;
  runtimeIssueEl.hidden = false;
  runtimeIssueEl.innerHTML = `最近异常：${latestError.message}${createdAt !== "-" ? `（${createdAt}）` : ""}`;
  if (errorCount > 1) {
    const link = document.createElement("a");
    link.href = "#";
    link.className = "error-detail-link";
    link.textContent = `查看全部 ${errorCount} 条异常`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      renderErrorList(recentErrors);
      errorPanel.hidden = false;
    });
    runtimeIssueEl.appendChild(document.createTextNode(" "));
    runtimeIssueEl.appendChild(link);
  }
}

function renderErrorList(errors) {
  const list = Array.isArray(errors) ? errors : [];
  errorListEl.innerHTML = "";

  if (!list.length) {
    errorListEl.textContent = "暂无异常记录。";
    return;
  }

  for (const entry of list) {
    const item = document.createElement("div");
    item.className = "error-item";

    const header = document.createElement("div");
    header.className = "error-item-header";

    const source = document.createElement("span");
    source.className = "error-source";
    source.textContent = entry.source || "unknown";

    const time = document.createElement("span");
    time.className = "error-time";
    time.textContent = formatDateTime(entry.createdAt);

    header.append(source, time);
    item.appendChild(header);

    const message = document.createElement("p");
    message.className = "error-message";
    message.textContent = entry.message || "未知异常";

    item.appendChild(message);

    if (entry.url) {
      const url = document.createElement("p");
      url.className = "error-url";
      url.textContent = entry.url;
      item.appendChild(url);
    }

    errorListEl.appendChild(item);
  }
}

function renderState(state) {
  captureState = state || captureState;
  renderTaskOptions();

  const activeTask = captureState.activeTask;
  const hasActiveTask = Boolean(activeTask);
  const hasNotes = Boolean(activeTask?.noteCount);
  const autoCaptureEnabled = Boolean(captureState.autoCaptureEnabled);

  noteCountEl.textContent = String(activeTask?.noteCount || 0);
  sessionCountEl.textContent = String(captureState.sessionCaptureCount || 0);
  updatedAtEl.textContent = formatDateTime(activeTask?.updatedAt);
  exportButton.disabled = !hasNotes;
  quickExportButton.disabled = !hasNotes;
  clearButton.disabled = !hasNotes;
  deleteTaskButton.disabled = !hasActiveTask;
  autoCaptureButton.textContent = autoCaptureEnabled ? "关闭自动采集" : "开启自动采集";
  renderCapturedList(activeTask);
  renderRuntimeIssue(captureState.latestError, captureState.recentErrors);

  if (!hasActiveTask) {
    taskMetaEl.textContent = captureState.tasks.length
      ? "还没有选中任务。选择现有任务，或新建一个任务。"
      : "还没有采集任务。点击“新建任务”后开始采集。";
    autoCaptureMetaEl.textContent = autoCaptureEnabled
      ? "已开启，但当前没有采集任务。请先选择任务。"
      : "关闭中。开启后会监听帖子详情页路由变化，未采集过的帖子会自动入库。";
    lastTitleEl.textContent = "还没有采集记录。";
    lastInfoEl.textContent = "打开帖子详情页后，点击“采集当前帖子”即可。";
    return;
  }

  const createdAt = formatDateTime(activeTask.createdAt);
  const updatedAt = formatDateTime(activeTask.updatedAt);
  taskMetaEl.textContent = `当前任务：${activeTask.name}；创建于 ${createdAt}；最近更新 ${updatedAt}。`;
  autoCaptureMetaEl.textContent = autoCaptureEnabled
    ? `已开启。当前会自动写入任务“${activeTask.name}”，打开新帖子后会自动采集并去重。`
    : `关闭中。开启后会自动写入任务“${activeTask.name}”，你只需要正常打开帖子。`;

  if (!hasNotes || !activeTask.lastNote) {
    lastTitleEl.textContent = "还没有采集记录。";
    lastInfoEl.textContent = "打开帖子详情页后，点击“采集当前帖子”即可。";
    return;
  }

  const lastNote = activeTask.lastNote;
  lastTitleEl.textContent = `${lastNote.sourceIndex || "-"}．${lastNote.title || "未命名帖子"}`;
  lastInfoEl.textContent = [
    `发布时间：${lastNote.publishTime || "-"}`,
    `点赞：${lastNote.likes ?? "-"}`,
    `评论：${lastNote.comments ?? "-"}`,
    `状态：${lastNote.status || "-"}`
  ].join("；");
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "请求失败");
  }
  return response;
}

async function reportExtensionError(payload) {
  try {
    await chrome.runtime.sendMessage({
      type: "REPORT_EXTENSION_ERROR",
      payload
    });
  } catch (_error) {
    // Ignore secondary reporting failures.
  }
}

async function refreshState() {
  const response = await sendMessage({ type: "GET_CAPTURE_STATE" });
  renderState(response.state);
}

async function createTask(name) {
  const response = await sendMessage({
    type: "CREATE_CAPTURE_TASK",
    name
  });
  renderState(response.state);
  return response;
}

async function handleCreateConfirm() {
  const name = taskNameInput.value.trim();
  if (!name) {
    setStatus("请输入任务名称。");
    taskNameInput.focus();
    return;
  }

  confirmCreateButton.disabled = true;
  setStatus("正在创建采集任务...");

  try {
    const nextAction = pendingActionAfterCreate;
    await createTask(name);
    hideCreatePanel();
    setStatus(`已创建任务：${name}`);

    if (nextAction === "capture") {
      await handleCapture();
    } else if (nextAction === "enableAuto") {
      await handleAutoCaptureToggle();
    }
  } catch (error) {
    setStatus(`创建失败：${error.message}`);
  } finally {
    confirmCreateButton.disabled = false;
  }
}

async function handleTaskSelect() {
  const taskId = taskSelect.value;
  try {
    const response = await sendMessage({
      type: "SELECT_CAPTURE_TASK",
      taskId
    });
    renderState(response.state);
    setStatus(taskId ? "已切换采集任务。" : "已取消当前任务选择。");
  } catch (error) {
    setStatus(`切换失败：${error.message}`);
  }
}

async function handleCapture() {
  if (!captureState.activeTaskId) {
    showCreatePanel("capture");
    setStatus("请先新建采集任务。");
    return;
  }

  captureButton.disabled = true;
  setStatus("正在读取当前帖子详情...");

  try {
    const response = await sendMessage({ type: "CAPTURE_CURRENT_NOTE" });
    renderState(response.state);

    if (response.capture.mode === "updated") {
      setStatus(`已更新第 ${response.capture.note.sourceIndex} 条：${response.capture.note.title || "未命名帖子"}`);
    } else {
      setStatus(`已采集第 ${response.capture.note.sourceIndex} 条：${response.capture.note.title || "未命名帖子"}`);
    }
  } catch (error) {
    setStatus(`采集失败：${error.message}`);
  } finally {
    captureButton.disabled = false;
  }
}

async function handleAutoCaptureToggle() {
  const nextEnabled = !captureState.autoCaptureEnabled;
  if (nextEnabled && !captureState.activeTaskId) {
    showCreatePanel("enableAuto");
    setStatus("请先新建或选择采集任务，再开启自动采集。");
    return;
  }

  autoCaptureButton.disabled = true;
  setStatus(nextEnabled ? "正在开启自动采集..." : "正在关闭自动采集...");

  try {
    const response = await sendMessage({
      type: "SET_AUTO_CAPTURE_ENABLED",
      enabled: nextEnabled
    });
    renderState(response.state);
    setStatus(nextEnabled ? "自动采集已开启。" : "自动采集已关闭。");
  } catch (error) {
    setStatus(`切换失败：${error.message}`);
  } finally {
    autoCaptureButton.disabled = false;
  }
}

async function handleExport(mode = "full") {
  exportButton.disabled = true;
  quickExportButton.disabled = true;
  const isBatch = batchExportCheckbox.checked;
  const batchSize = isBatch ? Math.max(1, Number(batchSizeInput.value || 50)) : 0;

  try {
    if (isBatch) {
      setStatus(`正在分批导出（每批 ${batchSize} 条）...`);
    } else {
      setStatus(mode === "fast" ? "正在生成快速 Excel..." : "正在生成 Excel...");
    }

    const response = await sendMessage({
      type: "EXPORT_CAPTURE_TASK",
      mode,
      batchSize,
      imageQuality: imageQualitySelect.value
    });

    renderState(response.state);
    const batchInfo = response.batchCount > 1 ? `（共 ${response.batchCount} 批）` : "";
    setStatus(`${mode === "fast" ? "快速" : "高清"} Excel 已开始下载${batchInfo}：${response.filename}`);
  } catch (error) {
    setStatus(`导出失败：${error.message}`);
  } finally {
    exportButton.disabled = false;
    quickExportButton.disabled = false;
  }
}

async function handleClear() {
  if (!captureState.activeTaskId || !captureState.activeTask?.noteCount) {
    return;
  }

  const taskName = captureState.activeTask?.name || "当前任务";
  showConfirmDialog(
    `确定要清空“${taskName}”中的所有采集记录吗？此操作不可撤销。`,
    async () => {
      clearButton.disabled = true;
      setStatus("正在清空当前任务...");

      try {
        const response = await sendMessage({ type: "CLEAR_CAPTURE_TASK" });
        renderState(response.state);
        setStatus("当前任务已清空。");
      } catch (error) {
        setStatus(`清空失败：${error.message}`);
      } finally {
        clearButton.disabled = false;
      }
    }
  );
}

async function handleDeleteTask() {
  if (!captureState.activeTaskId) {
    return;
  }

  const taskName = captureState.activeTask?.name || "当前任务";
  const noteCount = captureState.activeTask?.noteCount || 0;
  showConfirmDialog(
    `确定要删除任务“${taskName}”吗？该任务包含 ${noteCount} 条采集记录，删除后不可恢复。`,
    async () => {
      deleteTaskButton.disabled = true;
      setStatus("正在删除当前任务...");

      try {
        const response = await sendMessage({
          type: "DELETE_CAPTURE_TASK",
          taskId: captureState.activeTaskId
        });
        renderState(response.state);
        setStatus("当前任务已删除。");
      } catch (error) {
        setStatus(`删除任务失败：${error.message}`);
      } finally {
        deleteTaskButton.disabled = false;
      }
    }
  );
}

async function handleDeleteNote(event) {
  const button = event.target instanceof Element
    ? event.target.closest(".delete-note-button")
    : null;
  if (!button) {
    return;
  }

  const noteKey = button.dataset.noteKey || "";
  if (!noteKey || !captureState.activeTaskId) {
    return;
  }

  button.disabled = true;
  setStatus("正在删除采集记录...");

  try {
    const response = await sendMessage({
      type: "DELETE_CAPTURE_NOTE",
      taskId: captureState.activeTaskId,
      noteKey
    });
    renderState(response.state);
    setStatus("已删除该采集记录。");
  } catch (error) {
    setStatus(`删除失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

taskSelect.addEventListener("change", handleTaskSelect);
newTaskButton.addEventListener("click", () => showCreatePanel());
confirmCreateButton.addEventListener("click", handleCreateConfirm);
cancelCreateButton.addEventListener("click", () => {
  hideCreatePanel();
  setStatus("已取消新建任务。");
});
captureButton.addEventListener("click", handleCapture);
exportButton.addEventListener("click", () => {
  void handleExport("full");
});
quickExportButton.addEventListener("click", () => {
  void handleExport("fast");
});
clearButton.addEventListener("click", handleClear);
deleteTaskButton.addEventListener("click", handleDeleteTask);
autoCaptureButton.addEventListener("click", handleAutoCaptureToggle);
capturedListEl.addEventListener("click", (event) => {
  void handleDeleteNote(event);
});

sessionCountEl.addEventListener("dblclick", async () => {
  try {
    await sendMessage({ type: "RESET_SESSION_COUNT" });
    captureState.sessionCaptureCount = 0;
    sessionCountEl.textContent = "0";
    setStatus("本次新增计数已重置。");
  } catch (error) {
    setStatus(`重置计数失败：${error.message}`);
  }
});

confirmOk.addEventListener("click", () => {
  const action = pendingConfirmAction;
  hideConfirmDialog();
  if (typeof action === "function") {
    void action();
  }
});

confirmCancel.addEventListener("click", () => {
  hideConfirmDialog();
  setStatus("已取消操作。");
});

errorPanelClose.addEventListener("click", () => {
  errorPanel.hidden = true;
});

confirmModal.addEventListener("click", (event) => {
  if (event.target === confirmModal) {
    hideConfirmDialog();
    setStatus("已取消操作。");
  }
});

runtimeIssueEl.addEventListener("click", (event) => {
  const link = event.target.closest(".error-detail-link");
  if (link) return;
  const errors = captureState.recentErrors || [];
  if (errors.length > 0) {
    renderErrorList(errors);
    errorPanel.hidden = false;
  }
});

void refreshState().then(() => {
  setStatus("先选择采集任务。开启自动采集后，打开新帖子会自动入库。");
}).catch((error) => {
  setStatus(`初始化失败：${error.message}`);
  void reportExtensionError({
    source: "popup",
    context: "init",
    message: String(error?.message || error || "初始化失败")
  });
});

window.addEventListener("error", (event) => {
  const message = String(event?.message || "弹窗脚本发生未知错误");
  setStatus(`异常：${message}`);
  void reportExtensionError({
    source: "popup",
    context: "global",
    message
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  const message = reason instanceof Error
    ? String(reason.message || reason.name || "Promise 异常")
    : String(reason || "Promise 异常");
  setStatus(`异常：${message}`);
  void reportExtensionError({
    source: "popup",
    context: "promise",
    message
  });
});
