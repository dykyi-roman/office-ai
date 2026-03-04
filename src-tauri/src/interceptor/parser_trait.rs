// Trait for pluggable agent log parsers.
// Each AI agent (Claude Code, Gemini CLI, etc.) implements this trait
// to translate its log format into a common ParsedEvent.

use super::parsed_event::ParsedEvent;
use std::path::Path;

/// A pluggable parser for a specific AI agent's log format.
///
/// Implementations must be thread-safe (`Send + Sync`) because
/// the parser registry is shared across async tasks.
pub trait AgentLogParser: Send + Sync {
    /// Human-readable parser name for logging (e.g. "claude-code", "gemini-cli").
    fn name(&self) -> &str;

    /// Check if this parser can handle the given log file.
    /// Called during auto-detection when no explicit directory binding exists.
    ///
    /// - `path`: the JSONL/log file path
    /// - `first_line`: the first non-empty line of the file (for format sniffing)
    fn can_parse(&self, path: &Path, first_line: &str) -> bool;

    /// Parse a single log line into a ParsedEvent.
    /// Returns `None` if the line is irrelevant, malformed, or not parseable.
    fn parse_line(&self, line: &str) -> Option<ParsedEvent>;
}
