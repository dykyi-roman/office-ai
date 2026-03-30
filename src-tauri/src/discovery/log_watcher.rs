// Log file watcher using polling
// Monitors agent log directories for new log lines every 500ms.
// Format-agnostic: delegates file reading to LogFileReader implementations.

use super::log_reader::LogFileReader;
use crate::error::AppError;
use std::path::PathBuf;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

/// Polling interval for checking log file changes
const POLL_INTERVAL_MS: u64 = 500;

/// A raw log line read from a log file, with the source file path.
#[derive(Debug, Clone)]
pub struct RawLogLine {
    pub path: PathBuf,
    pub line: String,
}

/// Collect all files from watched directories.
/// Descends one level into subdirectories to support nested session structures
/// (e.g. Cursor's `agent-transcripts/{session-uuid}/{session-uuid}.jsonl`).
fn collect_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    files.push(path);
                } else if path.is_dir() {
                    if let Ok(sub_entries) = std::fs::read_dir(&path) {
                        for sub_entry in sub_entries.flatten() {
                            let sub_path = sub_entry.path();
                            if sub_path.is_file() {
                                files.push(sub_path);
                            }
                        }
                    }
                }
            }
        }
    }
    files
}

/// Start the log watcher as a background Tokio task.
/// Polls log files every 500ms for new content.
///
/// `readers` — format-specific readers (each decides which files it can handle).
/// `watch_dirs` — pre-resolved directories to scan for log files.
/// `custom_paths` — additional directories to watch directly.
pub async fn run_log_watcher(
    mut readers: Vec<Box<dyn LogFileReader>>,
    watch_dirs: Vec<PathBuf>,
    custom_paths: Vec<PathBuf>,
    tx: mpsc::Sender<RawLogLine>,
) -> Result<(), AppError> {
    let mut all_dirs = watch_dirs;
    for p in &custom_paths {
        if p.exists() && p.is_dir() {
            all_dirs.push(p.clone());
        }
    }

    app_log!("WATCHER", "polling {} project dirs", all_dirs.len());
    for dir in &all_dirs {
        app_log!("WATCHER", "dir: {:?}", dir.file_name());
    }

    // Seed existing file positions (skip old content)
    let initial_files = collect_files(&all_dirs);
    for file in &initial_files {
        for reader in &mut readers {
            if reader.can_handle(file) {
                reader.seed(file);
                break;
            }
        }
    }
    app_log!("WATCHER", "seeded {} existing files", initial_files.len());

    // Poll loop
    let mut ticker = interval(Duration::from_millis(POLL_INTERVAL_MS));
    loop {
        ticker.tick().await;

        let files = collect_files(&all_dirs);
        for path in &files {
            let mut new_lines = Vec::new();
            for reader in &mut readers {
                if reader.can_handle(path) {
                    new_lines = reader.read_new(path);
                    break;
                }
            }

            if !new_lines.is_empty() {
                app_log!(
                    "WATCHER",
                    "read {} new lines from {:?}",
                    new_lines.len(),
                    path.file_name()
                );
            }
            for line in new_lines {
                let raw = RawLogLine {
                    path: path.clone(),
                    line,
                };
                if tx.send(raw).await.is_err() {
                    app_log!("WATCHER", "channel closed, stopping");
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::log_reader::{JsonArrayReader, JsonlReader};
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_collect_files_returns_all_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.jsonl"), "{}").unwrap();
        std::fs::write(dir.path().join("session-1.json"), "[]").unwrap();
        std::fs::write(dir.path().join("other.txt"), "").unwrap();

        let files = collect_files(&[dir.path().to_path_buf()]);
        assert_eq!(files.len(), 3);
    }

    #[test]
    fn test_readers_filter_by_can_handle() {
        let dir = tempfile::tempdir().unwrap();
        let jsonl_path = dir.path().join("log.jsonl");
        let json_path = dir.path().join("session-abc.json");
        let txt_path = dir.path().join("other.txt");
        std::fs::write(&jsonl_path, "{\"type\":\"user\"}\n").unwrap();
        std::fs::write(&json_path, r#"[{"type":"user"}]"#).unwrap();
        std::fs::write(&txt_path, "hello").unwrap();

        let mut readers: Vec<Box<dyn LogFileReader>> = vec![
            Box::new(JsonlReader::new()),
            Box::new(JsonArrayReader::new()),
        ];

        // JSONL reader handles .jsonl
        assert!(readers[0].can_handle(&jsonl_path));
        assert!(!readers[0].can_handle(&json_path));
        assert!(!readers[0].can_handle(&txt_path));

        // JSON array reader handles session-*.json
        assert!(!readers[1].can_handle(&jsonl_path));
        assert!(readers[1].can_handle(&json_path));
        assert!(!readers[1].can_handle(&txt_path));

        // Read new lines from each
        let jsonl_lines = readers[0].read_new(&jsonl_path);
        assert_eq!(jsonl_lines.len(), 1);

        let json_msgs = readers[1].read_new(&json_path);
        assert_eq!(json_msgs.len(), 1);
    }

    #[test]
    fn test_seed_skips_existing_content() {
        let mut file = NamedTempFile::with_suffix(".jsonl").unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut reader = JsonlReader::new();
        reader.seed(file.path());

        let lines = reader.read_new(file.path());
        assert!(lines.is_empty());
    }
}
