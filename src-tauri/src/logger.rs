// File-based logger for debugging the agent pipeline.
// Writes to office-ai/logs/app.log

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Initialize the logger. Must be called once at startup.
pub fn init() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let log_dir = PathBuf::from(manifest_dir).parent().unwrap().join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_file = log_dir.join("app.log");

    // Truncate on startup so we get a fresh log each run
    let _ = fs::write(&log_file, "");

    LOG_PATH.set(log_file).ok();
    log("Logger initialized");
}

/// Append a timestamped message to the log file.
pub fn log(msg: &str) {
    let Some(path) = LOG_PATH.get() else {
        eprintln!("[LOG] {msg}");
        return;
    };

    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
    let line = format!("[{timestamp}] {msg}\n");

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Read the last `n` lines from the log file.
pub fn read_recent_lines(n: usize) -> Vec<String> {
    let Some(path) = LOG_PATH.get() else {
        return Vec::new();
    };

    match fs::read_to_string(path) {
        Ok(content) => tail_lines(&content, n),
        Err(_) => Vec::new(),
    }
}

fn tail_lines(content: &str, n: usize) -> Vec<String> {
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].iter().map(|l| l.to_string()).collect()
}

/// Log with a category prefix.
#[macro_export]
macro_rules! app_log {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logger::log(&format!("[{}] {}", $cat, format_args!($($arg)*)))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tail_lines_returns_last_n() {
        let content = "line1\nline2\nline3\nline4\nline5";
        let result = tail_lines(content, 3);
        assert_eq!(result, vec!["line3", "line4", "line5"]);
    }

    #[test]
    fn test_tail_lines_fewer_than_n() {
        let content = "line1\nline2";
        let result = tail_lines(content, 5);
        assert_eq!(result, vec!["line1", "line2"]);
    }

    #[test]
    fn test_tail_lines_empty_content() {
        let result = tail_lines("", 10);
        assert!(result.is_empty());
    }

    #[test]
    fn test_tail_lines_exact_n() {
        let content = "a\nb\nc";
        let result = tail_lines(content, 3);
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_tail_lines_zero() {
        let content = "a\nb\nc";
        let result = tail_lines(content, 0);
        assert!(result.is_empty());
    }
}
