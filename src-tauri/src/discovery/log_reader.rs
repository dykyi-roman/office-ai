// Log file reader abstraction
// Encapsulates format-specific file reading logic (JSONL, JSON-array, etc.)
// Each AI agent parser creates the appropriate reader via `create_reader()`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Abstraction for reading new content from log files.
/// Each implementation handles a specific file format (JSONL, JSON-array, etc.).
pub trait LogFileReader: Send {
    /// Check if this reader can handle the given file path.
    fn can_handle(&self, path: &Path) -> bool;

    /// Read new content since the last call. Returns raw message strings.
    fn read_new(&mut self, path: &Path) -> Vec<String>;

    /// Seed position to skip existing content on startup.
    fn seed(&mut self, path: &Path);
}

/// Reads JSONL files line-by-line, tracking byte positions per file.
/// Used by Claude Code logs (`~/.claude/projects/*/*.jsonl`).
pub struct JsonlReader {
    positions: HashMap<PathBuf, u64>,
}

impl JsonlReader {
    pub fn new() -> Self {
        Self {
            positions: HashMap::new(),
        }
    }
}

impl LogFileReader for JsonlReader {
    fn can_handle(&self, path: &Path) -> bool {
        path.extension().and_then(|e| e.to_str()) == Some("jsonl")
    }

    fn read_new(&mut self, path: &Path) -> Vec<String> {
        read_new_lines(path, &mut self.positions)
    }

    fn seed(&mut self, path: &Path) {
        if let Ok(meta) = std::fs::metadata(path) {
            self.positions.insert(path.to_path_buf(), meta.len());
        }
    }
}

/// Reads JSON-array session files, tracking message counts per file.
/// Used by Gemini CLI logs (`~/.gemini/tmp/*/chats/session-*.json`).
pub struct JsonArrayReader {
    message_counts: HashMap<PathBuf, (usize, u64)>,
}

impl JsonArrayReader {
    pub fn new() -> Self {
        Self {
            message_counts: HashMap::new(),
        }
    }
}

impl LogFileReader for JsonArrayReader {
    fn can_handle(&self, path: &Path) -> bool {
        let is_json = path.extension().and_then(|e| e.to_str()) == Some("json");
        if !is_json {
            return false;
        }
        path.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| name.starts_with("session-"))
    }

    fn read_new(&mut self, path: &Path) -> Vec<String> {
        read_new_json_messages(path, &mut self.message_counts)
    }

    fn seed(&mut self, path: &Path) {
        if let Ok(meta) = std::fs::metadata(path) {
            let count = std::fs::read_to_string(path)
                .ok()
                .map(|content| extract_messages_from_json(&content, path).len())
                .unwrap_or(0);
            self.message_counts
                .insert(path.to_path_buf(), (count, meta.len()));
        }
    }
}

/// Read all new lines from a JSONL file since the last recorded position.
/// Handles file rotation: if the file shrank, reset position to 0.
fn read_new_lines(path: &Path, positions: &mut HashMap<PathBuf, u64>) -> Vec<String> {
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
                current_pos += line.len() as u64 + 1;
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

/// Read new messages from a JSON session file.
/// Supports two formats:
/// - JSON array: `[{msg1}, {msg2}, ...]`
/// - JSON object with messages field: `{"messages": [{msg1}, {msg2}, ...], ...}`
///
/// Tracks message count + file size to skip unchanged files.
fn read_new_json_messages(
    path: &Path,
    message_counts: &mut HashMap<PathBuf, (usize, u64)>,
) -> Vec<String> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let metadata = match file.metadata() {
        Ok(m) => m,
        Err(_) => return vec![],
    };

    let file_size = metadata.len();
    let (prev_count, prev_size) = message_counts.get(path).copied().unwrap_or((0, 0));

    if file_size == prev_size && prev_count > 0 {
        return vec![];
    }

    let base_count = if file_size < prev_size {
        app_log!(
            "WATCHER",
            "JSON file rotated: {:?} (size {} < prev {})",
            path.file_name(),
            file_size,
            prev_size
        );
        0
    } else {
        prev_count
    };

    let mut reader = BufReader::new(file);
    let mut content = String::new();
    if reader.read_to_string(&mut content).is_err() {
        return vec![];
    }

    let messages = extract_messages_from_json(&content, path);

    let total = messages.len();
    if total <= base_count {
        message_counts.insert(path.to_path_buf(), (total, file_size));
        return vec![];
    }

    let new_messages: Vec<String> = messages[base_count..]
        .iter()
        .filter_map(|msg| serde_json::to_string(msg).ok())
        .collect();

    message_counts.insert(path.to_path_buf(), (total, file_size));
    new_messages
}

/// Extract messages array from JSON content.
/// Handles both plain array `[...]` and wrapped object `{"messages": [...]}`.
fn extract_messages_from_json(content: &str, path: &Path) -> Vec<serde_json::Value> {
    // Try plain array first
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(content) {
        return arr;
    }

    // Try object with "messages" field (Gemini CLI new format)
    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(messages) = obj.get("messages").and_then(|m| m.as_array()) {
            return messages.clone();
        }
    }

    app_log!(
        "WATCHER",
        "JSON parse error for {:?}: not an array and no 'messages' field found",
        path.file_name()
    );
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    // --- JsonlReader tests ---

    #[test]
    fn test_jsonl_reader_can_handle() {
        let reader = JsonlReader::new();
        assert!(reader.can_handle(Path::new("/path/to/file.jsonl")));
        assert!(!reader.can_handle(Path::new("/path/to/file.json")));
        assert!(!reader.can_handle(Path::new("/path/to/file.txt")));
    }

    #[test]
    fn test_jsonl_reader_read_new_basic() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.write_all(b"{\"type\":\"assistant\"}\n").unwrap();
        file.flush().unwrap();

        let mut reader = JsonlReader::new();
        let lines = reader.read_new(file.path());
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("user"));
        assert!(lines[1].contains("assistant"));
    }

    #[test]
    fn test_jsonl_reader_incremental() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut reader = JsonlReader::new();
        let lines1 = reader.read_new(file.path());
        assert_eq!(lines1.len(), 1);

        file.write_all(b"{\"type\":\"assistant\"}\n").unwrap();
        file.flush().unwrap();

        let lines2 = reader.read_new(file.path());
        assert_eq!(lines2.len(), 1);
        assert!(lines2[0].contains("assistant"));
    }

    #[test]
    fn test_jsonl_reader_seed_skips_existing() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut reader = JsonlReader::new();
        reader.seed(file.path());

        let lines = reader.read_new(file.path());
        assert!(lines.is_empty());
    }

    #[test]
    fn test_jsonl_reader_handles_rotation() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut reader = JsonlReader::new();
        let _ = reader.read_new(file.path());

        let new_file = File::create(file.path()).unwrap();
        let mut writer = std::io::BufWriter::new(new_file);
        writer.write_all(b"{\"t\":\"e\"}\n").unwrap();
        writer.flush().unwrap();

        let lines = reader.read_new(file.path());
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("e"));
    }

    #[test]
    fn test_jsonl_reader_empty_file() {
        let file = NamedTempFile::new().unwrap();
        let mut reader = JsonlReader::new();
        let lines = reader.read_new(file.path());
        assert!(lines.is_empty());
    }

    #[test]
    fn test_jsonl_reader_no_change() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"{\"type\":\"user\"}\n").unwrap();
        file.flush().unwrap();

        let mut reader = JsonlReader::new();
        let _ = reader.read_new(file.path());

        let lines = reader.read_new(file.path());
        assert!(lines.is_empty());
    }

    // --- JsonArrayReader tests ---

    #[test]
    fn test_json_array_reader_can_handle() {
        let reader = JsonArrayReader::new();
        assert!(reader.can_handle(Path::new("/path/to/session-abc.json")));
        assert!(!reader.can_handle(Path::new("/path/to/logs.json")));
        assert!(!reader.can_handle(Path::new("/path/to/file.jsonl")));
        assert!(!reader.can_handle(Path::new("/path/to/file.txt")));
    }

    #[test]
    fn test_json_array_reader_read_new_basic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-abc.json");
        std::fs::write(
            &path,
            r#"[{"type":"user","text":"hello"},{"type":"gemini","text":"hi"}]"#,
        )
        .unwrap();

        let mut reader = JsonArrayReader::new();
        let msgs = reader.read_new(&path);
        assert_eq!(msgs.len(), 2);
        assert!(msgs[0].contains("user"));
        assert!(msgs[1].contains("gemini"));
    }

    #[test]
    fn test_json_array_reader_read_new_wrapped_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-wrapped.json");
        std::fs::write(
            &path,
            r#"{"sessionId":"abc","messages":[{"type":"user","content":[{"text":"Hi"}]},{"type":"gemini","content":"Hello!"}]}"#,
        )
        .unwrap();

        let mut reader = JsonArrayReader::new();
        let msgs = reader.read_new(&path);
        assert_eq!(msgs.len(), 2);
        assert!(msgs[0].contains("user"));
        assert!(msgs[1].contains("gemini"));
    }

    #[test]
    fn test_json_array_reader_incremental() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-inc.json");

        std::fs::write(
            &path,
            r#"[{"type":"user","text":"q1"},{"type":"gemini","text":"a1"}]"#,
        )
        .unwrap();

        let mut reader = JsonArrayReader::new();
        let msgs1 = reader.read_new(&path);
        assert_eq!(msgs1.len(), 2);

        std::fs::write(
            &path,
            r#"[{"type":"user","text":"q1"},{"type":"gemini","text":"a1"},{"type":"user","text":"q2"}]"#,
        )
        .unwrap();

        let msgs2 = reader.read_new(&path);
        assert_eq!(msgs2.len(), 1);
        assert!(msgs2[0].contains("q2"));
    }

    #[test]
    fn test_json_array_reader_incremental_wrapped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-incw.json");

        std::fs::write(
            &path,
            r#"{"messages":[{"type":"user","content":"q1"},{"type":"gemini","content":"a1"}]}"#,
        )
        .unwrap();

        let mut reader = JsonArrayReader::new();
        let msgs1 = reader.read_new(&path);
        assert_eq!(msgs1.len(), 2);

        std::fs::write(
            &path,
            r#"{"messages":[{"type":"user","content":"q1"},{"type":"gemini","content":"a1"},{"type":"user","content":"q2"}]}"#,
        )
        .unwrap();

        let msgs2 = reader.read_new(&path);
        assert_eq!(msgs2.len(), 1);
        assert!(msgs2[0].contains("q2"));
    }

    #[test]
    fn test_json_array_reader_seed_skips_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-seed.json");
        std::fs::write(&path, r#"[{"type":"user","text":"hello"}]"#).unwrap();

        let mut reader = JsonArrayReader::new();
        reader.seed(&path);

        let msgs = reader.read_new(&path);
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_json_array_reader_seed_wrapped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-seedw.json");
        std::fs::write(&path, r#"{"messages":[{"type":"user","content":"hello"}]}"#).unwrap();

        let mut reader = JsonArrayReader::new();
        reader.seed(&path);

        let msgs = reader.read_new(&path);
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_json_array_reader_no_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-nc.json");
        std::fs::write(&path, r#"[{"type":"user","text":"hello"}]"#).unwrap();

        let mut reader = JsonArrayReader::new();
        let _ = reader.read_new(&path);

        let msgs = reader.read_new(&path);
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_json_array_reader_file_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-rot.json");

        std::fs::write(
            &path,
            r#"[{"type":"user","text":"long message here"},{"type":"gemini","text":"long response"}]"#,
        )
        .unwrap();

        let mut reader = JsonArrayReader::new();
        let _ = reader.read_new(&path);

        std::fs::write(&path, r#"[{"type":"user","text":"new"}]"#).unwrap();

        let msgs = reader.read_new(&path);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].contains("new"));
    }
}
