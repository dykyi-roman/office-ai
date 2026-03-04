// Generic CLI parser for unknown agent types
// Heuristic-based state detection from output patterns and timing

use crate::models::Status;
use regex::Regex;
use std::time::{Duration, Instant};

/// Thinking threshold: more than 2s of silence → Thinking
const THINKING_PAUSE_SECS: u64 = 2;

/// Keywords that indicate task completion
const COMPLETION_KEYWORDS: &[&str] = &["done", "complete", "finished", "success"];

/// Keywords that indicate an error
const ERROR_KEYWORDS: &[&str] = &["error", "failed", "failure", "fatal", "panic", "exception"];

/// Tool-use patterns: command in backticks or shell-like invocations
const TOOL_PATTERNS: &[&str] = &[
    r"`[^`]+`",
    r"\$\s*\w+",
    r"Running\s+\w+",
    r"Executing\s+\w+",
];

/// Per-agent state tracked by the generic parser
#[derive(Debug, Clone)]
pub struct CliParserState {
    pub last_output: Instant,
    pub status: Status,
}

impl Default for CliParserState {
    fn default() -> Self {
        Self {
            last_output: Instant::now(),
            status: Status::Idle,
        }
    }
}

/// Detect if output contains tool-use patterns.
pub fn is_tool_use(output: &str, extra_patterns: &[&str]) -> bool {
    let all: Vec<&str> = TOOL_PATTERNS
        .iter()
        .copied()
        .chain(extra_patterns.iter().copied())
        .collect();

    for pattern in &all {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(output) {
                return true;
            }
        }
    }
    false
}

/// Detect if output contains error keywords.
pub fn is_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    ERROR_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

/// Detect if output contains completion keywords.
pub fn is_complete(output: &str) -> bool {
    let lower = output.to_lowercase();
    COMPLETION_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

/// Classify status from a text output chunk.
/// Does NOT consider time-based thinking detection.
pub fn classify_output(output: &str, extra_tool_patterns: &[&str]) -> Status {
    if output.trim().is_empty() {
        return Status::Idle;
    }
    if is_error(output) {
        return Status::Error;
    }
    if is_complete(output) {
        return Status::TaskComplete;
    }
    if is_tool_use(output, extra_tool_patterns) {
        return Status::ToolUse;
    }
    Status::Responding
}

/// Update parser state given new output.
/// If output is None (no new output), checks if thinking threshold was exceeded.
pub fn update_state(
    state: &mut CliParserState,
    output: Option<&str>,
    extra_tool_patterns: &[&str],
) -> Status {
    match output {
        Some(text) if !text.trim().is_empty() => {
            state.last_output = Instant::now();
            let new_status = classify_output(text, extra_tool_patterns);
            state.status = new_status.clone();
            new_status
        }
        _ => {
            // No output received — check if the pause is long enough
            let silence = state.last_output.elapsed();
            if silence >= Duration::from_secs(THINKING_PAUSE_SECS) {
                state.status = Status::Thinking;
                Status::Thinking
            } else {
                state.status.clone()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generic_parser_responding() {
        let status = classify_output("Processing your request...", &[]);
        assert_eq!(status, Status::Responding);
    }

    #[test]
    fn test_generic_parser_error() {
        let status = classify_output("Error: file not found", &[]);
        assert_eq!(status, Status::Error);
    }

    #[test]
    fn test_generic_parser_error_case_insensitive() {
        let status = classify_output("ERROR: connection refused", &[]);
        assert_eq!(status, Status::Error);
    }

    #[test]
    fn test_generic_parser_complete() {
        let status = classify_output("Task complete. All done.", &[]);
        assert_eq!(status, Status::TaskComplete);
    }

    #[test]
    fn test_generic_parser_tool_use_backtick() {
        let status = classify_output("Running `cargo build`...", &[]);
        assert_eq!(status, Status::ToolUse);
    }

    #[test]
    fn test_generic_parser_tool_use_executing() {
        let status = classify_output("Executing git status", &[]);
        assert_eq!(status, Status::ToolUse);
    }

    #[test]
    fn test_generic_parser_empty_output_is_idle() {
        let status = classify_output("", &[]);
        assert_eq!(status, Status::Idle);
    }

    #[test]
    fn test_generic_parser_thinking_after_long_pause() {
        let mut state = CliParserState {
            last_output: Instant::now() - Duration::from_secs(3),
            status: Status::Idle,
        };
        let status = update_state(&mut state, None, &[]);
        assert_eq!(status, Status::Thinking);
    }

    #[test]
    fn test_generic_parser_no_thinking_short_pause() {
        let mut state = CliParserState::default();
        // Immediately after creation — elapsed is < 2s
        let status = update_state(&mut state, None, &[]);
        // Should stay at Idle (not enough time passed)
        assert_eq!(status, Status::Idle);
    }

    #[test]
    fn test_update_state_with_output() {
        let mut state = CliParserState::default();
        let status = update_state(&mut state, Some("Processing..."), &[]);
        assert_eq!(status, Status::Responding);
        assert!(matches!(state.status, Status::Responding));
    }

    #[test]
    fn test_extra_tool_pattern() {
        let extra = &["deploy.*prod"];
        assert!(is_tool_use("deploy to prod now", extra));
    }

    #[test]
    fn test_is_error_variants() {
        assert!(is_error("Fatal: out of memory"));
        assert!(is_error("Panic: stack overflow"));
        assert!(is_error("Exception: NullPointerException"));
        assert!(!is_error("All good here"));
    }
}
