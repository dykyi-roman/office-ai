// Trait for pluggable agent log parsers.
// Each AI agent (Claude Code, Gemini CLI, etc.) implements this trait
// to translate its log format into a common ParsedEvent.

use super::parsed_event::ParsedEvent;
use crate::discovery::log_reader::LogFileReader;
use std::path::{Path, PathBuf};

/// A pluggable parser for a specific AI agent's log format.
///
/// Implementations must be thread-safe (`Send + Sync`) because
/// the parser registry is shared across async tasks.
///
/// Each parser is a self-contained unit that encapsulates:
/// - Log format knowledge (parse_line, can_parse)
/// - Agent ID derivation (path_to_agent_id)
/// - Directory discovery (log_roots, resolve_log_dirs)
/// - File reader creation (create_reader)
pub trait AgentLogParser: Send + Sync {
    /// Human-readable parser name for logging (e.g. "claude-code", "gemini-cli").
    fn name(&self) -> &str;

    /// Model hint for agent-log correlation (e.g. "claude", "gemini").
    /// Used by resolve_agent_id to prefer pid-agents whose model matches
    /// the log source when multiple agents share the same CWD.
    fn model_hint(&self) -> &str;

    /// Check if this parser can handle the given log file.
    /// Called during auto-detection when no explicit directory binding exists.
    ///
    /// - `path`: the JSONL/log file path
    /// - `first_line`: the first non-empty line of the file (for format sniffing)
    fn can_parse(&self, path: &Path, first_line: &str) -> bool;

    /// Parse a single log line into a ParsedEvent.
    /// Returns `None` if the line is irrelevant, malformed, or not parseable.
    fn parse_line(&self, line: &str) -> Option<ParsedEvent>;

    /// Derive a unique agent ID from a log file path.
    /// Default: `log-<parent_dir>--<stem_prefix_8chars>`
    fn path_to_agent_id(&self, path: &Path) -> String {
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

    /// Root directories to scan for log files (e.g. `~/.claude/projects`).
    fn log_roots(&self) -> Vec<PathBuf>;

    /// Resolve a root directory into concrete project subdirectories.
    /// Default: expand one level deep (all child directories).
    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if !root.exists() {
            return dirs;
        }
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                }
            }
        }
        dirs
    }

    /// Create a file reader for this parser's log format.
    fn create_reader(&self) -> Box<dyn LogFileReader>;

    /// Custom auto-idle timeout in milliseconds for work statuses (Thinking/ToolUse).
    /// File-activity-based parsers (Windsurf, Cursor) override this with a shorter
    /// timeout (~15s) because they cannot detect task completion — only activity start.
    /// Returns `None` to use the global `work_timeout_ms` from StateClassifier.
    fn activity_timeout_ms(&self) -> Option<u64> {
        None
    }
}
