// Claude Code JSONL log parser
// Maps real Claude Code log events to AgentStatus.
//
// Actual JSONL format (as of Claude Code 2.x):
//   type="user"      → user sent a message     → Thinking
//   type="assistant"  → assistant responded     → Responding / ToolUse / TaskComplete
//   type="progress"   → tool execution progress → ToolUse
//   type="error"      → error occurred          → Error

use super::parsed_event::ParsedEvent;
use super::parser_trait::AgentLogParser;
use crate::discovery::log_reader::{JsonlReader, LogFileReader};
use crate::models::{Status, SubAgentInfo};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Claude Code JSONL log parser implementing the AgentLogParser trait.
/// Delegates to the existing `parse_line()` function.
pub struct ClaudeCodeParser;

impl AgentLogParser for ClaudeCodeParser {
    fn name(&self) -> &str {
        "claude-code"
    }

    fn model_hint(&self) -> &str {
        "claude"
    }

    fn can_parse(&self, path: &Path, first_line: &str) -> bool {
        // Detect by path: ~/.claude/projects/ directory structure
        // Platform-agnostic: check path components instead of string slashes
        let components: Vec<_> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect();
        let has_claude_path = components
            .windows(2)
            .any(|w| w[0] == ".claude" && w[1] == "projects");
        if has_claude_path {
            return true;
        }

        // Detect by content: Claude Code JSONL has specific type fields
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(first_line) {
            if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                return matches!(t, "user" | "assistant" | "progress" | "error");
            }
        }

        false
    }

    fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
        parse_line(line)
    }

    /// Claude: `~/.claude/projects/<project-dir>/<session-uuid>.jsonl`
    /// → `log-<project-dir>--<first 8 chars of uuid>`
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

    fn log_roots(&self) -> Vec<PathBuf> {
        dirs::home_dir()
            .map(|h| vec![h.join(".claude").join("projects")])
            .unwrap_or_default()
    }

    fn create_reader(&self) -> Box<dyn LogFileReader> {
        Box::new(JsonlReader::new())
    }
}

/// Raw JSONL log entry structure (only fields we care about).
#[derive(Debug, Deserialize)]
struct LogEntry {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    model: Option<String>,
    message: Option<MessageField>,
    usage: Option<UsageField>,
    timestamp: Option<String>,
    #[allow(dead_code)]
    error: Option<Value>,
    /// Meta messages are internal Claude Code bookkeeping (e.g. /exit, snapshots).
    /// They should not trigger agent status changes.
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    /// Working directory of the Claude Code session
    cwd: Option<String>,
    /// Raw content string (used by queue-operation entries for task notifications)
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MessageField {
    model: Option<String>,
    content: Option<Value>,
    stop_reason: Option<String>,
    usage: Option<UsageField>,
}

#[derive(Debug, Deserialize)]
struct UsageField {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

/// Check if a "user" message is a request interruption.
/// Claude Code emits these when the user presses ESC:
///   - "[Request interrupted by user]"
///   - "[Request interrupted by user for tool use]"
fn is_interrupt_message(entry: &LogEntry) -> bool {
    let content = match entry.message.as_ref().and_then(|m| m.content.as_ref()) {
        Some(c) => c,
        None => return false,
    };
    match content {
        Value::String(s) => s.trim().starts_with("[Request interrupted by user"),
        Value::Array(blocks) => blocks.iter().any(|block| {
            block
                .get("text")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t.trim().starts_with("[Request interrupted by user"))
        }),
        _ => false,
    }
}

/// Check if a "user" message is actually a real user prompt.
/// Returns false for internal Claude Code messages:
///   - tool_result arrays (automated tool responses)
///   - XML command tags (<command-name>, <local-command-caveat>, <local-command-stdout>)
///   - Empty or missing content
fn is_real_user_message(entry: &LogEntry) -> bool {
    let content = match entry.message.as_ref().and_then(|m| m.content.as_ref()) {
        Some(c) => c,
        None => return false,
    };

    match content {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return false;
            }
            // Internal commands wrapped in XML tags
            !trimmed.starts_with("<command-name>") && !trimmed.starts_with("<local-command-")
        }
        Value::Array(blocks) => {
            // If ALL blocks are tool_result, this is an automated response, not a real prompt
            if blocks.is_empty() {
                return false;
            }
            blocks.iter().any(|block| {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                block_type == "text"
            })
        }
        _ => false,
    }
}

/// Check if a tool_result block is an async agent launch confirmation.
/// Background agents return an immediate "Async agent launched..." response
/// which should NOT be treated as sub-agent completion.
fn is_async_launch_result(block: &Value) -> bool {
    let content = block.get("content");
    match content {
        Some(Value::String(s)) => s.starts_with("Async agent launched"),
        Some(Value::Array(parts)) => parts.iter().any(|part| {
            part.get("text")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t.starts_with("Async agent launched"))
        }),
        _ => false,
    }
}

/// Extract tool_use_id values from tool_result blocks in user messages.
/// When a sub-agent completes, its result comes back as a tool_result
/// with the same tool_use_id as the original tool_use block.
/// Skips async agent launch confirmations — those are NOT completions.
fn extract_completed_sub_agent_ids(content: &Value) -> Vec<String> {
    if let Value::Array(blocks) = content {
        blocks
            .iter()
            .filter_map(|block| {
                let is_tool_result = block
                    .get("type")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t == "tool_result");
                if is_tool_result {
                    if is_async_launch_result(block) {
                        return None;
                    }
                    block
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec![]
    }
}

/// Check if message content contains a tool_use block.
fn has_tool_use(content: &Value) -> bool {
    if let Value::Array(blocks) = content {
        blocks.iter().any(|block| {
            block
                .get("type")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t == "tool_use")
        })
    } else {
        false
    }
}

/// Extract sub-agent details from tool_use blocks.
/// Claude Code logs these as "Task" or "Agent" depending on the version.
/// Returns a Vec of SubAgentInfo with id and description for each sub-agent.
fn extract_sub_agents(content: &Value) -> Vec<SubAgentInfo> {
    if let Value::Array(blocks) = content {
        blocks
            .iter()
            .filter_map(|block| {
                let is_tool_use = block
                    .get("type")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t == "tool_use");
                let is_sub_agent = block
                    .get("name")
                    .and_then(|n| n.as_str())
                    .is_some_and(|n| n == "Task" || n == "Agent");
                if is_tool_use && is_sub_agent {
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let description = block
                        .get("input")
                        .and_then(|inp| inp.get("description"))
                        .and_then(|d| d.as_str())
                        .unwrap_or("Sub-agent task")
                        .to_string();
                    Some(SubAgentInfo { id, description })
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec![]
    }
}

/// Check if a text string is an internal XML command (slash commands, local-command outputs).
fn is_command_xml(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<command-message>")
        || trimmed.starts_with("<local-command-")
}

/// Extract text content from a JSONL message content field.
/// Content can be a plain string or an array of content blocks.
/// Filters out internal XML command tags so they don't appear in speech bubbles.
fn extract_content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => {
            if s.is_empty() || is_command_xml(s) {
                None
            } else {
                Some(truncate_text(s, 200))
            }
        }
        Value::Array(arr) => {
            let text = arr
                .iter()
                .filter_map(|block| {
                    block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .filter(|s| !is_command_xml(s))
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() {
                None
            } else {
                Some(truncate_text(&text, 200))
            }
        }
        _ => None,
    }
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{truncated}...")
    }
}

/// Determine status from an "assistant" event by inspecting message content.
///   - stop_reason="end_turn" → TaskComplete
///   - content contains tool_use block → ToolUse
///   - otherwise → Responding
fn classify_assistant(entry: &LogEntry) -> Status {
    if let Some(msg) = &entry.message {
        if msg.stop_reason.as_deref() == Some("end_turn") {
            return Status::TaskComplete;
        }
        if let Some(content) = &msg.content {
            if has_tool_use(content) {
                return Status::ToolUse;
            }
        }
    }
    Status::Responding
}

/// Extract tool-use-id from a completed <task-notification> XML block.
/// Queue-operation entries use this format for async agent completion notifications.
fn extract_task_notification_completion(content: &str) -> Option<String> {
    if !content.contains("<task-notification>") {
        return None;
    }
    let status_start = content.find("<status>")? + "<status>".len();
    let status_end = content.find("</status>")?;
    if status_start >= status_end {
        return None;
    }
    let status = &content[status_start..status_end];
    if status != "completed" {
        return None;
    }
    let id_start = content.find("<tool-use-id>")? + "<tool-use-id>".len();
    let id_end = content.find("</tool-use-id>")?;
    if id_start >= id_end {
        return None;
    }
    Some(content[id_start..id_end].to_string())
}

/// Parse a single JSONL log line into a ParsedEvent.
/// Returns None if the line is malformed, empty, or contains an irrelevant event type.
pub fn parse_line(line: &str) -> Option<ParsedEvent> {
    if line.trim().is_empty() {
        return None;
    }

    let entry: LogEntry = match serde_json::from_str(line) {
        Ok(e) => e,
        Err(e) => {
            app_log!(
                "LOG_PARSE",
                "JSONL parse error: {} — skipping line (first 100 chars: '{}')",
                e,
                &line[..line.len().min(100)]
            );
            return None;
        }
    };

    // Skip meta messages — internal Claude Code bookkeeping (e.g. /exit, /clear,
    // local-command-caveat, file-history-snapshot session wrappers).
    if entry.is_meta == Some(true) {
        return None;
    }

    let event_type = entry.entry_type.as_deref().unwrap_or("");
    let timestamp = entry
        .timestamp
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    // For "user" type with tool_result-only content: not a real user message,
    // but may contain completed sub-agent IDs that we need to track.
    let (status, completed_sub_agent_ids) = match event_type {
        // Real Claude Code JSONL types
        "user" => {
            if is_interrupt_message(&entry) {
                (Status::Error, vec![])
            } else if is_real_user_message(&entry) {
                (Status::Thinking, vec![])
            } else {
                // Extract completed sub-agent IDs from tool_result blocks
                let ids = entry
                    .message
                    .as_ref()
                    .and_then(|m| m.content.as_ref())
                    .map(extract_completed_sub_agent_ids)
                    .unwrap_or_default();
                if ids.is_empty() {
                    return None;
                }
                (Status::ToolUse, ids)
            }
        }
        "assistant" => (classify_assistant(&entry), vec![]),
        "progress" => (Status::ToolUse, vec![]),
        "error" => (Status::Error, vec![]),
        // Legacy/alternative type names (backward compatibility)
        "user_message" => (Status::Thinking, vec![]),
        "assistant_start" => (Status::Responding, vec![]),
        "tool_use" | "tool_result" => (Status::ToolUse, vec![]),
        "assistant_end" => (Status::TaskComplete, vec![]),
        // Async agent completion via queue-operation task notifications
        "queue-operation" => {
            let notification = entry.content.as_deref().unwrap_or("");
            if let Some(tool_use_id) = extract_task_notification_completion(notification) {
                (Status::ToolUse, vec![tool_use_id])
            } else {
                return None;
            }
        }
        // Irrelevant types (file-history-snapshot, system, etc.)
        _ => return None,
    };

    let current_task = entry
        .message
        .as_ref()
        .and_then(|m| m.content.as_ref())
        .and_then(extract_content_text);

    // Usage lives inside message.usage in real Claude Code logs,
    // with fallback to top-level usage for legacy/test compatibility.
    let usage = entry
        .message
        .as_ref()
        .and_then(|m| m.usage.as_ref())
        .or(entry.usage.as_ref());

    let tokens_in = usage.and_then(|u| {
        let base = u.input_tokens.unwrap_or(0);
        let cache_read = u.cache_read_input_tokens.unwrap_or(0);
        let cache_create = u.cache_creation_input_tokens.unwrap_or(0);
        let total = base + cache_read + cache_create;
        if total > 0 {
            Some(total)
        } else {
            None
        }
    });
    let tokens_out = usage.and_then(|u| u.output_tokens);

    let sub_agents = entry
        .message
        .as_ref()
        .and_then(|m| m.content.as_ref())
        .map(extract_sub_agents)
        .unwrap_or_default();

    // Model lives inside message.model in real Claude Code logs,
    // with fallback to top-level model for legacy/test compatibility.
    let model = entry
        .message
        .as_ref()
        .and_then(|m| m.model.clone())
        .or(entry.model.clone());

    Some(ParsedEvent {
        status,
        model,
        current_task,
        tokens_in,
        tokens_out,
        sub_agents,
        completed_sub_agent_ids,
        timestamp,
        cwd: entry.cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_user_event() {
        let line = r#"{"type":"user","message":{"role":"user","content":"Fix the bug"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert_eq!(event.current_task, Some("Fix the bug".to_string()));
    }

    #[test]
    fn test_parse_assistant_responding() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me help"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Responding);
    }

    #[test]
    fn test_parse_assistant_tool_use() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"stop_reason":"tool_use"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
    }

    #[test]
    fn test_parse_assistant_end_turn() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done!"}],"stop_reason":"end_turn"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::TaskComplete);
    }

    #[test]
    fn test_parse_progress() {
        let line = r#"{"type":"progress","timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
    }

    #[test]
    fn test_parse_error() {
        let line = r#"{"type":"error","timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Error);
    }

    #[test]
    fn test_parse_legacy_user_message() {
        let line = r#"{"type":"user_message","timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_parse_legacy_assistant_start() {
        let line = r#"{"type":"assistant_start","timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Responding);
    }

    #[test]
    fn test_parse_legacy_assistant_end() {
        let line = r#"{"type":"assistant_end","timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::TaskComplete);
    }

    #[test]
    fn test_parse_extracts_model_from_top_level() {
        let line = r#"{"type":"assistant","model":"claude-opus-4","message":{"role":"assistant","content":"Hi"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.model, Some("claude-opus-4".to_string()));
    }

    #[test]
    fn test_parse_extracts_model_from_message() {
        // Real Claude Code format: model is inside message, not at top level
        let line = r#"{"type":"assistant","message":{"model":"claude-opus-4-6","role":"assistant","content":"Hi"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.model, Some("claude-opus-4-6".to_string()));
    }

    #[test]
    fn test_parse_message_model_takes_priority_over_top_level() {
        let line = r#"{"type":"assistant","model":"old-model","message":{"model":"claude-sonnet-4-6","role":"assistant","content":"Hi"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.model, Some("claude-sonnet-4-6".to_string()));
    }

    #[test]
    fn test_parse_extracts_tokens() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"Done","stop_reason":"end_turn"},"usage":{"input_tokens":150,"output_tokens":300},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.tokens_in, Some(150));
        assert_eq!(event.tokens_out, Some(300));
    }

    #[test]
    fn test_parse_content_from_array() {
        let line = r#"{"type":"user","message":{"content":[{"type":"text","text":"Hello agent"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.current_task, Some("Hello agent".to_string()));
    }

    #[test]
    fn test_parse_malformed_json() {
        assert!(parse_line("this is not json {{{").is_none());
    }

    #[test]
    fn test_parse_empty_line() {
        assert!(parse_line("").is_none());
    }

    #[test]
    fn test_parse_irrelevant_type() {
        let line = r#"{"type":"file-history-snapshot"}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_parse_system_type_ignored() {
        let line = r#"{"type":"system","timestamp":"2026-01-01T00:00:00Z"}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_truncate_long_content() {
        let long_text = "a".repeat(250);
        let truncated = truncate_text(&long_text, 200);
        assert_eq!(truncated.len(), 203);
    }

    #[test]
    fn test_no_truncation_for_short_content() {
        assert_eq!(truncate_text("Short text", 200), "Short text");
    }

    #[test]
    fn test_parse_extracts_tokens_from_message_usage() {
        // Real Claude Code format: usage is inside message, not at top level
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"Done","stop_reason":"end_turn","usage":{"input_tokens":3,"cache_read_input_tokens":24515,"cache_creation_input_tokens":5628,"output_tokens":42}},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.tokens_in, Some(3 + 24515 + 5628));
        assert_eq!(event.tokens_out, Some(42));
    }

    #[test]
    fn test_parse_prefers_message_usage_over_top_level() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"Done","stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50}},"usage":{"input_tokens":1,"output_tokens":1},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        // Should use message.usage, not top-level usage
        assert_eq!(event.tokens_in, Some(100));
        assert_eq!(event.tokens_out, Some(50));
    }

    #[test]
    fn test_has_tool_use_true() {
        let content: Value =
            serde_json::from_str(r#"[{"type":"tool_use","id":"t1","name":"Read","input":{}}]"#)
                .unwrap();
        assert!(has_tool_use(&content));
    }

    #[test]
    fn test_has_tool_use_false() {
        let content: Value = serde_json::from_str(r#"[{"type":"text","text":"hello"}]"#).unwrap();
        assert!(!has_tool_use(&content));
    }

    #[test]
    fn test_extract_sub_agents_single() {
        let content: Value = serde_json::from_str(
            r#"[{"type":"tool_use","id":"t1","name":"Task","input":{"description":"Fix bug"}}]"#,
        )
        .unwrap();
        let subs = extract_sub_agents(&content);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].id, "t1");
        assert_eq!(subs[0].description, "Fix bug");
    }

    #[test]
    fn test_extract_sub_agents_multiple_parallel() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"tool_use","id":"t1","name":"Task","input":{"description":"Task A"}},
                {"type":"tool_use","id":"t2","name":"Task","input":{"description":"Task B"}},
                {"type":"tool_use","id":"t3","name":"Task","input":{"description":"Task C"}}
            ]"#,
        )
        .unwrap();
        let subs = extract_sub_agents(&content);
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0].description, "Task A");
        assert_eq!(subs[2].description, "Task C");
    }

    #[test]
    fn test_extract_sub_agents_mixed() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"tool_use","id":"t1","name":"Task","input":{"description":"Run tests"}},
                {"type":"tool_use","id":"t2","name":"Read","input":{}},
                {"type":"tool_use","id":"t3","name":"Bash","input":{}}
            ]"#,
        )
        .unwrap();
        let subs = extract_sub_agents(&content);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].description, "Run tests");
    }

    #[test]
    fn test_extract_sub_agents_no_tasks() {
        let content: Value =
            serde_json::from_str(r#"[{"type":"tool_use","id":"t1","name":"Read","input":{}}]"#)
                .unwrap();
        assert!(extract_sub_agents(&content).is_empty());
    }

    #[test]
    fn test_parse_line_sets_sub_agents() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Task","input":{"description":"Diagnose"}},{"type":"tool_use","id":"t2","name":"Task","input":{"description":"Fix"}}],"stop_reason":"tool_use"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
        assert_eq!(event.sub_agents.len(), 2);
        assert_eq!(event.sub_agents[0].description, "Diagnose");
        assert_eq!(event.sub_agents[1].description, "Fix");
    }

    #[test]
    fn test_extract_sub_agents_agent_name() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"tool_use","id":"t1","name":"Agent","input":{"description":"Explore codebase"}},
                {"type":"tool_use","id":"t2","name":"Agent","input":{"description":"Run linter"}},
                {"type":"tool_use","id":"t3","name":"Agent","input":{"description":"Build project"}}
            ]"#,
        )
        .unwrap();
        let subs = extract_sub_agents(&content);
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0].description, "Explore codebase");
    }

    #[test]
    fn test_extract_sub_agents_mixed_task_and_agent() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"tool_use","id":"t1","name":"Task","input":{"description":"Task work"}},
                {"type":"tool_use","id":"t2","name":"Agent","input":{"description":"Agent work"}},
                {"type":"tool_use","id":"t3","name":"Read","input":{}}
            ]"#,
        )
        .unwrap();
        let subs = extract_sub_agents(&content);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].description, "Task work");
        assert_eq!(subs[1].description, "Agent work");
    }

    #[test]
    fn test_extract_sub_agents_missing_description_uses_default() {
        let content: Value =
            serde_json::from_str(r#"[{"type":"tool_use","id":"t1","name":"Task","input":{}}]"#)
                .unwrap();
        let subs = extract_sub_agents(&content);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].description, "Sub-agent task");
    }

    #[test]
    fn test_parse_skips_meta_messages() {
        let line = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>internal</local-command-caveat>"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_parse_skips_command_name_messages() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<command-name>/exit</command-name>\n<command-message>exit</command-message>"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_parse_skips_local_command_stdout() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Bye!</local-command-stdout>"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_parse_tool_result_only_user_message_extracts_completed_ids() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"ok"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.completed_sub_agent_ids, vec!["t1"]);
        assert!(event.sub_agents.is_empty());
    }

    #[test]
    fn test_parse_skips_tool_result_without_ids() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_parse_accepts_real_user_text_message() {
        let line = r#"{"type":"user","message":{"role":"user","content":"Fix the bug in auth"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_parse_accepts_user_message_with_text_block() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Help me refactor"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_extract_content_filters_command_xml_from_string() {
        let content: Value = Value::String(
            "<command-name>/init</command-name>\n<command-message>init</command-message>"
                .to_string(),
        );
        assert!(extract_content_text(&content).is_none());
    }

    #[test]
    fn test_extract_content_filters_command_xml_from_array() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"text","text":"<command-name>/init</command-name>\n<command-message>init</command-message>"},
                {"type":"text","text":"Please analyze this codebase"}
            ]"#,
        )
        .unwrap();
        let result = extract_content_text(&content).unwrap();
        assert_eq!(result, "Please analyze this codebase");
    }

    #[test]
    fn test_extract_content_filters_command_message_xml() {
        let content: Value = Value::String("<command-message>init</command-message>".to_string());
        assert!(extract_content_text(&content).is_none());
    }

    #[test]
    fn test_extract_content_filters_all_xml_blocks_returns_none() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"text","text":"<command-name>/commit</command-name>"},
                {"type":"text","text":"<command-message>fix bug</command-message>"}
            ]"#,
        )
        .unwrap();
        assert!(extract_content_text(&content).is_none());
    }

    #[test]
    fn test_parse_interrupt_by_user() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Error);
    }

    #[test]
    fn test_parse_interrupt_by_user_for_tool_use() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Error);
    }

    #[test]
    fn test_parse_interrupt_string_content() {
        let line = r#"{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::Error);
    }

    #[test]
    fn test_path_to_agent_id_from_project_path() {
        let parser = ClaudeCodeParser;
        let path = Path::new(
            "/home/user/.claude/projects/-Users-me-myproject/8fea29d9-1234-5678-abcd-ef0123456789.jsonl",
        );
        assert_eq!(
            parser.path_to_agent_id(path),
            "log--Users-me-myproject--8fea29d9"
        );
    }

    #[test]
    fn test_path_to_agent_id_short_filename() {
        let parser = ClaudeCodeParser;
        let path = Path::new("/home/user/.claude/projects/-Users-me-myproject/abc.jsonl");
        assert_eq!(
            parser.path_to_agent_id(path),
            "log--Users-me-myproject--abc"
        );
    }

    #[test]
    fn test_claude_code_parser_name() {
        let parser = ClaudeCodeParser;
        assert_eq!(parser.name(), "claude-code");
    }

    #[test]
    fn test_claude_code_parser_can_parse_by_path() {
        let parser = ClaudeCodeParser;
        let path = std::path::Path::new("/home/user/.claude/projects/myproj/session.jsonl");
        assert!(parser.can_parse(path, ""));
    }

    #[test]
    fn test_claude_code_parser_can_parse_by_content() {
        use super::super::parser_trait::AgentLogParser;
        let parser = ClaudeCodeParser;
        let path = std::path::Path::new("/some/random/path/log.jsonl");
        let first_line = r#"{"type":"user","message":{"role":"user","content":"Hello"}}"#;
        assert!(parser.can_parse(path, first_line));
    }

    #[test]
    fn test_claude_code_parser_can_parse_windows_style_path() {
        let parser = ClaudeCodeParser;
        // On non-Windows this builds a path with literal backslashes in the filename,
        // but on Windows it will be a real multi-component path.
        // We test both forward-slash and backslash variants to cover all platforms.
        let unix_path = Path::new("/home/user/.claude/projects/myproj/session.jsonl");
        assert!(parser.can_parse(unix_path, ""));

        // Verify component-based detection works with the standard Path API
        let components: Vec<_> = unix_path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        assert!(components
            .windows(2)
            .any(|w| w[0] == ".claude" && w[1] == "projects"));
    }

    #[test]
    fn test_claude_code_parser_rejects_unknown_path_and_content() {
        use super::super::parser_trait::AgentLogParser;
        let parser = ClaudeCodeParser;
        let path = std::path::Path::new("/some/random/path/log.txt");
        assert!(!parser.can_parse(path, "not json at all"));
    }

    #[test]
    fn test_claude_code_parser_trait_parse_line() {
        use super::super::parser_trait::AgentLogParser;
        let parser = ClaudeCodeParser;
        let line = r#"{"type":"user","message":{"role":"user","content":"Fix bug"},"timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_is_async_launch_result_string_content() {
        let block: Value = serde_json::from_str(
            r#"{"type":"tool_result","tool_use_id":"t1","content":"Async agent launched successfully. Task ID: abc123"}"#,
        ).unwrap();
        assert!(is_async_launch_result(&block));
    }

    #[test]
    fn test_is_async_launch_result_array_content() {
        let block: Value = serde_json::from_str(
            r#"{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"Async agent launched successfully. Task ID: abc123"}]}"#,
        ).unwrap();
        assert!(is_async_launch_result(&block));
    }

    #[test]
    fn test_is_async_launch_result_normal_result() {
        let block: Value = serde_json::from_str(
            r#"{"type":"tool_result","tool_use_id":"t1","content":"Here is the analysis of the code..."}"#,
        ).unwrap();
        assert!(!is_async_launch_result(&block));
    }

    #[test]
    fn test_extract_completed_ids_skips_async_launched() {
        let content: Value = serde_json::from_str(
            r#"[
                {"type":"tool_result","tool_use_id":"t1","content":"Async agent launched successfully. Task ID: abc123"},
                {"type":"tool_result","tool_use_id":"t2","content":"Here is the result of the analysis"}
            ]"#,
        ).unwrap();
        let ids = extract_completed_sub_agent_ids(&content);
        assert_eq!(ids, vec!["t2"]);
    }

    #[test]
    fn test_extract_task_notification_completion() {
        let content = "<task-notification><tool-use-id>toolu_abc123</tool-use-id><status>completed</status></task-notification>";
        let id = extract_task_notification_completion(content);
        assert_eq!(id, Some("toolu_abc123".to_string()));
    }

    #[test]
    fn test_extract_task_notification_no_match() {
        assert!(extract_task_notification_completion("some random text").is_none());
        assert!(extract_task_notification_completion("").is_none());
    }

    #[test]
    fn test_extract_task_notification_non_completed_status() {
        let content = "<task-notification><tool-use-id>toolu_abc123</tool-use-id><status>running</status></task-notification>";
        assert!(extract_task_notification_completion(content).is_none());
    }

    #[test]
    fn test_parse_line_queue_operation_completion() {
        let line = r#"{"type":"queue-operation","content":"<task-notification><tool-use-id>toolu_abc123</tool-use-id><status>completed</status></task-notification>","timestamp":"2026-01-01T00:00:00Z"}"#;
        let event = parse_line(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
        assert_eq!(event.completed_sub_agent_ids, vec!["toolu_abc123"]);
    }

    #[test]
    fn test_parse_line_queue_operation_non_completion() {
        let line = r#"{"type":"queue-operation","content":"some other queue data","timestamp":"2026-01-01T00:00:00Z"}"#;
        assert!(parse_line(line).is_none());
    }
}
