use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use nezha_lib::{app_settings, config, hooks, platform, storage};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

const SESSION_WAIT_MAX: Duration = Duration::from_millis(500);
const SESSION_WAIT_POLL: Duration = Duration::from_millis(50);
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
enum RequestMethod {
    LoadProjects,
    LoadProjectTasks { project_id: String },
    SaveProjectTasks { project_id: String, tasks: Vec<storage::Task> },
    RunTask(RunTaskParams),
    ResumeTask(ResumeTaskParams),
    SendInput { task_id: String, data: String },
    ResizePty { task_id: String, cols: u16, rows: u16 },
    CancelTask { task_id: String, project_path: String },
    CompleteTask { task_id: String, project_path: String },
    ReadSessionMessages { session_path: String },
    ReadSessionMetrics { session_path: String },
    ExportSessionMarkdown { session_path: String, output_path: Option<String> },
    GitStatus { project_path: String },
    GitListBranches { project_path: String },
    GitFileDiff { project_path: String, file_path: String, staged: Option<bool> },
    GitShowDiff { project_path: String, commit_hash: String },
    GitShowFileDiff { project_path: String, commit_hash: String, file_path: String },
    GitLog { project_path: String, branch: Option<String>, max_count: Option<u32> },
    GitCommitDetail { project_path: String, commit_hash: String },
    GitStage { project_path: String, file_path: String },
    GitUnstage { project_path: String, file_path: String },
    GitStageFiles { project_path: String, file_paths: Vec<String> },
    GitUnstageFiles { project_path: String, file_paths: Vec<String> },
    GitStageAll { project_path: String },
    GitUnstageAll { project_path: String },
    GitCommit { project_path: String, message: String },
    GitPush { project_path: String },
    GitPull { project_path: String },
    GitRemoteCounts { project_path: String },
    CreateTaskWorktree { project_path: String, task_id: String, base_branch: Option<String> },
    MergeTaskWorktree { project_path: String, worktree_path: String, branch: String },
    RemoveTaskWorktree { project_path: String, worktree_path: String, branch: Option<String> },
    WorktreeDiffStats { project_path: String, worktree_path: String, base_branch: Option<String> },
    ReadDirEntries { path: String, project_path: String },
    ReadFileContent { path: String, project_path: String },
    ListProjectFiles { project_path: String },
    SearchProjectFiles { project_path: String, query: String },
    Shutdown,
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(flatten)]
    method: RequestMethod,
}

#[derive(Deserialize)]
struct RunTaskParams {
    task_id: String,
    project_path: String,
    prompt: String,
    agent: String,
    permission_mode: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
struct ResumeTaskParams {
    task_id: String,
    project_path: String,
    agent: String,
    session_id: String,
    permission_mode: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Serialize)]
struct Response<'a, T: Serialize> {
    kind: &'static str,
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "kebab-case")]
enum BackendEvent {
    TaskStatus {
        task_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        failure_reason: Option<String>,
    },
    TaskSession {
        task_id: String,
        session_id: String,
        session_path: String,
    },
    TaskOutput { task_id: String, data: String },
    BackendLog { message: String },
}

#[derive(Serialize)]
struct EventEnvelope {
    kind: &'static str,
    #[serde(flatten)]
    event: BackendEvent,
}

struct RunningTask {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    project_path: String,
    is_codex: bool,
    cancelled: bool,
    completed: bool,
}

struct BackendState {
    tasks: HashMap<String, RunningTask>,
}

impl BackendState {
    fn new() -> Self {
        Self { tasks: HashMap::new() }
    }
}

fn main() {
    if let Err(err) = run() {
        let _ = writeln!(io::stderr(), "nezha-backend: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    app_settings::get_login_shell_path();
    hooks::cache_status(hooks::ensure_installed());

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut state = BackendState::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if line.trim().is_empty() {
                    reap_finished_tasks(&mut state);
                    continue;
                }
                let request: Request = match serde_json::from_str(&line) {
                    Ok(request) => request,
                    Err(err) => {
                        emit_error_response("parse-error", err.to_string());
                        continue;
                    }
                };
                let id = request.id.clone();
                let shutdown = matches!(request.method, RequestMethod::Shutdown);
                let result = handle_request(&mut state, request);
                match result {
                    Ok(value) => emit_ok_response(&id, value),
                    Err(err) => emit_err_response(&id, err),
                }
                reap_finished_tasks(&mut state);
                if shutdown {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => reap_finished_tasks(&mut state),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

fn handle_request(state: &mut BackendState, request: Request) -> Result<Value, String> {
    match request.method {
        RequestMethod::LoadProjects => to_value(storage::load_projects()?),
        RequestMethod::LoadProjectTasks { project_id } => to_value(storage::load_project_tasks(project_id)?),
        RequestMethod::SaveProjectTasks { project_id, tasks } => {
            storage::save_project_tasks(project_id, tasks)?;
            Ok(Value::Null)
        }
        RequestMethod::RunTask(params) => {
            run_task(state, params)?;
            Ok(Value::Null)
        }
        RequestMethod::ResumeTask(params) => {
            resume_task(state, params)?;
            Ok(Value::Null)
        }
        RequestMethod::SendInput { task_id, data } => {
            if let Some(task) = state.tasks.get_mut(&task_id) {
                task.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
                task.writer.flush().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        RequestMethod::ResizePty { task_id, cols, rows } => {
            if cols >= 2 && rows >= 2 && cols <= 10_000 && rows <= 10_000 {
                if let Some(task) = state.tasks.get_mut(&task_id) {
                    task.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
                }
            }
            Ok(Value::Null)
        }
        RequestMethod::CancelTask { task_id, project_path } => {
            if let Some(task) = state.tasks.get_mut(&task_id) {
                task.cancelled = true;
                let _ = task.child.kill();
            }
            cleanup_task(&project_path, &task_id);
            emit_event(BackendEvent::TaskStatus { task_id, status: "cancelled".into(), failure_reason: None });
            Ok(Value::Null)
        }
        RequestMethod::CompleteTask { task_id, project_path } => {
            if let Some(task) = state.tasks.get_mut(&task_id) {
                task.completed = true;
                let _ = task.child.kill();
            }
            cleanup_task(&project_path, &task_id);
            emit_event(BackendEvent::TaskStatus { task_id, status: "done".into(), failure_reason: None });
            Ok(Value::Null)
        }
        RequestMethod::ReadSessionMessages { session_path } => to_value(read_session_messages_simple(&session_path)?),
        RequestMethod::ReadSessionMetrics { session_path } => to_value(read_session_metrics_simple(&session_path)?),
        RequestMethod::ExportSessionMarkdown { session_path, output_path } => to_value(export_session_markdown_simple(&session_path, output_path)?),
        RequestMethod::GitStatus { project_path } => to_value(git_status_simple(&project_path)?),
        RequestMethod::GitListBranches { project_path } => to_value(git_list_branches_simple(&project_path)?),
        RequestMethod::GitFileDiff { project_path, file_path, staged } => to_value(git_file_diff_simple(&project_path, &file_path, staged.unwrap_or(false))?),
        RequestMethod::GitShowDiff { project_path, commit_hash } => to_value(git_output_string(&project_path, &["show", "--stat", "--patch", &commit_hash])?),
        RequestMethod::GitShowFileDiff { project_path, commit_hash, file_path } => to_value(git_output_string(&project_path, &["show", "--patch", &commit_hash, "--", &file_path])?),
        RequestMethod::GitLog { project_path, branch, max_count } => to_value(git_log_simple(&project_path, branch, max_count.unwrap_or(50))?),
        RequestMethod::GitCommitDetail { project_path, commit_hash } => to_value(git_commit_detail_simple(&project_path, &commit_hash)?),
        RequestMethod::GitStage { project_path, file_path } => git_void(&project_path, &["add", "--", &file_path]),
        RequestMethod::GitUnstage { project_path, file_path } => git_void(&project_path, &["restore", "--staged", "--", &file_path]),
        RequestMethod::GitStageFiles { project_path, file_paths } => git_paths_void(&project_path, &["add", "--"], file_paths),
        RequestMethod::GitUnstageFiles { project_path, file_paths } => git_paths_void(&project_path, &["restore", "--staged", "--"], file_paths),
        RequestMethod::GitStageAll { project_path } => git_void(&project_path, &["add", "-A"]),
        RequestMethod::GitUnstageAll { project_path } => git_void(&project_path, &["reset"]),
        RequestMethod::GitCommit { project_path, message } => git_void(&project_path, &["commit", "-m", &message]),
        RequestMethod::GitPush { project_path } => git_void(&project_path, &["push"]),
        RequestMethod::GitPull { project_path } => git_void(&project_path, &["pull", "--ff-only"]),
        RequestMethod::GitRemoteCounts { project_path } => to_value(git_remote_counts_simple(&project_path)?),
        RequestMethod::CreateTaskWorktree { project_path, task_id, base_branch } => to_value(create_task_worktree_simple(&project_path, &task_id, base_branch)?),
        RequestMethod::MergeTaskWorktree { project_path, worktree_path, branch } => to_value(merge_task_worktree_simple(&project_path, &worktree_path, &branch)?),
        RequestMethod::RemoveTaskWorktree { project_path, worktree_path, branch } => to_value(remove_task_worktree_simple(&project_path, &worktree_path, branch)?),
        RequestMethod::WorktreeDiffStats { project_path, worktree_path, base_branch } => to_value(worktree_diff_stats_simple(&project_path, &worktree_path, base_branch)?),
        RequestMethod::ReadDirEntries { path, project_path } => to_value(read_dir_entries_simple(&path, &project_path)?),
        RequestMethod::ReadFileContent { path, project_path } => to_value(read_file_content_simple(&path, &project_path)?),
        RequestMethod::ListProjectFiles { project_path } => to_value(list_project_files_simple(&project_path)?),
        RequestMethod::SearchProjectFiles { project_path, query } => to_value(search_project_files_simple(&project_path, &query)?),
        RequestMethod::Shutdown => Ok(Value::Null),
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn run_task(state: &mut BackendState, params: RunTaskParams) -> Result<(), String> {
    state.tasks.remove(&params.task_id);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: params.rows.unwrap_or(50),
            cols: params.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let final_prompt = build_prompt(&params.project_path, &params.prompt)?;
    let launch = app_settings::get_agent_launch_spec(&params.agent);
    let is_codex = params.agent == "codex";
    let use_hooks = hooks::usable_for(&params.agent);
    let pre_session_id = if !is_codex && app_settings::claude_version_gte("2.1.87") {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };

    let mut cmd = if is_codex {
        let mut c = build_codex_cmd(&launch.program, &params.permission_mode);
        if use_hooks {
            c.arg("--dangerously-bypass-hook-trust");
        }
        if !final_prompt.is_empty() {
            c.arg("--");
            c.arg(&final_prompt);
        }
        c
    } else {
        let mut c = build_claude_cmd(&launch.program, &params.permission_mode);
        if let Some(ref sid) = pre_session_id {
            c.arg("--session-id");
            c.arg(sid);
        }
        if use_hooks {
            if let Ok(path) = hooks::nezha_claude_settings_path() {
                c.arg("--settings");
                c.arg(path.to_string_lossy().as_ref());
            }
        }
        if !final_prompt.is_empty() {
            c.arg(&final_prompt);
        }
        c
    };
    prepare_command(&mut cmd, &params.project_path, &params.task_id, &params.agent, use_hooks, &launch.extra_env);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    spawn_reader(params.task_id.clone(), reader);
    spawn_event_watcher(params.task_id.clone(), params.agent.clone());
    spawn_session_discovery(params.task_id.clone(), params.project_path.clone(), is_codex);
    state.tasks.insert(
        params.task_id.clone(),
        RunningTask {
            writer,
            child,
            master: pair.master,
            project_path: params.project_path,
            is_codex,
            cancelled: false,
            completed: false,
        },
    );
    emit_event(BackendEvent::TaskStatus { task_id: params.task_id, status: "running".into(), failure_reason: None });
    Ok(())
}

fn resume_task(state: &mut BackendState, params: ResumeTaskParams) -> Result<(), String> {
    state.tasks.remove(&params.task_id);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: params.rows.unwrap_or(50),
            cols: params.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let launch = app_settings::get_agent_launch_spec(&params.agent);
    let is_codex = params.agent == "codex";
    let use_hooks = hooks::usable_for(&params.agent);
    let mut cmd = if is_codex {
        let mut c = build_codex_cmd(&launch.program, &params.permission_mode);
        if use_hooks {
            c.arg("--dangerously-bypass-hook-trust");
        }
        c.arg("resume");
        c.arg(&params.session_id);
        c
    } else {
        let mut c = build_claude_cmd(&launch.program, &params.permission_mode);
        c.arg("--resume");
        c.arg(&params.session_id);
        if use_hooks {
            if let Ok(path) = hooks::nezha_claude_settings_path() {
                c.arg("--settings");
                c.arg(path.to_string_lossy().as_ref());
            }
        }
        c
    };
    prepare_command(&mut cmd, &params.project_path, &params.task_id, &params.agent, use_hooks, &launch.extra_env);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    spawn_reader(params.task_id.clone(), reader);
    spawn_event_watcher(params.task_id.clone(), params.agent.clone());
    spawn_session_discovery(params.task_id.clone(), params.project_path.clone(), is_codex);
    state.tasks.insert(
        params.task_id.clone(),
        RunningTask {
            writer,
            child,
            master: pair.master,
            project_path: params.project_path,
            is_codex,
            cancelled: false,
            completed: false,
        },
    );
    emit_event(BackendEvent::TaskStatus { task_id: params.task_id, status: "running".into(), failure_reason: None });
    Ok(())
}

fn build_prompt(project_path: &str, prompt: &str) -> Result<String, String> {
    let cfg = config::read_project_config(project_path.to_string()).unwrap_or_default();
    if cfg.agent.prompt_prefix.is_empty() {
        Ok(prompt.to_string())
    } else {
        Ok(format!("{}\n{}", cfg.agent.prompt_prefix, prompt))
    }
}

fn prepare_command(
    cmd: &mut CommandBuilder,
    project_path: &str,
    task_id: &str,
    agent: &str,
    use_hooks: bool,
    extra_env: &[(String, String)],
) {
    cmd.cwd(project_path);
    for (key, value) in app_settings::get_login_shell_env() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if use_hooks {
        if let Ok(dir) = hooks::events_dir_for(task_id) {
            cmd.env("NEZHA_TASK_ID", task_id);
            cmd.env("NEZHA_EVENT_DIR", dir.to_string_lossy().as_ref());
            cmd.env("NEZHA_AGENT", agent);
        }
    }
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
}

fn build_claude_cmd(agent_bin: &str, permission_mode: &str) -> CommandBuilder {
    let mut c = CommandBuilder::new(agent_bin);
    c.env("CLAUDE_CODE_DISABLE_MOUSE", "1");
    match permission_mode {
        "ask" => {
            c.arg("--permission-mode");
            c.arg("default");
        }
        "auto_edit" => {
            c.arg("--permission-mode");
            c.arg("acceptEdits");
        }
        "full_access" => {
            c.arg("--dangerously-skip-permissions");
        }
        _ => {}
    }
    c
}

fn build_codex_cmd(agent_bin: &str, permission_mode: &str) -> CommandBuilder {
    let mut c = CommandBuilder::new(agent_bin);
    match permission_mode {
        "auto_edit" => {
            c.arg("--sandbox");
            c.arg("workspace-write");
            c.arg("-a");
            c.arg("on-request");
        }
        "full_access" => {
            c.arg("--dangerously-bypass-approvals-and-sandbox");
        }
        _ => {}
    }
    c
}

fn spawn_reader(task_id: String, mut reader: Box<dyn io::Read + Send>) {
    thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        let mut leftover = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut combined = std::mem::take(&mut leftover);
                    combined.extend_from_slice(&buf[..n]);
                    let valid_len = match std::str::from_utf8(&combined) {
                        Ok(_) => combined.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid_len > 0 {
                        let data = String::from_utf8_lossy(&combined[..valid_len]).into_owned();
                        emit_event(BackendEvent::TaskOutput { task_id: task_id.clone(), data });
                    }
                    if valid_len < combined.len() {
                        leftover = combined[valid_len..].to_vec();
                    }
                }
            }
        }
    });
}

fn spawn_event_watcher(task_id: String, agent: String) {
    thread::spawn(move || {
        let Ok(dir) = hooks::events_dir_for(&task_id) else { return; };
        let file = dir.join("events.jsonl");
        let mut offset = 0u64;
        let mut last_status = String::new();
        let deadline = Instant::now() + Duration::from_secs(60 * 60 * 12);
        while Instant::now() < deadline {
            if let Ok(mut handle) = fs::File::open(&file) {
                if handle.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut buf = String::new();
                    if handle.read_to_string(&mut buf).is_ok() {
                        let mut complete_end = 0usize;
                        for (idx, ch) in buf.char_indices() {
                            if ch == '\n' {
                                let line = &buf[complete_end..idx];
                                complete_end = idx + 1;
                                if let Ok(ev) = serde_json::from_str::<Value>(line) {
                                    dispatch_hook_event(&task_id, &agent, &ev, &mut last_status);
                                }
                            }
                        }
                        offset += complete_end as u64;
                    }
                }
            }
            thread::sleep(EVENT_POLL_INTERVAL);
        }
    });
}

fn dispatch_hook_event(task_id: &str, fallback_agent: &str, ev: &Value, last_status: &mut String) {
    let event = ev.get("event").and_then(Value::as_str).unwrap_or_default();
    match event {
        "SessionStart" => {
            let session_id = ev.get("session_id").and_then(Value::as_str).unwrap_or_default();
            if !session_id.is_empty() {
                let session_path = ev.get("transcript_path").and_then(Value::as_str).unwrap_or_default();
                emit_event(BackendEvent::TaskSession {
                    task_id: ev.get("task_id").and_then(Value::as_str).unwrap_or(task_id).to_string(),
                    session_id: session_id.to_string(),
                    session_path: session_path.to_string(),
                });
            }
        }
        "Notification" | "PermissionRequest" => emit_dedup_status(task_id, "input_required", last_status),
        "UserPromptSubmit" | "PostToolUse" => emit_dedup_status(task_id, "running", last_status),
        "Stop" => emit_dedup_status(task_id, "input_required", last_status),
        _ => {
            let _ = fallback_agent;
        }
    }
}

fn emit_dedup_status(task_id: &str, status: &str, last_status: &mut String) {
    if last_status == status {
        return;
    }
    *last_status = status.to_string();
    emit_event(BackendEvent::TaskStatus { task_id: task_id.to_string(), status: status.to_string(), failure_reason: None });
}

fn spawn_session_discovery(task_id: String, project_path: String, is_codex: bool) {
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut emitted = HashSet::new();
        while Instant::now() < deadline {
            for path in collect_candidate_session_files(&project_path, is_codex) {
                let key = path.to_string_lossy().into_owned();
                if emitted.contains(&key) {
                    continue;
                }
                if let Some((session_id, session_path)) = parse_session_meta(&path, is_codex) {
                    emitted.insert(key);
                    emit_event(BackendEvent::TaskSession { task_id: task_id.clone(), session_id, session_path });
                    return;
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn collect_candidate_session_files(project_path: &str, is_codex: bool) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if is_codex {
        roots.push(Path::new(project_path).join(".codex").join("sessions"));
        if let Some(home) = platform::home_dir() {
            roots.push(home.join(".codex").join("sessions"));
        }
    } else if let Some(home) = platform::home_dir() {
        roots.push(home.join(".claude").join("projects"));
    }
    let mut files = Vec::new();
    for root in roots {
        collect_jsonl_files(&root, &mut files);
    }
    files.sort_by_key(|path| fs::metadata(path).and_then(|m| m.modified()).ok());
    files.reverse();
    files.truncate(20);
    files
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn parse_session_meta(path: &Path, is_codex: bool) -> Option<(String, String)> {
    let modified_recently = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|elapsed| elapsed < Duration::from_secs(120));
    if !modified_recently {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    for line in raw.lines().take(20) {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue; };
        if is_codex {
            if value.get("type").and_then(Value::as_str) == Some("session_meta") {
                let id = value
                    .get("id")
                    .or_else(|| value.get("session_id"))
                    .or_else(|| value.get("payload").and_then(|p| p.get("id")))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !id.is_empty() {
                    return Some((id.to_string(), path.to_string_lossy().into_owned()));
                }
            }
        } else {
            let id = value
                .get("sessionId")
                .or_else(|| value.get("session_id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !id.is_empty() {
                return Some((id.to_string(), path.to_string_lossy().into_owned()));
            }
        }
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| (stem.trim_start_matches("rollout-").to_string(), path.to_string_lossy().into_owned()))
}

fn reap_finished_tasks(state: &mut BackendState) {
    let task_ids = state.tasks.keys().cloned().collect::<Vec<_>>();
    for task_id in task_ids {
        let status = if let Some(task) = state.tasks.get_mut(&task_id) {
            task.child.try_wait().ok().flatten()
        } else {
            None
        };
        if let Some(status) = status {
            if let Some(task) = state.tasks.remove(&task_id) {
                let exit_ok = status.success();
                let final_status = if task.cancelled {
                    None
                } else if task.completed || exit_ok || wait_for_session_file(&task.project_path, task.is_codex) {
                    Some(("done".to_string(), None))
                } else {
                    Some((
                        "failed".to_string(),
                        Some(format!("Process exited with code {}", status.exit_code())),
                    ))
                };
                cleanup_task(&task.project_path, &task_id);
                if let Some((status, failure_reason)) = final_status {
                    emit_event(BackendEvent::TaskStatus { task_id, status, failure_reason });
                }
            }
        }
    }
}

fn wait_for_session_file(project_path: &str, is_codex: bool) -> bool {
    let deadline = Instant::now() + SESSION_WAIT_MAX;
    while Instant::now() < deadline {
        if collect_candidate_session_files(project_path, is_codex)
            .into_iter()
            .any(|path| parse_session_meta(&path, is_codex).is_some())
        {
            return true;
        }
        thread::sleep(SESSION_WAIT_POLL);
    }
    false
}

fn cleanup_task(project_path: &str, task_id: &str) {
    let _ = fs::remove_dir_all(Path::new(project_path).join(".nezha").join("attachments").join(task_id));
    if let Ok(dir) = hooks::events_dir_for(task_id) {
        let _ = fs::remove_dir_all(dir);
    }
}

#[derive(Serialize)]
struct SessionBlock {
    role: String,
    kind: String,
    text: String,
}

fn read_session_messages_simple(session_path: &str) -> Result<Vec<SessionBlock>, String> {
    let raw = fs::read_to_string(session_path).map_err(|e| e.to_string())?;
    let mut blocks = Vec::new();
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue; };
        if let Some(block) = parse_claude_block(&value).or_else(|| parse_codex_block(&value)) {
            blocks.push(block);
        }
    }
    Ok(blocks)
}

fn parse_claude_block(value: &Value) -> Option<SessionBlock> {
    let role = value.get("type").and_then(Value::as_str)?;
    if role == "user" {
        let message = value.get("message")?;
        let content = message.get("content").unwrap_or(message);
        return Some(SessionBlock { role: "user".into(), kind: "text".into(), text: content_to_text(content) });
    }
    if role == "assistant" {
        let message = value.get("message")?;
        let content = message.get("content").unwrap_or(message);
        return Some(SessionBlock { role: "assistant".into(), kind: "text".into(), text: content_to_text(content) });
    }
    None
}

fn parse_codex_block(value: &Value) -> Option<SessionBlock> {
    let payload = value.get("payload")?;
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    match payload_type {
        "user_message" => Some(SessionBlock { role: "user".into(), kind: "text".into(), text: payload.get("message").and_then(Value::as_str).unwrap_or_default().to_string() }),
        "agent_message" | "assistant_message" => Some(SessionBlock { role: "assistant".into(), kind: "text".into(), text: payload.get("message").and_then(Value::as_str).unwrap_or_default().to_string() }),
        "function_call" | "custom_tool_call" => Some(SessionBlock { role: "assistant".into(), kind: "tool".into(), text: serde_json::to_string_pretty(payload).unwrap_or_default() }),
        "reasoning" => Some(SessionBlock { role: "assistant".into(), kind: "thinking".into(), text: content_to_text(payload) }),
        _ => None,
    }
}

fn content_to_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(content_to_text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                text.to_string()
            } else if let Some(content) = map.get("content") {
                content_to_text(content)
            } else if map.get("type").and_then(Value::as_str).is_some_and(|t| t.contains("tool")) {
                serde_json::to_string_pretty(value).unwrap_or_default()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

fn read_session_metrics_simple(session_path: &str) -> Result<Value, String> {
    let messages = read_session_messages_simple(session_path)?;
    Ok(json!({
        "messages": messages.len(),
        "toolCalls": messages.iter().filter(|m| m.kind == "tool").count(),
        "thinkingBlocks": messages.iter().filter(|m| m.kind == "thinking").count(),
    }))
}

fn export_session_markdown_simple(session_path: &str, output_path: Option<String>) -> Result<String, String> {
    let messages = read_session_messages_simple(session_path)?;
    let mut md = String::new();
    for message in messages {
        md.push_str(&format!("## {} ({})\n\n{}\n\n", message.role, message.kind, message.text));
    }
    let output = output_path.unwrap_or_else(|| format!("{session_path}.md"));
    fs::write(&output, md).map_err(|e| e.to_string())?;
    Ok(output)
}

fn git_command(project_path: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|e| e.to_string())
}

fn git_output_string(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command(project_path, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_void(project_path: &str, args: &[&str]) -> Result<Value, String> {
    git_output_string(project_path, args)?;
    Ok(Value::Null)
}

fn git_paths_void(project_path: &str, prefix: &[&str], paths: Vec<String>) -> Result<Value, String> {
    let mut args = prefix.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    args.extend(paths);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    git_void(project_path, &refs)
}

fn git_status_simple(project_path: &str) -> Result<Vec<Value>, String> {
    let raw = git_output_string(project_path, &["status", "--porcelain=v1"])?;
    Ok(raw.lines().filter_map(|line| {
        if line.len() < 4 { return None; }
        let staged = line.chars().next().unwrap_or(' ');
        let unstaged = line.chars().nth(1).unwrap_or(' ');
        let path = line[3..].to_string();
        Some(json!({"path": path, "staged": staged.to_string(), "unstaged": unstaged.to_string(), "status": line[..2].trim()}))
    }).collect())
}

fn git_list_branches_simple(project_path: &str) -> Result<Vec<Value>, String> {
    let raw = git_output_string(project_path, &["branch", "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)"])?;
    Ok(raw.lines().map(|line| {
        let parts = line.split('\t').collect::<Vec<_>>();
        json!({"current": parts.first().copied().unwrap_or("") == "*", "name": parts.get(1).copied().unwrap_or(""), "upstream": parts.get(2).copied().unwrap_or("")})
    }).collect())
}

fn git_file_diff_simple(project_path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    if staged {
        git_output_string(project_path, &["diff", "--staged", "--", file_path])
    } else {
        git_output_string(project_path, &["diff", "--", file_path])
    }
}

fn git_log_simple(project_path: &str, branch: Option<String>, max_count: u32) -> Result<Vec<Value>, String> {
    let max = format!("-{max_count}");
    let mut args = vec!["log", &max, "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s", "--date=short"];
    if let Some(branch) = branch.as_deref() { args.push(branch); }
    let raw = git_output_string(project_path, &args)?;
    Ok(raw.lines().map(|line| {
        let p = line.split('\t').collect::<Vec<_>>();
        json!({"hash": p.first().copied().unwrap_or(""), "shortHash": p.get(1).copied().unwrap_or(""), "author": p.get(2).copied().unwrap_or(""), "date": p.get(3).copied().unwrap_or(""), "subject": p.get(4).copied().unwrap_or("")})
    }).collect())
}

fn git_commit_detail_simple(project_path: &str, commit_hash: &str) -> Result<Value, String> {
    let show = git_output_string(project_path, &["show", "--stat", "--patch", commit_hash])?;
    Ok(json!({"hash": commit_hash, "diff": show}))
}

fn git_remote_counts_simple(project_path: &str) -> Result<Value, String> {
    let branch = git_output_string(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let upstream = git_command(project_path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let Ok(upstream_output) = upstream else { return Ok(json!({"branch": branch, "ahead": 0, "behind": 0})); };
    if !upstream_output.status.success() { return Ok(json!({"branch": branch, "ahead": 0, "behind": 0})); }
    let counts = git_output_string(project_path, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])?;
    let parts = counts.split_whitespace().collect::<Vec<_>>();
    Ok(json!({"branch": branch, "ahead": parts.first().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0), "behind": parts.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0)}))
}

fn git_root(project_path: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git_output_string(project_path, &["rev-parse", "--show-toplevel"])?.trim()))
}

fn create_task_worktree_simple(project_path: &str, task_id: &str, base_branch: Option<String>) -> Result<Value, String> {
    let root = git_root(project_path)?;
    let suffix = task_id.chars().take(8).collect::<String>();
    let branch = format!("nezha/task-{suffix}");
    let worktree_path = root.join(".nezha").join("worktrees").join(task_id);
    fs::create_dir_all(worktree_path.parent().unwrap_or(&root)).map_err(|e| e.to_string())?;
    let base = base_branch.unwrap_or_else(|| "HEAD".to_string());
    let path_str = worktree_path.to_string_lossy().into_owned();
    git_output_string(project_path, &["worktree", "add", "-B", &branch, &path_str, &base])?;
    Ok(json!({"worktreePath": path_str, "worktreeBranch": branch, "baseBranch": base}))
}

fn merge_task_worktree_simple(project_path: &str, _worktree_path: &str, branch: &str) -> Result<Value, String> {
    git_output_string(project_path, &["merge", "--no-ff", branch])?;
    Ok(Value::Null)
}

fn remove_task_worktree_simple(project_path: &str, worktree_path: &str, branch: Option<String>) -> Result<Value, String> {
    let _ = git_output_string(project_path, &["worktree", "remove", "--force", worktree_path]);
    if let Some(branch) = branch {
        let _ = git_output_string(project_path, &["branch", "-D", &branch]);
    }
    Ok(Value::Null)
}

fn worktree_diff_stats_simple(project_path: &str, worktree_path: &str, base_branch: Option<String>) -> Result<Value, String> {
    let base = base_branch.unwrap_or_else(|| "HEAD".to_string());
    let raw = git_output_string(worktree_path, &["diff", "--numstat", &base])
        .or_else(|_| git_output_string(project_path, &["diff", "--numstat", &base]))?;
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for line in raw.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        additions += parts.first().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        deletions += parts.get(1).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    }
    Ok(json!({"additions": additions, "deletions": deletions}))
}

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    extension: Option<String>,
}

fn validate_inside(path: &str, project_path: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path).canonicalize().map_err(|e| e.to_string())?;
    let target = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("Path is outside project".into());
    }
    Ok(target)
}

fn read_dir_entries_simple(path: &str, project_path: &str) -> Result<Vec<DirEntryInfo>, String> {
    let dir = validate_inside(path, project_path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == "node_modules" || name == "target" { continue; }
        entries.push(DirEntryInfo {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: path.is_dir(),
            extension: path.extension().and_then(|e| e.to_str()).map(str::to_string),
        });
    }
    entries.sort_by_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

fn read_file_content_simple(path: &str, project_path: &str) -> Result<String, String> {
    let path = validate_inside(path, project_path)?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn list_project_files_simple(project_path: &str) -> Result<Vec<String>, String> {
    let root = Path::new(project_path).canonicalize().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    collect_project_files(&root, &root, &mut out, 0)?;
    Ok(out)
}

fn collect_project_files(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) -> Result<(), String> {
    if depth > 12 || out.len() > 1000 { return Ok(()); }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | ".next") { continue; }
        if path.is_dir() {
            collect_project_files(root, &path, out, depth + 1)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

fn search_project_files_simple(project_path: &str, query: &str) -> Result<Vec<String>, String> {
    let q = query.to_lowercase();
    Ok(list_project_files_simple(project_path)?.into_iter().filter(|p| p.to_lowercase().contains(&q)).take(200).collect())
}

fn emit_ok_response<T: Serialize>(id: &str, result: T) {
    let response = Response { kind: "response", id, ok: true, result: Some(result), error: None };
    emit_json(&response);
}

fn emit_err_response(id: &str, error: String) {
    let response = Response::<Value> { kind: "response", id, ok: false, result: None, error: Some(error) };
    emit_json(&response);
}

fn emit_error_response(id: &str, error: String) {
    emit_err_response(id, error);
}

fn emit_event(event: BackendEvent) {
    emit_json(&EventEnvelope { kind: "event", event });
}

fn emit_json<T: Serialize>(value: &T) {
    if let Ok(raw) = serde_json::to_string(value) {
        println!("{raw}");
        let _ = io::stdout().flush();
    }
}
