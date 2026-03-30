// Parser registry — routes log lines to the correct agent parser.
//
// Routing priority:
// 1. Explicit directory binding (longest prefix match)
// 2. Auto-detection fallback via can_parse()
// 3. None if no parser claims the line

use super::parsed_event::ParsedEvent;
use super::parser_trait::AgentLogParser;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A directory-to-parser binding.
#[derive(Clone)]
struct DirectoryBinding {
    path: PathBuf,
    parser_index: usize,
}

/// Routes log lines to the correct parser based on file path or content.
pub struct ParserRegistry {
    parsers: Vec<Arc<dyn AgentLogParser>>,
    bindings: Vec<DirectoryBinding>,
}

impl ParserRegistry {
    pub fn new() -> Self {
        Self {
            parsers: Vec::new(),
            bindings: Vec::new(),
        }
    }

    /// Register a parser. Returns its index for use with `bind_directory`.
    pub fn register_parser(&mut self, parser: Arc<dyn AgentLogParser>) -> usize {
        let index = self.parsers.len();
        app_log!(
            "PARSER_REG",
            "registered parser '{}' at index {}",
            parser.name(),
            index
        );
        self.parsers.push(parser);
        index
    }

    /// Bind a directory prefix to a specific parser.
    /// Log files under this directory will be routed to the bound parser.
    pub fn bind_directory(&mut self, path: PathBuf, parser_index: usize) {
        app_log!(
            "PARSER_REG",
            "bound {:?} → parser index {}",
            path,
            parser_index
        );
        self.bindings.push(DirectoryBinding { path, parser_index });
    }

    /// Derive agent ID from a log file path, delegating to the matched parser.
    /// Uses the same routing logic as `parse_line`: binding → auto-detect → default.
    pub fn path_to_agent_id(&self, path: &Path) -> String {
        // 1. Explicit binding
        if let Some(parser) = self.find_by_binding(path) {
            return parser.path_to_agent_id(path);
        }

        // 2. Auto-detection — read first line for can_parse()
        let first_line = std::fs::read_to_string(path)
            .ok()
            .and_then(|content| content.lines().next().map(|l| l.to_string()))
            .unwrap_or_default();

        for parser in &self.parsers {
            if parser.can_parse(path, &first_line) {
                return parser.path_to_agent_id(path);
            }
        }

        // 3. Fallback: default implementation
        let parent = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let stem = path
            .file_stem()
            .map(|s| {
                let s = s.to_string_lossy();
                if s.len() > 8 {
                    s[..8].to_string()
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_default();
        if stem.is_empty() {
            format!("log-{parent}")
        } else {
            format!("log-{parent}--{stem}")
        }
    }

    /// Get the model hint for a log file path (e.g. "claude", "gemini").
    /// Used by resolve_agent_id to prefer matching agents by model type.
    pub fn model_hint_for_path(&self, path: &Path) -> Option<String> {
        if let Some(parser) = self.find_by_binding(path) {
            return Some(parser.model_hint().to_string());
        }
        None
    }

    /// Get the custom activity timeout for a log file path.
    /// File-activity-based parsers return a shorter timeout than the global default.
    pub fn activity_timeout_for_path(&self, path: &Path) -> Option<u64> {
        self.find_by_binding(path)
            .and_then(|parser| parser.activity_timeout_ms())
    }

    /// Parse a log line, routing to the correct parser.
    ///
    /// 1. Check explicit directory bindings (longest prefix match)
    /// 2. Fall back to auto-detection via `can_parse()`
    /// 3. Return `None` if no parser claims the line
    pub fn parse_line(&self, path: &Path, line: &str) -> Option<ParsedEvent> {
        // 1. Explicit binding — longest prefix match
        if let Some(parser) = self.find_by_binding(path) {
            return parser.parse_line(line);
        }

        // 2. Auto-detection fallback
        for parser in &self.parsers {
            if parser.can_parse(path, line) {
                return parser.parse_line(line);
            }
        }

        // 3. No parser matched
        None
    }

    /// Find parser by directory binding using longest prefix match.
    /// Uses `Path::starts_with()` for platform-agnostic component-level comparison.
    fn find_by_binding(&self, path: &Path) -> Option<&Arc<dyn AgentLogParser>> {
        self.bindings
            .iter()
            .filter(|b| path.starts_with(&b.path))
            .max_by_key(|b| b.path.as_os_str().len())
            .and_then(|b| self.parsers.get(b.parser_index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::log_reader::LogFileReader;
    use crate::models::Status;

    /// A simple test parser that always returns Thinking status.
    struct TestParser {
        parser_name: String,
        detects_prefix: String,
    }

    impl AgentLogParser for TestParser {
        fn name(&self) -> &str {
            &self.parser_name
        }

        fn model_hint(&self) -> &str {
            &self.parser_name
        }

        fn can_parse(&self, path: &Path, _first_line: &str) -> bool {
            path.to_string_lossy().contains(&self.detects_prefix)
        }

        fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
            if line.trim().is_empty() {
                return None;
            }
            Some(ParsedEvent {
                status: Status::Thinking,
                model: Some(self.parser_name.clone()),
                current_task: Some(line.to_string()),
                tokens_in: None,
                tokens_out: None,
                sub_agents: vec![],
                completed_sub_agent_ids: vec![],
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                cwd: None,
            })
        }

        fn log_roots(&self) -> Vec<PathBuf> {
            vec![]
        }

        fn create_reader(&self) -> Box<dyn LogFileReader> {
            Box::new(crate::discovery::log_reader::JsonlReader::new())
        }
    }

    fn make_test_parser(name: &str, prefix: &str) -> Arc<dyn AgentLogParser> {
        Arc::new(TestParser {
            parser_name: name.to_string(),
            detects_prefix: prefix.to_string(),
        })
    }

    /// A parser that only works via explicit binding — never auto-detects.
    struct BindingOnlyParser {
        parser_name: String,
    }

    impl AgentLogParser for BindingOnlyParser {
        fn name(&self) -> &str {
            &self.parser_name
        }

        fn model_hint(&self) -> &str {
            &self.parser_name
        }

        fn can_parse(&self, _path: &Path, _first_line: &str) -> bool {
            false
        }

        fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
            if line.trim().is_empty() {
                return None;
            }
            Some(ParsedEvent {
                status: Status::Thinking,
                model: Some(self.parser_name.clone()),
                current_task: Some(line.to_string()),
                tokens_in: None,
                tokens_out: None,
                sub_agents: vec![],
                completed_sub_agent_ids: vec![],
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                cwd: None,
            })
        }

        fn log_roots(&self) -> Vec<PathBuf> {
            vec![]
        }

        fn create_reader(&self) -> Box<dyn LogFileReader> {
            Box::new(crate::discovery::log_reader::JsonlReader::new())
        }
    }

    #[test]
    fn test_explicit_binding_routes_correctly() {
        let mut reg = ParserRegistry::new();
        let idx = reg.register_parser(make_test_parser("claude", ".claude"));
        reg.bind_directory(PathBuf::from("/home/user/.claude/projects"), idx);

        let path = Path::new("/home/user/.claude/projects/myproj/session.jsonl");
        let result = reg.parse_line(path, "some log line");
        assert!(result.is_some());
        assert_eq!(result.unwrap().model, Some("claude".to_string()));
    }

    #[test]
    fn test_longest_prefix_wins() {
        let mut reg = ParserRegistry::new();
        let idx_generic = reg.register_parser(make_test_parser("generic", ""));
        let idx_specific = reg.register_parser(make_test_parser("specific", ""));
        reg.bind_directory(PathBuf::from("/home/user"), idx_generic);
        reg.bind_directory(PathBuf::from("/home/user/.claude/projects"), idx_specific);

        let path = Path::new("/home/user/.claude/projects/myproj/session.jsonl");
        let result = reg.parse_line(path, "log line");
        assert!(result.is_some());
        assert_eq!(result.unwrap().model, Some("specific".to_string()));
    }

    #[test]
    fn test_auto_detection_fallback() {
        let mut reg = ParserRegistry::new();
        reg.register_parser(make_test_parser("gemini", ".gemini"));

        // No binding — should fall back to can_parse()
        let path = Path::new("/home/user/.gemini/sessions/log.jsonl");
        let result = reg.parse_line(path, "gemini log");
        assert!(result.is_some());
        assert_eq!(result.unwrap().model, Some("gemini".to_string()));
    }

    #[test]
    fn test_no_parser_returns_none() {
        let mut reg = ParserRegistry::new();
        reg.register_parser(make_test_parser("claude", ".claude"));

        let path = Path::new("/home/user/.unknown/log.jsonl");
        let result = reg.parse_line(path, "unknown log");
        assert!(result.is_none());
    }

    #[test]
    fn test_empty_registry_returns_none() {
        let reg = ParserRegistry::new();
        let path = Path::new("/some/path/log.jsonl");
        assert!(reg.parse_line(path, "anything").is_none());
    }

    #[test]
    fn test_binding_does_not_override_auto_detection_for_unbound_path() {
        let mut reg = ParserRegistry::new();
        let claude_idx = reg.register_parser(make_test_parser("claude", ".claude"));
        reg.register_parser(make_test_parser("gemini", ".gemini"));
        reg.bind_directory(PathBuf::from("/home/user/.claude"), claude_idx);

        // Gemini path — not bound, but auto-detectable
        let path = Path::new("/home/user/.gemini/sessions/log.jsonl");
        let result = reg.parse_line(path, "gemini log");
        assert!(result.is_some());
        assert_eq!(result.unwrap().model, Some("gemini".to_string()));
    }

    #[test]
    fn test_binding_with_path_starts_with_component_boundary() {
        let mut reg = ParserRegistry::new();
        // Use BindingOnlyParser to isolate binding logic from auto-detection
        let parser: Arc<dyn AgentLogParser> = Arc::new(BindingOnlyParser {
            parser_name: "bound-parser".to_string(),
        });
        let idx = reg.register_parser(parser);
        reg.bind_directory(PathBuf::from("/home/user/.claude"), idx);

        // Full sub-path — should match via binding
        let path = Path::new("/home/user/.claude/projects/myproj/session.jsonl");
        assert!(reg.parse_line(path, "log line").is_some());

        // Partial directory name — should NOT match (Path::starts_with is component-based)
        let partial = Path::new("/home/user/.claude-backup/log.jsonl");
        assert!(reg.parse_line(partial, "log line").is_none());
    }

    #[test]
    fn test_path_to_agent_id_delegates_to_bound_parser() {
        let mut reg = ParserRegistry::new();
        let idx = reg.register_parser(make_test_parser("claude", ".claude"));
        reg.bind_directory(PathBuf::from("/home/user/.claude/projects"), idx);

        let path = Path::new("/home/user/.claude/projects/myproj/abcdefgh-1234.jsonl");
        let id = reg.path_to_agent_id(path);
        // Delegates to TestParser which uses default trait impl (8-char stem prefix)
        assert_eq!(id, "log-myproj--abcdefgh");
    }

    #[test]
    fn test_path_to_agent_id_fallback_no_parser() {
        let reg = ParserRegistry::new();
        let path = Path::new("/some/unknown/path/file12345678.jsonl");
        let id = reg.path_to_agent_id(path);
        assert_eq!(id, "log-path--file1234");
    }

    #[test]
    fn test_empty_line_returns_none_from_parser() {
        let mut reg = ParserRegistry::new();
        let idx = reg.register_parser(make_test_parser("claude", ".claude"));
        reg.bind_directory(PathBuf::from("/home/user/.claude"), idx);

        let path = Path::new("/home/user/.claude/projects/p/s.jsonl");
        assert!(reg.parse_line(path, "").is_none());
    }

    #[test]
    fn test_activity_timeout_returns_none_for_default_parsers() {
        let mut reg = ParserRegistry::new();
        let idx = reg.register_parser(make_test_parser("claude", ".claude"));
        reg.bind_directory(PathBuf::from("/home/user/.claude"), idx);

        let path = Path::new("/home/user/.claude/projects/p/s.jsonl");
        assert_eq!(reg.activity_timeout_for_path(path), None);
    }

    #[test]
    fn test_activity_timeout_returns_none_for_unbound_path() {
        let reg = ParserRegistry::new();
        let path = Path::new("/some/unknown/path/file.jsonl");
        assert_eq!(reg.activity_timeout_for_path(path), None);
    }
}
