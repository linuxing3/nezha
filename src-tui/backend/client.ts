import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Project, Task } from "../../src/types.js";

export type BackendEvent =
  | {
      event: "task-status";
      payload: { task_id: string; status: Task["status"]; failure_reason?: string };
    }
  | { event: "task-session"; payload: { task_id: string; session_id: string; session_path: string } }
  | { event: "task-output"; payload: { task_id: string; data: string } }
  | { event: "backend-log"; payload: { message: string } };

export interface SessionBlock {
  role: string;
  kind: string;
  text: string;
}

export interface WorktreeInfo {
  worktreePath: string;
  worktreeBranch: string;
  baseBranch: string;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class BackendClient extends EventTarget {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();

  constructor(command = process.env.NEZHA_BACKEND ?? "src-tauri/target/debug/nezha-backend") {
    super();
    this.child = spawn(command, [], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("exit", (code, signal) => {
      const err = new Error(`nezha-backend exited with ${signal ?? code}`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.dispatchEvent(new CustomEvent("backend-exit", { detail: { code, signal } }));
    });

    this.child.stderr.on("data", (chunk) => {
      this.dispatchEvent(new CustomEvent("backend-stderr", { detail: String(chunk) }));
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));
  }

  loadProjects(): Promise<Project[]> {
    return this.request("load_projects");
  }

  loadProjectTasks(projectId: string): Promise<Task[]> {
    return this.request("load_project_tasks", { project_id: projectId });
  }

  saveProjectTasks(projectId: string, tasks: Task[]): Promise<void> {
    return this.request("save_project_tasks", { project_id: projectId, tasks });
  }

  runTask(params: {
    task_id: string;
    project_path: string;
    prompt: string;
    agent: string;
    permission_mode: string;
    cols?: number;
    rows?: number;
  }): Promise<void> {
    return this.request("run_task", params);
  }

  resumeTask(params: {
    task_id: string;
    project_path: string;
    agent: string;
    session_id: string;
    permission_mode: string;
    cols?: number;
    rows?: number;
  }): Promise<void> {
    return this.request("resume_task", params);
  }

  sendInput(taskId: string, data: string): Promise<void> {
    return this.request("send_input", { task_id: taskId, data });
  }

  resizePty(taskId: string, cols: number, rows: number): Promise<void> {
    return this.request("resize_pty", { task_id: taskId, cols, rows });
  }

  cancelTask(taskId: string, projectPath: string): Promise<void> {
    return this.request("cancel_task", { task_id: taskId, project_path: projectPath });
  }

  completeTask(taskId: string, projectPath: string): Promise<void> {
    return this.request("complete_task", { task_id: taskId, project_path: projectPath });
  }

  readSessionMessages(sessionPath: string): Promise<SessionBlock[]> {
    return this.request("read_session_messages", { session_path: sessionPath });
  }

  readSessionMetrics(sessionPath: string): Promise<unknown> {
    return this.request("read_session_metrics", { session_path: sessionPath });
  }

  exportSessionMarkdown(sessionPath: string, outputPath?: string): Promise<string> {
    return this.request("export_session_markdown", { session_path: sessionPath, output_path: outputPath });
  }

  gitStatus(projectPath: string): Promise<unknown[]> {
    return this.request("git_status", { project_path: projectPath });
  }

  gitListBranches(projectPath: string): Promise<Array<{ name: string; current: boolean; upstream?: string }>> {
    return this.request("git_list_branches", { project_path: projectPath });
  }

  gitFileDiff(projectPath: string, filePath: string, staged = false): Promise<string> {
    return this.request("git_file_diff", { project_path: projectPath, file_path: filePath, staged });
  }

  gitShowDiff(projectPath: string, commitHash: string): Promise<string> {
    return this.request("git_show_diff", { project_path: projectPath, commit_hash: commitHash });
  }

  gitShowFileDiff(projectPath: string, commitHash: string, filePath: string): Promise<string> {
    return this.request("git_show_file_diff", { project_path: projectPath, commit_hash: commitHash, file_path: filePath });
  }

  gitLog(projectPath: string, branch?: string, maxCount = 50): Promise<unknown[]> {
    return this.request("git_log", { project_path: projectPath, branch, max_count: maxCount });
  }

  gitCommitDetail(projectPath: string, commitHash: string): Promise<unknown> {
    return this.request("git_commit_detail", { project_path: projectPath, commit_hash: commitHash });
  }

  gitStage(projectPath: string, filePath: string): Promise<void> {
    return this.request("git_stage", { project_path: projectPath, file_path: filePath });
  }

  gitUnstage(projectPath: string, filePath: string): Promise<void> {
    return this.request("git_unstage", { project_path: projectPath, file_path: filePath });
  }

  gitStageAll(projectPath: string): Promise<void> {
    return this.request("git_stage_all", { project_path: projectPath });
  }

  gitUnstageAll(projectPath: string): Promise<void> {
    return this.request("git_unstage_all", { project_path: projectPath });
  }

  gitCommit(projectPath: string, message: string): Promise<void> {
    return this.request("git_commit", { project_path: projectPath, message });
  }

  createTaskWorktree(projectPath: string, taskId: string, baseBranch?: string): Promise<WorktreeInfo> {
    return this.request("create_task_worktree", { project_path: projectPath, task_id: taskId, base_branch: baseBranch });
  }

  mergeTaskWorktree(projectPath: string, worktreePath: string, branch: string): Promise<void> {
    return this.request("merge_task_worktree", { project_path: projectPath, worktree_path: worktreePath, branch });
  }

  removeTaskWorktree(projectPath: string, worktreePath: string, branch?: string): Promise<void> {
    return this.request("remove_task_worktree", { project_path: projectPath, worktree_path: worktreePath, branch });
  }

  worktreeDiffStats(projectPath: string, worktreePath: string, baseBranch?: string): Promise<{ additions: number; deletions: number }> {
    return this.request("worktree_diff_stats", { project_path: projectPath, worktree_path: worktreePath, base_branch: baseBranch });
  }

  readDirEntries(path: string, projectPath: string): Promise<Array<{ name: string; path: string; is_dir: boolean; extension?: string }>> {
    return this.request("read_dir_entries", { path, project_path: projectPath });
  }

  readFileContent(path: string, projectPath: string): Promise<string> {
    return this.request("read_file_content", { path, project_path: projectPath });
  }

  listProjectFiles(projectPath: string): Promise<string[]> {
    return this.request("list_project_files", { project_path: projectPath });
  }

  searchProjectFiles(projectPath: string, query: string): Promise<string[]> {
    return this.request("search_project_files", { project_path: projectPath, query });
  }

  shutdown(): void {
    void this.request("shutdown").finally(() => this.child.kill());
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = String(this.nextId++);
    const message = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${message}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.dispatchEvent(new CustomEvent("backend-stderr", { detail: `invalid backend json: ${line}` }));
      return;
    }

    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "backend request failed"));
      return;
    }

    if (message.kind === "event") {
      this.dispatchEvent(new CustomEvent<BackendEvent>("backend-event", { detail: message }));
    }
  }
}
