import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { GitBranch, RefreshCw, Trash2 } from "lucide-react";
import type { GitWorktreeInfo, Task } from "../types";
import { useCancellableInvoke } from "../hooks/useCancellableInvoke";
import { useI18n } from "../i18n";
import s from "../styles";

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

export function WorktreePanel({
  projectPath,
  tasks,
  onOpenGitChanges,
  onOpenFiles,
  onMergeWorktree,
  onDiscardWorktree,
  width = 280,
}: {
  projectPath: string;
  tasks: Task[];
  onOpenGitChanges: (taskId: string | null) => void;
  onOpenFiles: (taskId: string | null) => void;
  onMergeWorktree: (taskId: string) => Promise<void>;
  onDiscardWorktree: (taskId: string) => Promise<void>;
  width?: number;
}) {
  const { t } = useI18n();
  const { safeInvoke, isCancelled } = useCancellableInvoke();
  const [items, setItems] = useState<GitWorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await safeInvoke<GitWorktreeInfo[]>("git_list_worktrees", { projectPath });
      if (result === null) return;
      setItems(result);
    } catch (err) {
      if (!isCancelled()) setError(String(err));
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, [isCancelled, projectPath, safeInvoke]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const taskByWorktree = new Map(
    tasks
      .filter((task) => task.worktreePath && !task.worktreeDiscarded)
      .map((task) => [task.worktreePath, task]),
  );

  const handlePrune = async () => {
    const ok = await confirm(t("worktree.confirmPrune"), {
      title: t("worktree.prune"),
      kind: "warning",
      okLabel: t("worktree.prune"),
    });
    if (!ok) return;
    try {
      setError(null);
      await invoke("git_prune_worktrees", { projectPath });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div style={{ ...s.fileExplorerRoot, width }}>
      <div style={s.fileExplorerHeader}>
        <span style={s.fileExplorerHeaderTitle}>{t("worktree.title")}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          title={t("common.refresh")}
          style={s.fileExplorerRefreshBtn}
        >
          <RefreshCw size={13} className={loading ? "spin" : undefined} />
        </button>
        <button
          type="button"
          onClick={() => void handlePrune()}
          title={t("worktree.prune")}
          style={s.fileExplorerRefreshBtn}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {error && (
        <div
          style={{
            margin: "8px 10px",
            padding: "6px 8px",
            border: "1px solid var(--danger-border)",
            borderRadius: 6,
            background: "var(--danger-surface)",
            color: "var(--danger-fg)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
        {items.length === 0 && !loading && (
          <div style={s.fileExplorerEmpty}>{t("worktree.empty")}</div>
        )}
        {items.map((item) => {
          const task = taskByWorktree.get(item.path) ?? null;
          const isMain = item.path === projectPath;
          return (
            <div
              key={item.path}
              style={{
                padding: "9px 10px",
                marginBottom: 8,
                border: "1px solid var(--border-dim)",
                borderRadius: 8,
                background: "var(--bg-card)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <GitBranch size={13} style={{ color: "var(--text-hint)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 650,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.branch ?? (item.detached ? t("branch.detachedHead") : t("worktree.main"))}
                  </div>
                  <div
                    title={item.path}
                    style={{
                      marginTop: 2,
                      fontSize: 11,
                      color: "var(--text-hint)",
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {compactPath(item.path)}
                  </div>
                </div>
                {item.dirty && (
                  <span style={{ fontSize: 11, color: "var(--warning)", fontWeight: 650 }}>
                    {t("worktree.dirty")}
                  </span>
                )}
              </div>
              {task && (
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
                  {task.name ?? task.prompt.slice(0, 80)}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={s.hooksPanelSecondaryBtn}
                  onClick={() => onOpenGitChanges(task?.id ?? null)}
                >
                  {t("git.changes")}
                </button>
                <button
                  type="button"
                  style={s.hooksPanelSecondaryBtn}
                  onClick={() => onOpenFiles(task?.id ?? null)}
                >
                  {t("file.files")}
                </button>
                {task?.status === "done" && task.worktreePath && !task.worktreeDiscarded && (
                  <button
                    type="button"
                    style={s.hooksPanelPrimaryBtn}
                    disabled={busyTaskId === task.id}
                    onClick={async () => {
                      setBusyTaskId(task.id);
                      try {
                        await onMergeWorktree(task.id);
                        await refresh();
                      } finally {
                        setBusyTaskId(null);
                      }
                    }}
                  >
                    {t("running.mergeTo", { branch: task.baseBranch ?? "" })}
                  </button>
                )}
                {!isMain && task?.worktreePath && !task.worktreeDiscarded && (
                  <button
                    type="button"
                    style={s.hooksPanelDangerBtn}
                    disabled={busyTaskId === task.id}
                    onClick={async () => {
                      setBusyTaskId(task.id);
                      try {
                        await onDiscardWorktree(task.id);
                        await refresh();
                      } finally {
                        setBusyTaskId(null);
                      }
                    }}
                  >
                    {t("running.discardWorktree")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
