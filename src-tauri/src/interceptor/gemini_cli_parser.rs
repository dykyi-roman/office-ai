// Gemini CLI JSON session file parser
// Maps Gemini CLI log events to AgentStatus.
//
// Gemini CLI stores sessions as JSON arrays at ~/.gemini/tmp/<project>/chats/session-*.json
// Each element in the array is a message object with a "type" field:
//   type="user"    → user sent a message     → Thinking
//   type="gemini"  → model responded          → Responding / ToolUse
//   type="info"    → info/control message     → Error (if cancelled)

use super::parsed_event::ParsedEvent;
use super::parser_trait::AgentLogParser;
use crate::discovery::log_reader::{JsonArrayReader, LogFileReader};
use crate::models::Status;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Gemini CLI session file parser implementing the AgentLogParser trait.
pub struct GeminiCliParser;

impl AgentLogParser for GeminiCliParser {
    fn name(&self) -> &str {
        "gemini-cli"
    }

    fn model_hint(&self) -> &str {
        "gemini"
    }

    fn can_parse(&self, path: &Path, _first_line: &str) -> bool {
        let components: Vec<_> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect();
        components
            .windows(2)
            .any(|w| w[0] == ".gemini" && w[1] == "tmp")
    }

    fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
        parse_gemini_message(line)
    }

    /// Gemini: `~/.gemini/tmp/<project>/chats/session-<uuid>.json`
    /// → `log-<project>--session-<first 16 chars>`
    fn path_to_agent_id(&self, path: &Path) -> String {
        let project = path
            .parent() // chats/
            .and_then(|p| p.parent()) // <project>/
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let stem = path
            .file_stem()
            .map(|s| {
                let s = s.to_string_lossy();
                if s.len() > 16 {
                    s[..16].to_string()
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_default();
        if stem.is_empty() {
            format!("log-{project}")
        } else {
            format!("log-{project}--{stem}")
        }
    }

    fn log_roots(&self) -> Vec<PathBuf> {
        dirs::home_dir()
            .map(|h| vec![h.join(".gemini").join("tmp")])
            .unwrap_or_default()
    }

    /// Gemini: if a subdirectory contains a `chats/` folder, use that.
    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if !root.exists() {
            return dirs;
        }
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let chats_dir = path.join("chats");
                    if chats_dir.is_dir() {
                        dirs.push(chats_dir);
                    } else {
                        dirs.push(path);
                    }
                }
            }
        }
        dirs
    }

    fn create_reader(&self) -> Box<dyn LogFileReader> {
        Box::new(JsonArrayReader::new())
    }
}

/// Raw Gemini message structure (only fields we care about).
/// Supports both old format (parts) and new format (content).
#[derive(Debug, Deserialize)]
struct GeminiMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    /// Text content parts (old format)
    parts: Option<Vec<GeminiPart>>,
    /// Content field (new format): can be a string or array of {text: "..."}
    content: Option<Value>,
    /// Tool calls in model responses
    #[serde(rename = "toolCalls")]
    tool_calls: Option<Vec<Value>>,
    /// Token usage information
    tokens: Option<GeminiTokens>,
    /// Model name (e.g. "gemini-3-flash-preview")
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiTokens {
    input: Option<u64>,
    output: Option<u64>,
    #[allow(dead_code)]
    cached: Option<u64>,
}

/// Extract text content from a Gemini message.
/// Handles both old format (parts) and new format (content string or content array).
fn extract_text_from_message(msg: &GeminiMessage) -> Option<String> {
    // Try new format: content as string
    if let Some(content) = &msg.content {
        if let Some(text) = content.as_str() {
            if !text.is_empty() {
                return Some(truncate_text(text, 200));
            }
        }
        // Try new format: content as array of {text: "..."}
        if let Some(arr) = content.as_array() {
            let text: String = arr
                .iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ");
            if !text.is_empty() {
                return Some(truncate_text(&text, 200));
            }
        }
    }

    // Fall back to old format: parts
    msg.parts.as_ref().and_then(|parts| {
        let text: String = parts
            .iter()
            .filter_map(|p| p.text.as_deref())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            None
        } else {
            Some(truncate_text(&text, 200))
        }
    })
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{truncated}...")
    }
}

/// Parse a single Gemini message (serialized as JSON string) into a ParsedEvent.
fn parse_gemini_message(line: &str) -> Option<ParsedEvent> {
    if line.trim().is_empty() {
        return None;
    }

    let msg: GeminiMessage = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(e) => {
            app_log!(
                "LOG_PARSE",
                "Gemini JSON parse error: {} — skipping (first 100 chars: '{}')",
                e,
                &line[..line.len().min(100)]
            );
            return None;
        }
    };

    let msg_type = msg.msg_type.as_deref().unwrap_or("");
    let timestamp = chrono::Utc::now().to_rfc3339();

    let status = match msg_type {
        "user" => {
            let has_text = extract_text_from_message(&msg).is_some();
            if has_text {
                Status::Thinking
            } else {
                return None;
            }
        }
        "gemini" => {
            let has_tool_calls = msg.tool_calls.as_ref().is_some_and(|tc| !tc.is_empty());
            if has_tool_calls {
                Status::ToolUse
            } else {
                Status::Responding
            }
        }
        "info" => {
            let text = extract_text_from_message(&msg).unwrap_or_default();
            if text.to_lowercase().contains("cancelled") {
                Status::Error
            } else {
                return None;
            }
        }
        _ => return None,
    };

    let current_task = extract_text_from_message(&msg);

    let tokens_in = msg.tokens.as_ref().and_then(|t| t.input).filter(|&v| v > 0);
    let tokens_out = msg
        .tokens
        .as_ref()
        .and_then(|t| t.output)
        .filter(|&v| v > 0);

    Some(ParsedEvent {
        status,
        model: msg.model,
        current_task,
        tokens_in,
        tokens_out,
        sub_agents: vec![],
        completed_sub_agent_ids: vec![],
        timestamp,
        cwd: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Old format (parts) ---

    #[test]
    fn test_parse_user_message_old_format() {
        let line = r#"{"type":"user","parts":[{"text":"Explain this code"}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert_eq!(event.current_task, Some("Explain this code".to_string()));
    }

    #[test]
    fn test_parse_gemini_response_old_format() {
        let line = r#"{"type":"gemini","parts":[{"text":"Here is the explanation"}],"model":"gemini-3-flash-preview"}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::Responding);
        assert_eq!(event.model, Some("gemini-3-flash-preview".to_string()));
    }

    #[test]
    fn test_parse_gemini_tool_use() {
        let line = r#"{"type":"gemini","parts":[{"text":"Running tool"}],"toolCalls":[{"name":"readFile","args":{"path":"main.rs"}}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
    }

    #[test]
    fn test_parse_gemini_empty_tool_calls_is_responding() {
        let line = r#"{"type":"gemini","parts":[{"text":"Done"}],"toolCalls":[]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::Responding);
    }

    #[test]
    fn test_parse_info_cancelled() {
        let line = r#"{"type":"info","parts":[{"text":"Operation cancelled by user"}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::Error);
    }

    #[test]
    fn test_parse_info_non_cancelled_skipped() {
        let line = r#"{"type":"info","parts":[{"text":"Session started"}]}"#;
        assert!(parse_gemini_message(line).is_none());
    }

    // --- New format (content) ---

    #[test]
    fn test_parse_user_message_new_format_content_array() {
        let line = r#"{"type":"user","content":[{"text":"Hi"}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert_eq!(event.current_task, Some("Hi".to_string()));
    }

    #[test]
    fn test_parse_gemini_response_new_format_content_string() {
        let line = r#"{"type":"gemini","content":"Hello! How can I help?","model":"gemini-3-flash-preview","tokens":{"input":100,"output":9}}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.status, Status::Responding);
        assert_eq!(event.model, Some("gemini-3-flash-preview".to_string()));
        assert_eq!(
            event.current_task,
            Some("Hello! How can I help?".to_string())
        );
        assert_eq!(event.tokens_in, Some(100));
        assert_eq!(event.tokens_out, Some(9));
    }

    #[test]
    fn test_parse_user_empty_content_array_skipped() {
        let line = r#"{"type":"user","content":[]}"#;
        assert!(parse_gemini_message(line).is_none());
    }

    #[test]
    fn test_parse_user_empty_content_string_skipped() {
        let line = r#"{"type":"user","content":""}"#;
        assert!(parse_gemini_message(line).is_none());
    }

    // --- Common tests ---

    #[test]
    fn test_parse_unknown_type_skipped() {
        let line = r#"{"type":"system","parts":[{"text":"init"}]}"#;
        assert!(parse_gemini_message(line).is_none());
    }

    #[test]
    fn test_parse_empty_line() {
        assert!(parse_gemini_message("").is_none());
    }

    #[test]
    fn test_parse_malformed_json() {
        assert!(parse_gemini_message("not json at all {{{").is_none());
    }

    #[test]
    fn test_parse_extracts_tokens() {
        let line = r#"{"type":"gemini","parts":[{"text":"Done"}],"tokens":{"input":100,"output":50,"cached":20},"model":"gemini-3-flash"}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.tokens_in, Some(100));
        assert_eq!(event.tokens_out, Some(50));
    }

    #[test]
    fn test_parse_no_tokens() {
        let line = r#"{"type":"gemini","parts":[{"text":"Hi"}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert_eq!(event.tokens_in, None);
        assert_eq!(event.tokens_out, None);
    }

    #[test]
    fn test_parse_user_empty_parts_skipped() {
        let line = r#"{"type":"user","parts":[]}"#;
        assert!(parse_gemini_message(line).is_none());
    }

    #[test]
    fn test_parse_user_no_text_skipped() {
        let line = r#"{"type":"user","parts":[{}]}"#;
        assert!(parse_gemini_message(line).is_none());
    }

    #[test]
    fn test_cwd_is_none() {
        let line = r#"{"type":"user","parts":[{"text":"hello"}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert!(event.cwd.is_none());
    }

    #[test]
    fn test_sub_agents_always_empty() {
        // Gemini tool calls are NOT sub-agents (unlike Claude Code Agent/Task).
        // They are regular tool use — sub_agents must always be empty to prevent
        // phantom sub-agents from blocking auto-idle transitions.
        let line = r#"{"type":"gemini","parts":[{"text":"Running tools"}],"toolCalls":[{"name":"readFile","args":{"path":"main.rs"}}]}"#;
        let event = parse_gemini_message(line).unwrap();
        assert!(event.sub_agents.is_empty());
        assert!(event.completed_sub_agent_ids.is_empty());
    }

    #[test]
    fn test_path_to_agent_id_gemini_path() {
        let parser = GeminiCliParser;
        let path = Path::new("/home/user/.gemini/tmp/my-project/chats/session-abc123def456.json");
        let id = parser.path_to_agent_id(path);
        assert!(id.starts_with("log-my-project--session-abc1"));
    }

    #[test]
    fn test_path_to_agent_id_gemini_short_session() {
        let parser = GeminiCliParser;
        let path = Path::new("/home/user/.gemini/tmp/proj/chats/session-ab.json");
        assert_eq!(parser.path_to_agent_id(path), "log-proj--session-ab");
    }

    #[test]
    fn test_resolve_log_dirs_chats_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("my-project");
        let chats = project.join("chats");
        std::fs::create_dir_all(&chats).unwrap();

        let parser = GeminiCliParser;
        let dirs = parser.resolve_log_dirs(dir.path());
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0], chats);
    }

    #[test]
    fn test_resolve_log_dirs_no_chats_uses_dir() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("my-project");
        std::fs::create_dir_all(&project).unwrap();

        let parser = GeminiCliParser;
        let dirs = parser.resolve_log_dirs(dir.path());
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0], project);
    }

    #[test]
    fn test_can_parse_gemini_path() {
        let parser = GeminiCliParser;
        let path = Path::new("/home/user/.gemini/tmp/myproject/chats/session-abc.json");
        assert!(parser.can_parse(path, ""));
    }

    #[test]
    fn test_can_parse_rejects_non_gemini_path() {
        let parser = GeminiCliParser;
        let path = Path::new("/home/user/.claude/projects/myproject/session.jsonl");
        assert!(!parser.can_parse(path, ""));
    }

    #[test]
    fn test_parser_name() {
        let parser = GeminiCliParser;
        assert_eq!(parser.name(), "gemini-cli");
    }

    #[test]
    fn test_parser_trait_parse_line() {
        let parser = GeminiCliParser;
        let line = r#"{"type":"user","parts":[{"text":"Fix bug"}]}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_truncate_long_text() {
        let long_text = "a".repeat(250);
        let truncated = truncate_text(&long_text, 200);
        assert_eq!(truncated.len(), 203);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn test_no_truncate_short_text() {
        assert_eq!(truncate_text("short", 200), "short");
    }
}
