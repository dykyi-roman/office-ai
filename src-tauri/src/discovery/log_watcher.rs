// Log file watcher using polling
// Monitors ~/.claude/projects/*/*.jsonl for new log lines every 500ms

use crate::error::AppError;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

/// Polling interval for checking JSONL file changes
const POLL_INTERVAL_MS: u64 = 500;

/// A raw log line read from a JSONL file, with the source file path.
#[derive(Debug, Clone)]
pub struct RawLogLine {
    pub path: PathBuf,
    pub line: String,
}

/// Tracks read positions per file to avoid re-reading old content.
type FilePositions = HashMap<PathBuf, u64>;

/// Read all new lines from `path` since the last recorded position.
/// Handles file rotation: if the file shrank, reset position to 0.
pub fn read_new_lines(path: &Path, positions: &mut FilePositions) -> Vec<String> {
    let stored_pos = positions.get(path).copied().unwrap_or(0);

    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let metadata = match file.metadata() {
        Ok(m) => m,
        Err(_) => return vec![],
    };

    let file_size = metadata.len();

    // File was rotated (shrunk or replaced) — read from start
    // No new content — skip
    let seek_pos = if file_size < stored_pos {
        app_log!(
            "WATCHER",
            "file rotated: {:?} (size {} < stored pos {})",
            path.file_name(),
            file_size,
            stored_pos
        );
        0
    } else if file_size == stored_pos {
        return vec![];
    } else {
        stored_pos
    };

    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(seek_pos)).is_err() {
        return vec![];
    }

    let mut lines = Vec::new();
    let mut current_pos = seek_pos;

    for line_result in reader.lines() {
        match line_result {
            Ok(line) => {
                current_pos += line.len() as u64 + 1; // +1 for newline
                if !line.trim().is_empty() {
                    lines.push(line);
                }
            }
            Err(_) => break,
        }
    }

    positions.insert(path.to_path_buf(), current_pos);
    lines
}

/// Resolve root directories into concrete project subdirectories.
/// Each root is expanded to all its child directories (one level deep),
/// e.g. `~/.claude/projects/` → `~/.claude/projects/-Users-me-myproject/`, etc.
fn resolve_log_dirs(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for root in roots {
        if !root.exists() {
            app_log!("WATCHER", "{:?} not found, skipping", root);
            continue;
        }

        let read_dir = match std::fs::read_dir(root) {
            Ok(rd) => rd,
            Err(e) => {
                app_log!("WATCHER", "failed to read {:?}: {}", root, e);
                continue;
            }
        };

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            }
        }
    }

    dirs
}

/// Collect all JSONL file paths from the watched directories.
fn collect_jsonl_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "jsonl").unwrap_or(false) && path.is_file() {
                    files.push(path);
                }
            }
        }
    }
    files
}

/// Seed positions to the current file sizes so we skip existing content on startup.
fn seed_positions(positions: &mut FilePositions, files: &[PathBuf]) {
    for path in files {
        if let Ok(meta) = std::fs::metadata(path) {
            positions.insert(path.clone(), meta.len());
        }
    }
    app_log!(
        "WATCHER",
        "seeded {} existing JSONL file positions",
        positions.len()
    );
}

/// Start the log watcher as a background Tokio task.
/// Polls JSONL files every 500ms for new lines.
///
/// `log_roots` — root directories to scan for project subdirectories (e.g. `~/.claude/projects`).
/// `custom_paths` — additional directories to watch directly (not expanded).
pub async fn run_log_watcher(
    log_roots: Vec<PathBuf>,
    custom_paths: Vec<PathBuf>,
    tx: mpsc::Sender<RawLogLine>,
) -> Result<(), AppError> {
    let mut positions: FilePositions = HashMap::new();

    // Resolve watched directories from configurable roots
    let mut watch_dirs = resolve_log_dirs(&log_roots);
    for p in &custom_paths {
        if p.exists() && p.is_dir() {
            watch_dirs.push(p.clone());
        }
    }

    app_log!("WATCHER", "polling {} project dirs", watch_dirs.len());
    for dir in &watch_dirs {
        app_log!("WATCHER", "dir: {:?}", dir.file_name());
    }

    // Seed existing file positions (skip old content)
    let initial_files = collect_jsonl_files(&watch_dirs);
    seed_positions(&mut positions, &initial_files);

    // Poll loop
    let mut ticker = interval(Duration::from_millis(POLL_INTERVAL_MS));
    loop {
        ticker.tick().await;

        let files = collect_jsonl_files(&watch_dirs);
        for path in &files {
            let new_lines = read_new_lines(path, &mut positions);
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
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_read_new_lines_basic() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.write_all(b"{\"type\":\"assistant\"}\n").unwrap();
        file.flush().unwrap();

        let mut positions = HashMap::new();
        let lines = read_new_lines(file.path(), &mut positions);

        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("user"));
        assert!(lines[1].contains("assistant"));
    }

    #[test]
    fn test_read_new_lines_incremental() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut positions = HashMap::new();

        let lines1 = read_new_lines(file.path(), &mut positions);
        assert_eq!(lines1.len(), 1);

        file.write_all(b"{\"type\":\"assistant\"}\n").unwrap();
        file.flush().unwrap();

        let lines2 = read_new_lines(file.path(), &mut positions);
        assert_eq!(lines2.len(), 1);
        assert!(lines2[0].contains("assistant"));
    }

    #[test]
    fn test_log_watcher_handles_rotation() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut positions = HashMap::new();
        let _ = read_new_lines(file.path(), &mut positions);

        let pos_before = *positions.get(file.path()).unwrap_or(&0);
        assert!(pos_before > 0);

        // Simulate rotation: truncate and write shorter content so file_size < stored_pos
        let new_file = File::create(file.path()).unwrap();
        let mut writer = std::io::BufWriter::new(new_file);
        writer.write_all(b"{\"t\":\"e\"}\n").unwrap();
        writer.flush().unwrap();

        let lines = read_new_lines(file.path(), &mut positions);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("e"));
    }

    #[test]
    fn test_read_new_lines_empty_file() {
        let file = NamedTempFile::new().unwrap();
        let mut positions = HashMap::new();
        let lines = read_new_lines(file.path(), &mut positions);
        assert!(lines.is_empty());
    }

    #[test]
    fn test_read_nonexistent_file() {
        let mut positions = HashMap::new();
        let path = PathBuf::from("/tmp/this_file_does_not_exist_12345.jsonl");
        let lines = read_new_lines(&path, &mut positions);
        assert!(lines.is_empty());
    }

    #[test]
    fn test_no_change_returns_empty() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut positions = HashMap::new();
        let _ = read_new_lines(file.path(), &mut positions);

        // Second read with no changes
        let lines = read_new_lines(file.path(), &mut positions);
        assert!(lines.is_empty());
    }
}
