// File activity reader — monitors file modification timestamps.
// Used for GUI-based AI agents (Cursor, Windsurf) that store data
// in proprietary formats (SQLite, Protobuf) instead of readable logs.
// Emits synthetic activity events when monitored files are modified.

use super::log_reader::LogFileReader;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A LogFileReader that detects activity by monitoring file modification times.
/// Instead of reading file content, it checks `mtime` changes and emits
/// synthetic JSON events that downstream parsers convert into `ParsedEvent`.
pub struct FileActivityReader {
    /// Tracked modification times per file
    mtimes: HashMap<PathBuf, SystemTime>,
    /// Label for the source (e.g. "cursor", "windsurf") included in synthetic events
    source_label: String,
    /// Path components to match in `can_handle()` (e.g. ".cursor", ".codeium")
    path_markers: Vec<String>,
}

impl FileActivityReader {
    pub fn new(source_label: &str, path_markers: Vec<String>) -> Self {
        Self {
            mtimes: HashMap::new(),
            source_label: source_label.to_string(),
            path_markers,
        }
    }
}

impl LogFileReader for FileActivityReader {
    fn can_handle(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy();
        self.path_markers.iter().any(|m| path_str.contains(m))
    }

    fn read_new(&mut self, path: &Path) -> Vec<String> {
        let current_mtime = match std::fs::metadata(path).and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => return vec![],
        };

        let prev = self.mtimes.get(path);
        if prev.is_some_and(|&prev| current_mtime <= prev) {
            return vec![];
        }

        self.mtimes.insert(path.to_path_buf(), current_mtime);

        let timestamp = chrono::Utc::now().to_rfc3339();
        vec![format!(
            r#"{{"type":"activity","source":"{}","timestamp":"{}"}}"#,
            self.source_label, timestamp
        )]
    }

    fn seed(&mut self, path: &Path) {
        if let Ok(meta) = std::fs::metadata(path) {
            if let Ok(mtime) = meta.modified() {
                self.mtimes.insert(path.to_path_buf(), mtime);
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
    fn test_can_handle_cursor() {
        let reader = FileActivityReader::new("cursor", vec![".cursor".to_string()]);
        assert!(reader.can_handle(Path::new("/home/user/.cursor/ai-tracking/db.sqlite")));
        assert!(!reader.can_handle(Path::new("/home/user/.claude/projects/test.jsonl")));
    }

    #[test]
    fn test_can_handle_windsurf() {
        let reader = FileActivityReader::new("windsurf", vec![".codeium".to_string()]);
        assert!(reader.can_handle(Path::new("/home/user/.codeium/cascade/abc.pb")));
        assert!(reader.can_handle(Path::new("/home/user/.codeium/windsurf/cascade/abc.pb")));
        assert!(!reader.can_handle(Path::new("/home/user/.cursor/plans/test.md")));
    }

    #[test]
    fn test_seed_skips_existing() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"data").unwrap();
        file.flush().unwrap();

        let mut reader = FileActivityReader::new("test", vec!["tmp".to_string()]);
        reader.seed(file.path());

        let events = reader.read_new(file.path());
        assert!(events.is_empty());
    }

    #[test]
    fn test_emits_activity_on_mtime_change() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"initial").unwrap();
        file.flush().unwrap();

        let mut reader = FileActivityReader::new("cursor", vec!["tmp".to_string()]);
        // First read — no previous mtime, should emit
        let events = reader.read_new(file.path());
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("\"type\":\"activity\""));
        assert!(events[0].contains("\"source\":\"cursor\""));

        // Second read — no change, should be empty
        let events = reader.read_new(file.path());
        assert!(events.is_empty());

        // Modify file — should emit again
        std::thread::sleep(std::time::Duration::from_millis(50));
        file.write_all(b"modified").unwrap();
        file.flush().unwrap();

        let events = reader.read_new(file.path());
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("\"source\":\"cursor\""));
    }

    #[test]
    fn test_nonexistent_file() {
        let mut reader = FileActivityReader::new("test", vec!["tmp".to_string()]);
        let events = reader.read_new(Path::new("/nonexistent/path/file.db"));
        assert!(events.is_empty());
    }
}
