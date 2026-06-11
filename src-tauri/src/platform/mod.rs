use std::path::PathBuf;

#[cfg(not(windows))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use self::unix as imp;
#[cfg(windows)]
use self::windows as imp;

pub struct ShellCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub fn home_dir() -> Option<PathBuf> {
    imp::home_dir()
}

pub fn login_shell_env() -> &'static [(String, String)] {
    imp::login_shell_env()
}

pub fn login_shell_path() -> &'static str {
    imp::login_shell_path()
}

pub fn default_shell_command() -> ShellCommand {
    imp::default_shell_command()
}

pub fn detect_path(binary: &str) -> String {
    imp::detect_path(binary)
}
