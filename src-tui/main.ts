import { createCliRenderer, TextRenderable } from "@opentui/core";
import { Terminal } from "@xterm/headless";
import { BackendClient, type BackendEvent } from "./backend/client.js";
import { TaskStore } from "./state/taskStore.js";

const backend = new BackendClient();
const store = new TaskStore(backend);
const terminals = new Map<string, Terminal>();

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  clearOnShutdown: true,
  useMouse: false,
  consoleMode: "disabled",
});

const screen = new TextRenderable(renderer, {
  id: "nezha-tui-screen",
  content: "Starting Nezha TUI...",
  width: "100%",
  height: "100%",
});
renderer.root.add(screen);

function terminalSize() {
  const width = Math.max(60, renderer.terminalWidth || process.stdout.columns || 120);
  const height = Math.max(18, renderer.terminalHeight || process.stdout.rows || 40);
  return {
    width,
    height,
    terminalCols: Math.max(20, width - 34),
    terminalRows: Math.max(8, height - 13),
  };
}

function getTerminal(taskId: string): Terminal {
  const size = terminalSize();
  let terminal = terminals.get(taskId);
  if (!terminal) {
    terminal = new Terminal({
      cols: size.terminalCols,
      rows: size.terminalRows,
      scrollback: 2000,
      allowProposedApi: true,
    });
    terminals.set(taskId, terminal);
  } else if (terminal.cols !== size.terminalCols || terminal.rows !== size.terminalRows) {
    terminal.resize(size.terminalCols, size.terminalRows);
  }
  return terminal;
}

function terminalLines(taskId: string | null, rows: number): string[] {
  if (!taskId) return ["No task selected."];
  const terminal = terminals.get(taskId);
  if (!terminal) return ["No terminal output yet."];
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.baseY);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const line = buffer.getLine(start + row)?.translateToString(true) ?? "";
    lines.push(line);
  }
  return lines;
}

function pad(line: string, width: number): string {
  const clipped = line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;
  return clipped.padEnd(width, " ");
}

function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    while (line.length > width) {
      rows.push(line.slice(0, width));
      line = line.slice(width);
    }
    rows.push(line);
  }
  return rows;
}

function renderMain(right: string[], rightWidth: number, activeTaskId: string | null): void {
  const task = store.activeTask;
  if (store.focus === "session") {
    right.push("Transcript ◀");
    right.push("─".repeat(rightWidth));
    right.push(`Metrics: ${JSON.stringify(store.sessionMetrics ?? {})}`);
    for (const block of store.sessionBlocks) {
      right.push(`\n[${block.role} · ${block.kind}]`);
      right.push(...wrap(block.text, rightWidth).slice(0, 12));
    }
    return;
  }

  if (store.focus === "gitChanges") {
    right.push("Git Changes ◀ · o diff · s stage · u unstage");
    right.push("─".repeat(rightWidth));
    store.gitChanges.forEach((item: any, index) => {
      const marker = index === store.selectedGitIndex ? "›" : " ";
      right.push(`${marker} ${item.staged ?? " "}${item.unstaged ?? " "} ${item.path ?? JSON.stringify(item)}`);
    });
    return;
  }

  if (store.focus === "gitHistory") {
    right.push("Git History ◀");
    right.push("─".repeat(rightWidth));
    store.gitHistory.forEach((item: any) => {
      right.push(`${item.shortHash ?? ""} ${item.date ?? ""} ${item.subject ?? JSON.stringify(item)}`);
    });
    return;
  }

  if (store.focus === "diff") {
    right.push("Diff ◀");
    right.push("─".repeat(rightWidth));
    right.push(...wrap(store.diffText || "No diff loaded.", rightWidth));
    return;
  }

  if (store.focus === "files") {
    right.push("Files ◀ · Enter open · f refresh");
    right.push(`Dir: ${store.currentDirectory ?? ""}`);
    right.push("─".repeat(rightWidth));
    store.fileEntries.forEach((entry, index) => {
      const marker = index === store.selectedFileIndex ? "›" : " ";
      right.push(`${marker} ${entry.is_dir ? "▸" : " "} ${entry.name}`);
    });
    if (store.fileContent) {
      right.push("─".repeat(rightWidth));
      right.push(...wrap(store.fileContent, rightWidth).slice(0, 30));
    }
    return;
  }

  right.push(`Composer ${store.focus === "composer" ? "◀" : ""}`);
  right.push(`Agent: ${store.agent} · Permission: ${store.permissionMode} · Launch: ${store.launchMode}`);
  right.push(`Base: ${store.baseBranch || "current"}`);
  right.push(`Prompt: ${store.promptDraft || "(press n, type prompt, Enter to run)"}`);
  right.push("─".repeat(rightWidth));
  right.push(`Terminal ${store.focus === "terminal" ? "◀" : ""}`);
  right.push(...terminalLines(activeTaskId, terminalSize().terminalRows).slice(-terminalSize().terminalRows));
  if (task?.worktreePath) {
    right.push("─".repeat(rightWidth));
    right.push(`Worktree: ${task.worktreeBranch} @ ${task.worktreePath}`);
    right.push(`Stats: +${task.additions ?? 0} -${task.deletions ?? 0} ${task.worktreeDiscarded ? "(closed)" : ""}`);
  }
}

function render(): void {
  const size = terminalSize();
  const leftWidth = 30;
  const rightWidth = Math.max(20, size.width - leftWidth - 3);
  const activeProject = store.activeProject;
  const activeTask = store.activeTask;
  const left: string[] = [];
  const right: string[] = [];

  left.push(`Projects ${store.focus === "projects" ? "◀" : ""}`);
  left.push("─".repeat(leftWidth));
  for (const project of store.projects.slice(0, Math.max(3, Math.floor(size.height / 3)))) {
    const marker = project.id === store.activeProjectId ? "›" : " ";
    left.push(`${marker} ${project.name}`);
  }
  left.push("");
  left.push(`Tasks ${store.focus === "tasks" ? "◀" : ""}`);
  left.push("─".repeat(leftWidth));
  for (const task of store.tasks.slice(0, Math.max(5, size.height - left.length - 8))) {
    const marker = task.id === store.activeTaskId ? "›" : " ";
    const worktree = task.worktreePath ? "⑂" : " ";
    const status = task.status.padEnd(14, " ");
    left.push(`${marker}${worktree} ${status} ${task.name ?? task.prompt.slice(0, 9)}`);
  }

  right.push("Nezha OpenTUI");
  right.push(`Backend: ${store.backendStatus}${store.lastError ? ` · ${store.lastError}` : ""}`);
  right.push(`Project: ${activeProject?.name ?? "none"}`);
  right.push(`Task: ${activeTask ? `${activeTask.status} · ${activeTask.prompt.slice(0, 80)}` : "none"}`);
  const sessionPath = activeTask?.agent === "codex" ? activeTask.codexSessionPath : activeTask?.claudeSessionPath;
  if (sessionPath) right.push(`Session: ${sessionPath}`);
  right.push("═".repeat(rightWidth));
  renderMain(right, rightWidth, activeTask?.id ?? null);

  const maxRows = Math.max(left.length, right.length, size.height - 2);
  const lines = [
    "Nezha TUI · Tab focus · ↑/↓ select · n new · Enter/open · t terminal · x transcript · g git · h history · f files · w worktree · m merge · D discard · q quit",
    "═".repeat(size.width),
  ];
  for (let i = 0; i < maxRows && lines.length < size.height; i += 1) {
    lines.push(`${pad(left[i] ?? "", leftWidth)} │ ${pad(right[i] ?? "", rightWidth)}`);
  }
  screen.content = lines.slice(0, size.height).join("\n");
  renderer.requestRender();
}

backend.addEventListener("backend-event", (event) => {
  const detail = (event as CustomEvent<BackendEvent>).detail;
  if (detail.event === "task-output") {
    const terminal = getTerminal(detail.payload.task_id);
    terminal.write(detail.payload.data, render);
  }
});

store.subscribe(render);

renderer.on("resize", () => {
  const task = store.activeTask;
  const size = terminalSize();
  if (task) {
    getTerminal(task.id);
    void store.resizeTerminal(size.terminalCols, size.terminalRows);
  }
  render();
});

renderer.keyInput.on("keypress", (key) => {
  void handleKey(key as any);
});

async function handleKey(key: { name: string; sequence: string; ctrl?: boolean }): Promise<void> {
  const size = terminalSize();

  if (key.name === "q" && store.focus !== "terminal") {
    backend.shutdown();
    renderer.destroy();
    process.exit(0);
  }

  if (key.name === "tab") {
    store.cycleFocus();
    return;
  }

  if (store.focus === "terminal") {
    if (key.name === "escape") {
      store.focus = "tasks";
      render();
      return;
    }
    await store.sendInput(key.sequence);
    return;
  }

  if (store.focus === "composer") {
    if (key.name === "escape") {
      store.focus = "tasks";
      render();
      return;
    }
    if (key.name === "return") {
      await store.createAndRunTask(size.terminalCols, size.terminalRows);
      return;
    }
    if (key.name === "backspace") {
      store.promptDraft = store.promptDraft.slice(0, -1);
      render();
      return;
    }
    if (key.sequence && key.sequence >= " " && !key.ctrl) {
      store.promptDraft += key.sequence;
      render();
    }
    return;
  }

  if (key.name === "return" && store.focus === "files") {
    await store.openSelectedFile();
    return;
  }
  if (key.name === "return" && store.focus === "gitChanges") {
    await store.openSelectedGitDiff();
    return;
  }

  if (key.name === "n") {
    store.focus = "composer";
    render();
    return;
  }
  if (key.name === "w") {
    store.cycleLaunchMode();
    return;
  }
  if (key.name === "t") {
    store.focus = "terminal";
    render();
    return;
  }
  if (key.name === "x") {
    await store.loadSession();
    return;
  }
  if (key.name === "g") {
    await store.refreshGit();
    return;
  }
  if (key.name === "h") {
    await store.refreshHistory();
    return;
  }
  if (key.name === "f") {
    await store.openFiles();
    return;
  }
  if (key.name === "o") {
    await store.openSelectedGitDiff();
    return;
  }
  if (key.name === "s") {
    await store.stageSelectedGitFile();
    return;
  }
  if (key.name === "u") {
    await store.unstageSelectedGitFile();
    return;
  }
  if (key.name === "m") {
    await store.mergeActiveWorktree();
    return;
  }
  if (key.name === "D") {
    await store.discardActiveWorktree();
    return;
  }
  if (key.name === "r") {
    await store.resumeActiveTask(size.terminalCols, size.terminalRows);
    return;
  }
  if (key.name === "c") {
    await store.cancelActiveTask();
    return;
  }
  if (key.name === "d") {
    await store.completeActiveTask();
    return;
  }
  if (key.name === "up") {
    store.moveInActivePane(-1);
    return;
  }
  if (key.name === "down") {
    store.moveInActivePane(1);
  }
}

await store.load();
render();
