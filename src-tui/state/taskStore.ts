import { randomUUID } from "node:crypto";
import type { AgentType, PermissionMode, Project, Task, TaskStatus } from "../../src/types.js";
import { isActiveTaskStatus } from "../../src/types.js";
import type { BackendClient, BackendEvent, SessionBlock } from "../backend/client.js";

export type FocusPane =
  | "projects"
  | "tasks"
  | "composer"
  | "terminal"
  | "session"
  | "files"
  | "gitChanges"
  | "gitHistory"
  | "diff";

export type LaunchMode = "local" | "worktree";

type Listener = () => void;

type DirEntry = { name: string; path: string; is_dir: boolean; extension?: string };

type BranchInfo = { name: string; current: boolean; upstream?: string };

export class TaskStore {
  projects: Project[] = [];
  tasks: Task[] = [];
  activeProjectId: string | null = null;
  activeTaskId: string | null = null;
  focus: FocusPane = "projects";
  promptDraft = "";
  agent: AgentType = "claude";
  permissionMode: PermissionMode = "ask";
  launchMode: LaunchMode = "local";
  baseBranch = "";
  branches: BranchInfo[] = [];
  terminalBuffers = new Map<string, string>();
  backendStatus = "starting";
  lastError: string | null = null;
  sessionBlocks: SessionBlock[] = [];
  sessionMetrics: unknown = null;
  gitChanges: unknown[] = [];
  gitHistory: unknown[] = [];
  selectedGitIndex = 0;
  diffText = "";
  fileEntries: DirEntry[] = [];
  selectedFileIndex = 0;
  fileContent = "";
  currentDirectory: string | null = null;

  private listeners = new Set<Listener>();

  constructor(private backend: BackendClient) {
    backend.addEventListener("backend-event", (event) => {
      this.applyBackendEvent((event as CustomEvent<BackendEvent>).detail);
    });
    backend.addEventListener("backend-stderr", (event) => {
      this.backendStatus = String((event as CustomEvent<string>).detail).trim() || this.backendStatus;
      this.emit();
    });
    backend.addEventListener("backend-exit", () => {
      this.backendStatus = "backend exited";
      this.emit();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get activeProject(): Project | undefined {
    return this.projects.find((project) => project.id === this.activeProjectId);
  }

  get activeTask(): Task | undefined {
    return this.tasks.find((task) => task.id === this.activeTaskId);
  }

  get activeTaskRoot(): string | undefined {
    const task = this.activeTask;
    return task?.worktreePath || this.activeProject?.path;
  }

  get visibleTerminalText(): string {
    const task = this.activeTask;
    if (!task) return "";
    return this.terminalBuffers.get(task.id) ?? "";
  }

  async load(): Promise<void> {
    try {
      this.projects = await this.backend.loadProjects();
      this.activeProjectId = this.projects[0]?.id ?? null;
      await this.loadTasksForActiveProject();
      await this.refreshBranches();
      this.backendStatus = "ready";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.backendStatus = "load failed";
    }
    this.emit();
  }

  async loadTasksForActiveProject(): Promise<void> {
    if (!this.activeProjectId) {
      this.tasks = [];
      this.activeTaskId = null;
      return;
    }
    this.tasks = await this.backend.loadProjectTasks(this.activeProjectId);
    this.activeTaskId = this.tasks[0]?.id ?? null;
  }

  async selectProject(delta: number): Promise<void> {
    if (this.projects.length === 0) return;
    const current = Math.max(0, this.projects.findIndex((project) => project.id === this.activeProjectId));
    const next = (current + delta + this.projects.length) % this.projects.length;
    this.activeProjectId = this.projects[next].id;
    await this.loadTasksForActiveProject();
    await this.refreshBranches();
    this.emit();
  }

  selectTask(delta: number): void {
    if (this.tasks.length === 0) return;
    const current = Math.max(0, this.tasks.findIndex((task) => task.id === this.activeTaskId));
    const next = (current + delta + this.tasks.length) % this.tasks.length;
    this.activeTaskId = this.tasks[next].id;
    this.emit();
  }

  async createAndRunTask(cols: number, rows: number): Promise<void> {
    const project = this.activeProject;
    const prompt = this.promptDraft.trim();
    if (!project || !prompt) return;

    const task: Task = {
      id: randomUUID(),
      projectId: project.id,
      prompt,
      agent: this.agent,
      permissionMode: this.permissionMode,
      status: "pending",
      createdAt: Date.now(),
      baseBranch: this.baseBranch || undefined,
    };

    try {
      if (this.launchMode === "worktree") {
        const worktree = await this.backend.createTaskWorktree(project.path, task.id, this.baseBranch || undefined);
        task.worktreePath = worktree.worktreePath;
        task.worktreeBranch = worktree.worktreeBranch;
        task.baseBranch = worktree.baseBranch;
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit();
      return;
    }

    this.tasks = [task, ...this.tasks];
    this.activeTaskId = task.id;
    this.promptDraft = "";
    this.focus = "terminal";
    this.terminalBuffers.set(task.id, "");
    await this.persistTasks();
    this.emit();

    try {
      await this.backend.runTask({
        task_id: task.id,
        project_path: task.worktreePath || project.path,
        prompt: task.prompt,
        agent: task.agent,
        permission_mode: task.permissionMode,
        cols,
        rows,
      });
    } catch (error) {
      this.updateTask(task.id, {
        status: "failed",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      await this.persistTasks();
    }
  }

  async resumeActiveTask(cols: number, rows: number): Promise<void> {
    const project = this.activeProject;
    const task = this.activeTask;
    if (!project || !task) return;
    const sessionId = task.agent === "codex" ? task.codexSessionId : task.claudeSessionId;
    if (!sessionId) return;
    this.focus = "terminal";
    this.updateTask(task.id, { status: "pending" });
    await this.persistTasks();
    await this.backend.resumeTask({
      task_id: task.id,
      project_path: task.worktreePath || project.path,
      agent: task.agent,
      session_id: sessionId,
      permission_mode: task.permissionMode,
      cols,
      rows,
    });
  }

  async cancelActiveTask(): Promise<void> {
    const project = this.activeProject;
    const task = this.activeTask;
    if (!project || !task) return;
    await this.backend.cancelTask(task.id, task.worktreePath || project.path);
  }

  async completeActiveTask(): Promise<void> {
    const project = this.activeProject;
    const task = this.activeTask;
    if (!project || !task) return;
    await this.backend.completeTask(task.id, task.worktreePath || project.path);
  }

  async mergeActiveWorktree(): Promise<void> {
    const project = this.activeProject;
    const task = this.activeTask;
    if (!project || !task?.worktreePath || !task.worktreeBranch) return;
    await this.backend.mergeTaskWorktree(project.path, task.worktreePath, task.worktreeBranch);
    this.updateTask(task.id, { worktreeDiscarded: true });
    await this.persistTasks();
  }

  async discardActiveWorktree(): Promise<void> {
    const project = this.activeProject;
    const task = this.activeTask;
    if (!project || !task?.worktreePath) return;
    await this.backend.removeTaskWorktree(project.path, task.worktreePath, task.worktreeBranch);
    this.updateTask(task.id, { worktreeDiscarded: true });
    await this.persistTasks();
  }

  async sendInput(data: string): Promise<void> {
    const task = this.activeTask;
    if (!task || !isActiveTaskStatus(task.status)) return;
    await this.backend.sendInput(task.id, data);
  }

  async resizeTerminal(cols: number, rows: number): Promise<void> {
    const task = this.activeTask;
    if (!task || !isActiveTaskStatus(task.status)) return;
    await this.backend.resizePty(task.id, cols, rows);
  }

  async loadSession(): Promise<void> {
    const task = this.activeTask;
    const sessionPath = task?.agent === "codex" ? task.codexSessionPath : task?.claudeSessionPath;
    if (!sessionPath) return;
    this.sessionBlocks = await this.backend.readSessionMessages(sessionPath);
    this.sessionMetrics = await this.backend.readSessionMetrics(sessionPath).catch(() => null);
    this.focus = "session";
    this.emit();
  }

  async refreshGit(): Promise<void> {
    const root = this.activeTaskRoot;
    if (!root) return;
    this.gitChanges = await this.backend.gitStatus(root);
    this.focus = "gitChanges";
    this.emit();
  }

  async openSelectedGitDiff(): Promise<void> {
    const root = this.activeTaskRoot;
    const item = this.gitChanges[this.selectedGitIndex] as any;
    const path = item?.path;
    if (!root || !path) return;
    this.diffText = await this.backend.gitFileDiff(root, path, item?.staged !== " ");
    this.focus = "diff";
    this.emit();
  }

  async stageSelectedGitFile(): Promise<void> {
    const root = this.activeTaskRoot;
    const item = this.gitChanges[this.selectedGitIndex] as any;
    if (!root || !item?.path) return;
    await this.backend.gitStage(root, item.path);
    await this.refreshGit();
  }

  async unstageSelectedGitFile(): Promise<void> {
    const root = this.activeTaskRoot;
    const item = this.gitChanges[this.selectedGitIndex] as any;
    if (!root || !item?.path) return;
    await this.backend.gitUnstage(root, item.path);
    await this.refreshGit();
  }

  async refreshHistory(): Promise<void> {
    const root = this.activeTaskRoot;
    if (!root) return;
    this.gitHistory = await this.backend.gitLog(root);
    this.focus = "gitHistory";
    this.emit();
  }

  async openFiles(): Promise<void> {
    const root = this.activeTaskRoot;
    if (!root) return;
    this.currentDirectory = root;
    this.fileEntries = await this.backend.readDirEntries(root, root);
    this.focus = "files";
    this.emit();
  }

  async openSelectedFile(): Promise<void> {
    const root = this.activeTaskRoot;
    const entry = this.fileEntries[this.selectedFileIndex];
    if (!root || !entry) return;
    if (entry.is_dir) {
      this.currentDirectory = entry.path;
      this.fileEntries = await this.backend.readDirEntries(entry.path, root);
      this.selectedFileIndex = 0;
      this.emit();
      return;
    }
    this.fileContent = await this.backend.readFileContent(entry.path, root);
    this.focus = "files";
    this.emit();
  }

  async refreshBranches(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    try {
      this.branches = await this.backend.gitListBranches(project.path);
      this.baseBranch = this.branches.find((branch) => branch.current)?.name ?? this.branches[0]?.name ?? "";
    } catch {
      this.branches = [];
    }
  }

  cycleLaunchMode(): void {
    this.launchMode = this.launchMode === "local" ? "worktree" : "local";
    this.emit();
  }

  cycleFocus(): void {
    const order: FocusPane[] = ["projects", "tasks", "composer", "terminal", "session", "files", "gitChanges", "gitHistory"];
    this.focus = order[(order.indexOf(this.focus) + 1) % order.length];
    this.emit();
  }

  moveInActivePane(delta: number): void {
    if (this.focus === "projects") return void this.selectProject(delta);
    if (this.focus === "tasks") return this.selectTask(delta);
    if (this.focus === "gitChanges" && this.gitChanges.length > 0) {
      this.selectedGitIndex = (this.selectedGitIndex + delta + this.gitChanges.length) % this.gitChanges.length;
    }
    if (this.focus === "files" && this.fileEntries.length > 0) {
      this.selectedFileIndex = (this.selectedFileIndex + delta + this.fileEntries.length) % this.fileEntries.length;
    }
    this.emit();
  }

  private applyBackendEvent(event: BackendEvent): void {
    if (event.event === "task-output") {
      const current = this.terminalBuffers.get(event.payload.task_id) ?? "";
      const next = `${current}${event.payload.data}`;
      this.terminalBuffers.set(event.payload.task_id, next.slice(-300_000));
      this.emit();
      return;
    }

    if (event.event === "task-session") {
      const task = this.tasks.find((task) => task.id === event.payload.task_id);
      if (!task) return;
      const patch: Partial<Task> =
        task.agent === "codex"
          ? { codexSessionId: event.payload.session_id, codexSessionPath: event.payload.session_path }
          : { claudeSessionId: event.payload.session_id, claudeSessionPath: event.payload.session_path };
      this.updateTask(event.payload.task_id, patch);
      void this.persistTasks();
      return;
    }

    if (event.event === "task-status") {
      const patch: Partial<Task> = {
        status: event.payload.status as TaskStatus,
        failureReason: event.payload.failure_reason,
        attentionRequestedAt: event.payload.status === "input_required" ? Date.now() : undefined,
      };
      this.updateTask(event.payload.task_id, patch);
      const task = this.tasks.find((task) => task.id === event.payload.task_id);
      if (task?.worktreePath && event.payload.status === "done" && task.baseBranch) {
        void this.backend
          .worktreeDiffStats(this.activeProject?.path ?? task.worktreePath, task.worktreePath, task.baseBranch)
          .then((stats) => {
            this.updateTask(task.id, { additions: stats.additions, deletions: stats.deletions });
            void this.persistTasks();
          })
          .catch(() => undefined);
      }
      void this.persistTasks();
    }
  }

  private updateTask(taskId: string, patch: Partial<Task>): void {
    this.tasks = this.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task));
    this.emit();
  }

  private async persistTasks(): Promise<void> {
    if (!this.activeProjectId) return;
    await this.backend.saveProjectTasks(this.activeProjectId, this.tasks);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
