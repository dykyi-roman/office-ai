// Codex CLI JSONL log parser
// Maps real Codex CLI log events to AgentStatus.
//
// Actual JSONL format (Codex CLI v0.114+):
//   Top-level types: session_meta, event_msg, response_item, turn_context
//
//   event_msg subtypes (payload.type):
//     task_started    → Thinking
//     user_message    → Thinking
//     agent_reasoning → Thinking
//     agent_message   → Responding
//     token_count     → (internal tracking, no status)
//     task_complete   → TaskComplete
//
//   response_item subtypes (payload.type):
//     function_call        → ToolUse
//     function_call_output → ToolUse
//     message role=assistant → Responding
//     reasoning            → (skip, covered by agent_reasoning)
//     message role=developer/user → (skip, system context)

use super::parsed_event::ParsedEvent;
use super::parser_trait::AgentLogParser;
use crate::discovery::log_reader::{JsonlReader, LogFileReader};
use crate::models::{Status, SubAgentInfo};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Internal mutable state for the Codex parser.
/// Unlike Claude/Gemini parsers (stateless), Codex needs state because:
/// - Model lives in `turn_context` but status events are separate
/// - CWD lives in `session_meta`/`turn_context` but status events are separate
/// - Tokens are cumulative — need delta tracking via `total_token_usage`
struct ParserState {
    model: Option<String>,
    cwd: Option<String>,
    /// Latest cumulative input tokens from token_count events
    cumulative_in: u64,
    /// Latest cumulative output tokens from token_count events
    cumulative_out: u64,
    /// Cumulative input tokens at end of last completed turn
    snapshot_in: u64,
    /// Cumulative output tokens at end of last completed turn
    snapshot_out: u64,
    /// Active function calls: call_id → sub-agent entries.
    /// Tracks function_call → function_call_output lifecycle.
    active_calls: HashMap<String, Vec<SubAgentInfo>>,
}

/// Codex CLI JSONL log parser implementing the AgentLogParser trait.
/// Stateful: caches model, CWD, and token totals across log lines.
pub struct CodexCliParser {
    state: Mutex<ParserState>,
}

impl CodexCliParser {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ParserState {
                model: None,
                cwd: None,
                cumulative_in: 0,
                cumulative_out: 0,
                snapshot_in: 0,
                snapshot_out: 0,
                active_calls: HashMap::new(),
            }),
        }
    }

    /// Handle `event_msg` subtypes.
    fn handle_event_msg(
        &self,
        sub_type: &str,
        payload: &Value,
        timestamp: &str,
    ) -> Option<ParsedEvent> {
        match sub_type {
            "task_started" => Some(self.make_event(Status::Thinking, None, timestamp)),

            "user_message" => {
                let message = payload
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(|s| truncate_text(s, 200));
                Some(self.make_event(Status::Thinking, message, timestamp))
            }

            "agent_reasoning" => Some(self.make_event(Status::Thinking, None, timestamp)),

            "agent_message" => {
                let message = payload
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(|s| truncate_text(s, 200));
                Some(self.make_event(Status::Responding, message, timestamp))
            }

            "token_count" => {
                if let Some(info) = payload.get("info") {
                    if let Some(total) = info.get("total_token_usage") {
                        let input = total
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let output = total
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let mut state = self.state.lock().unwrap();
                        state.cumulative_in = input;
                        state.cumulative_out = output;
                    }
                }
                None
            }

            "task_complete" => {
                let mut state = self.state.lock().unwrap();

                // Compute per-turn token deltas
                let delta_in = state.cumulative_in.saturating_sub(state.snapshot_in);
                let delta_out = state.cumulative_out.saturating_sub(state.snapshot_out);

                // Update snapshot for next turn
                state.snapshot_in = state.cumulative_in;
                state.snapshot_out = state.cumulative_out;

                let model = state.model.clone();
                let cwd = state.cwd.clone();

                let last_msg = payload
                    .get("last_agent_message")
                    .and_then(|m| m.as_str())
                    .map(|s| truncate_text(s, 200));

                Some(ParsedEvent {
                    status: Status::TaskComplete,
                    model,
                    current_task: last_msg,
                    tokens_in: if delta_in > 0 { Some(delta_in) } else { None },
                    tokens_out: if delta_out > 0 { Some(delta_out) } else { None },
                    sub_agents: vec![],
                    completed_sub_agent_ids: vec![],
                    timestamp: timestamp.to_string(),
                    cwd,
                })
            }

            _ => None,
        }
    }

    /// Handle `response_item` subtypes.
    fn handle_response_item(
        &self,
        sub_type: &str,
        payload: &Value,
        timestamp: &str,
    ) -> Option<ParsedEvent> {
        match sub_type {
            "function_call" => {
                let tool_name = payload
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");
                let call_id = payload
                    .get("call_id")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let task = Some(format!("tool: {tool_name}"));

                // Build sub-agent entries for this call
                let sub_entries = if tool_name == "exec_command" {
                    // Try to parse parallel bash commands from arguments
                    let cmd = payload
                        .get("arguments")
                        .and_then(|a| {
                            // arguments may be a JSON string or an object
                            if let Some(s) = a.as_str() {
                                serde_json::from_str::<Value>(s)
                                    .ok()
                                    .and_then(|v| v.get("cmd").and_then(|c| c.as_str()).map(String::from))
                            } else {
                                a.get("cmd").and_then(|c| c.as_str()).map(String::from)
                            }
                        });

                    if let Some(ref cmd_str) = cmd {
                        if let Some(commands) = parse_parallel_bash_commands(cmd_str) {
                            commands
                                .into_iter()
                                .enumerate()
                                .map(|(i, desc)| SubAgentInfo {
                                    id: format!("{call_id}:{i}"),
                                    description: desc,
                                })
                                .collect()
                        } else {
                            vec![SubAgentInfo {
                                id: call_id.clone(),
                                description: cmd_str.clone(),
                            }]
                        }
                    } else {
                        vec![SubAgentInfo {
                            id: call_id.clone(),
                            description: tool_name.to_string(),
                        }]
                    }
                } else {
                    vec![SubAgentInfo {
                        id: call_id.clone(),
                        description: tool_name.to_string(),
                    }]
                };

                // Store in active_calls and return sub_agents in the event
                let mut state = self.state.lock().unwrap();
                let sub_agents = sub_entries.clone();
                if !call_id.is_empty() {
                    state.active_calls.insert(call_id, sub_entries);
                }

                Some(ParsedEvent {
                    status: Status::ToolUse,
                    model: state.model.clone(),
                    current_task: task,
                    tokens_in: None,
                    tokens_out: None,
                    sub_agents,
                    completed_sub_agent_ids: vec![],
                    timestamp: timestamp.to_string(),
                    cwd: state.cwd.clone(),
                })
            }

            "function_call_output" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");

                let mut state = self.state.lock().unwrap();
                let completed_ids = if !call_id.is_empty() {
                    state
                        .active_calls
                        .remove(call_id)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|s| s.id)
                        .collect()
                } else {
                    vec![]
                };

                Some(ParsedEvent {
                    status: Status::ToolUse,
                    model: state.model.clone(),
                    current_task: None,
                    tokens_in: None,
                    tokens_out: None,
                    sub_agents: vec![],
                    completed_sub_agent_ids: completed_ids,
                    timestamp: timestamp.to_string(),
                    cwd: state.cwd.clone(),
                })
            }

            "message" => {
                let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
                if role == "assistant" {
                    let text = payload
                        .get("content")
                        .and_then(|c| c.as_array())
                        .and_then(|arr| {
                            arr.iter()
                                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                                .next()
                        })
                        .map(|s| truncate_text(s, 200));
                    Some(self.make_event(Status::Responding, text, timestamp))
                } else {
                    // developer, user = system/user context, skip
                    None
                }
            }

            // reasoning is covered by agent_reasoning in event_msg
            "reasoning" => None,

            _ => None,
        }
    }

    /// Create a ParsedEvent with cached model and CWD.
    fn make_event(
        &self,
        status: Status,
        current_task: Option<String>,
        timestamp: &str,
    ) -> ParsedEvent {
        let state = self.state.lock().unwrap();
        ParsedEvent {
            status,
            model: state.model.clone(),
            current_task,
            tokens_in: None,
            tokens_out: None,
            sub_agents: vec![],
            completed_sub_agent_ids: vec![],
            timestamp: timestamp.to_string(),
            cwd: state.cwd.clone(),
        }
    }
}

impl AgentLogParser for CodexCliParser {
    fn name(&self) -> &str {
        "codex-cli"
    }

    fn model_hint(&self) -> &str {
        "codex"
    }

    fn can_parse(&self, path: &Path, first_line: &str) -> bool {
        // Detect by path: ~/.codex/sessions/ directory structure
        let components: Vec<_> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect();
        let has_codex_path = components
            .windows(2)
            .any(|w| w[0] == ".codex" && w[1] == "sessions");
        if has_codex_path {
            return true;
        }

        // Detect by content: Codex CLI JSONL has specific top-level type fields
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(first_line) {
            if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                return matches!(
                    t,
                    "session_meta" | "event_msg" | "response_item" | "turn_context"
                );
            }
        }

        false
    }

    fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
        if line.trim().is_empty() {
            return None;
        }

        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                app_log!(
                    "LOG_PARSE",
                    "Codex JSONL parse error: {} — skipping (first 100 chars: '{}')",
                    e,
                    &line[..line.len().min(100)]
                );
                return None;
            }
        };

        let top_type = v.get("type")?.as_str()?;
        let payload = v.get("payload")?;
        let timestamp = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        match top_type {
            "session_meta" => {
                // Cache CWD from payload.cwd
                if let Some(cwd) = payload.get("cwd").and_then(|c| c.as_str()) {
                    self.state.lock().unwrap().cwd = Some(cwd.to_string());
                }
                None
            }

            "turn_context" => {
                // Cache model + CWD
                let mut state = self.state.lock().unwrap();
                if let Some(model) = payload.get("model").and_then(|m| m.as_str()) {
                    state.model = Some(model.to_string());
                }
                if let Some(cwd) = payload.get("cwd").and_then(|c| c.as_str()) {
                    state.cwd = Some(cwd.to_string());
                }
                None
            }

            "event_msg" => {
                let sub_type = payload.get("type")?.as_str()?;
                self.handle_event_msg(sub_type, payload, &timestamp)
            }

            "response_item" => {
                let sub_type = payload.get("type")?.as_str()?;
                self.handle_response_item(sub_type, payload, &timestamp)
            }

            _ => None,
        }
    }

    /// Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
    /// → `log-codex--<first 8 chars of uuid>`
    fn path_to_agent_id(&self, path: &Path) -> String {
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // UUID is the last 36 chars of the stem (8-4-4-4-12 format)
        // Extract the first segment (8 hex chars) as the agent ID suffix
        let uuid_prefix = if stem.len() >= 36 {
            let uuid = &stem[stem.len() - 36..];
            uuid.split('-').next().unwrap_or("unknown")
        } else if stem.len() >= 8 {
            &stem[..8]
        } else {
            &stem
        };

        format!("log-codex--{uuid_prefix}")
    }

    fn log_roots(&self) -> Vec<PathBuf> {
        let codex_home = std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|h| h.join(".codex")));

        codex_home
            .map(|h| vec![h.join("sessions")])
            .unwrap_or_default()
    }

    /// 3-level YYYY/MM/DD traversal, optimized to today + yesterday only.
    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if !root.exists() {
            return dirs;
        }

        let today = chrono::Local::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);

        for date in &[today, yesterday] {
            let day_dir = root
                .join(date.format("%Y").to_string())
                .join(date.format("%m").to_string())
                .join(date.format("%d").to_string());
            if day_dir.is_dir() {
                dirs.push(day_dir);
            }
        }

        dirs
    }

    fn create_reader(&self) -> Box<dyn LogFileReader> {
        Box::new(JsonlReader::new())
    }
}

/// Parse parallel bash commands from a shell command string.
///
/// Detects the pattern: `bash -lc '(cmd1) & (cmd2) & ... & wait'`
/// where each `(cmd)` is a subshell running in parallel.
/// Returns `None` if the command is not a parallel pattern.
fn parse_parallel_bash_commands(cmd: &str) -> Option<Vec<String>> {
    let trimmed = cmd.trim();

    // Find the inner command string — strip `bash -lc '...'` or `bash -c '...'` wrapper
    let inner = if let Some(rest) = trimmed
        .strip_prefix("bash")
        .and_then(|s| s.trim_start().strip_prefix("-lc"))
        .or_else(|| {
            trimmed
                .strip_prefix("bash")
                .and_then(|s| s.trim_start().strip_prefix("-c"))
        })
    {
        let rest = rest.trim();
        // Strip surrounding quotes
        if (rest.starts_with('\'') && rest.ends_with('\''))
            || (rest.starts_with('"') && rest.ends_with('"'))
        {
            &rest[1..rest.len() - 1]
        } else {
            rest
        }
    } else {
        trimmed
    };

    // Must end with `& wait` (the parallel join)
    let body = inner.trim().strip_suffix("wait")?.trim().strip_suffix('&')?.trim();

    // Must contain at least one subshell pattern: `(...)`
    if !body.contains('(') {
        return None;
    }

    // Split on `) &` to separate individual subshell commands
    let commands: Vec<String> = body
        .split(") &")
        .map(|part| {
            let part = part.trim();
            // Strip leading `(`
            let part = part.strip_prefix('(').unwrap_or(part);
            // Strip trailing `)` if present (last segment)
            let part = part.strip_suffix(')').unwrap_or(part).trim();
            // Remove output redirects: `> path 2>&1`, `2>&1`, `> /dev/null`
            clean_redirects(part)
        })
        .filter(|s| !s.is_empty())
        .collect();

    if commands.len() >= 2 {
        Some(commands)
    } else {
        None
    }
}

/// Remove shell output redirects from a command string.
/// Strips patterns like `> file 2>&1`, `2>&1`, `>> file`, `> /dev/null`.
fn clean_redirects(cmd: &str) -> String {
    let mut result = cmd.to_string();
    // Remove `2>&1` first
    result = result.replace("2>&1", "");
    // Remove `> path` redirects (greedy: from `>` to end or next command separator)
    if let Some(pos) = result.find('>') {
        result = result[..pos].to_string();
    }
    result.trim().to_string()
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{truncated}...")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Test constants: real Codex CLI event formats ---

    const SESSION_META: &str = r#"{"timestamp":"2026-03-12T07:31:39.582Z","type":"session_meta","payload":{"id":"019ce0f5-4bc7-7731-adcb-8b2c34306db1","cwd":"/Users/user/projects/myapp","cli_version":"0.114.0"}}"#;

    const TURN_CONTEXT: &str = r#"{"timestamp":"2026-03-12T07:31:39.583Z","type":"turn_context","payload":{"turn_id":"019ce0f5-51a9-72a1-9972-3d1a4a4845a0","cwd":"/Users/user/projects/myapp","model":"gpt-5-codex"}}"#;

    const EVENT_TASK_STARTED: &str = r#"{"timestamp":"2026-03-12T07:31:39.583Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019ce0f5-51a9-72a1-9972-3d1a4a4845a0"}}"#;

    const EVENT_USER_MESSAGE: &str = r#"{"timestamp":"2026-03-12T07:31:39.583Z","type":"event_msg","payload":{"type":"user_message","message":"Fix the failing tests"}}"#;

    const EVENT_AGENT_REASONING: &str = r#"{"timestamp":"2026-03-12T07:31:40.294Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"**Analyzing test failures**"}}"#;

    const EVENT_AGENT_MESSAGE: &str = r#"{"timestamp":"2026-03-12T07:31:41.098Z","type":"event_msg","payload":{"type":"agent_message","message":"I found the issue in the auth module."}}"#;

    const EVENT_TOKEN_COUNT: &str = r#"{"timestamp":"2026-03-12T07:31:41.109Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":8799,"output_tokens":23},"last_token_usage":{"input_tokens":8799,"output_tokens":23}}}}"#;

    const EVENT_TASK_COMPLETE: &str = r#"{"timestamp":"2026-03-12T07:31:41.109Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"019ce0f5-51a9-72a1-9972-3d1a4a4845a0","last_agent_message":"All tests pass now."}}"#;

    const RESPONSE_FUNCTION_CALL: &str = r#"{"timestamp":"2026-03-12T07:31:57.465Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm test\"}","call_id":"call_abc123"}}"#;

    const RESPONSE_FUNCTION_CALL_OUTPUT: &str = r#"{"timestamp":"2026-03-12T07:31:57.552Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_abc123","output":"Tests passed"}}"#;

    const RESPONSE_MESSAGE_ASSISTANT: &str = r#"{"timestamp":"2026-03-12T07:31:41.099Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi there! How can I help?"}]}}"#;

    const RESPONSE_MESSAGE_DEVELOPER: &str = r#"{"timestamp":"2026-03-12T07:31:39.583Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"System instructions"}]}}"#;

    const RESPONSE_MESSAGE_USER: &str = r#"{"timestamp":"2026-03-12T07:31:39.583Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}"#;

    const RESPONSE_REASONING: &str = r#"{"timestamp":"2026-03-12T07:31:40.294Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking..."}]}}"#;

    // --- Parser name and hints ---

    #[test]
    fn test_parser_name() {
        let parser = CodexCliParser::new();
        assert_eq!(parser.name(), "codex-cli");
    }

    #[test]
    fn test_model_hint() {
        let parser = CodexCliParser::new();
        assert_eq!(parser.model_hint(), "codex");
    }

    // --- can_parse ---

    #[test]
    fn test_can_parse_codex_path() {
        let parser = CodexCliParser::new();
        let path = Path::new(
            "/home/user/.codex/sessions/2026/03/12/rollout-2026-03-12T08-31-38-019ce0f5.jsonl",
        );
        assert!(parser.can_parse(path, ""));
    }

    #[test]
    fn test_can_parse_by_content_session_meta() {
        let parser = CodexCliParser::new();
        let path = Path::new("/some/random/path/log.jsonl");
        assert!(parser.can_parse(path, SESSION_META));
    }

    #[test]
    fn test_can_parse_by_content_event_msg() {
        let parser = CodexCliParser::new();
        let path = Path::new("/some/random/path/log.jsonl");
        assert!(parser.can_parse(path, EVENT_TASK_STARTED));
    }

    #[test]
    fn test_can_parse_rejects_claude_path() {
        let parser = CodexCliParser::new();
        let path = Path::new("/home/user/.claude/projects/myproj/session.jsonl");
        assert!(!parser.can_parse(path, ""));
    }

    #[test]
    fn test_can_parse_rejects_unknown_content() {
        let parser = CodexCliParser::new();
        let path = Path::new("/some/random/path/log.jsonl");
        assert!(!parser.can_parse(path, r#"{"type":"user","message":"hello"}"#));
    }

    // --- session_meta and turn_context (cache, no status) ---

    #[test]
    fn test_session_meta_caches_cwd() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line(SESSION_META).is_none());
        let state = parser.state.lock().unwrap();
        assert_eq!(state.cwd.as_deref(), Some("/Users/user/projects/myapp"));
    }

    #[test]
    fn test_turn_context_caches_model_and_cwd() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line(TURN_CONTEXT).is_none());
        let state = parser.state.lock().unwrap();
        assert_eq!(state.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(state.cwd.as_deref(), Some("/Users/user/projects/myapp"));
    }

    // --- event_msg subtypes ---

    #[test]
    fn test_parse_task_started() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(EVENT_TASK_STARTED).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_parse_user_message() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(EVENT_USER_MESSAGE).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert_eq!(
            event.current_task,
            Some("Fix the failing tests".to_string())
        );
    }

    #[test]
    fn test_parse_agent_reasoning() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(EVENT_AGENT_REASONING).unwrap();
        assert_eq!(event.status, Status::Thinking);
    }

    #[test]
    fn test_parse_agent_message() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(EVENT_AGENT_MESSAGE).unwrap();
        assert_eq!(event.status, Status::Responding);
        assert_eq!(
            event.current_task,
            Some("I found the issue in the auth module.".to_string())
        );
    }

    #[test]
    fn test_parse_token_count_returns_none() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line(EVENT_TOKEN_COUNT).is_none());
        // Verify internal state was updated
        let state = parser.state.lock().unwrap();
        assert_eq!(state.cumulative_in, 8799);
        assert_eq!(state.cumulative_out, 23);
    }

    #[test]
    fn test_parse_task_complete() {
        let parser = CodexCliParser::new();
        // Simulate a turn: token_count then task_complete
        parser.parse_line(EVENT_TOKEN_COUNT);
        let event = parser.parse_line(EVENT_TASK_COMPLETE).unwrap();
        assert_eq!(event.status, Status::TaskComplete);
        assert_eq!(event.current_task, Some("All tests pass now.".to_string()));
        assert_eq!(event.tokens_in, Some(8799));
        assert_eq!(event.tokens_out, Some(23));
    }

    #[test]
    fn test_task_complete_includes_cached_model() {
        let parser = CodexCliParser::new();
        parser.parse_line(TURN_CONTEXT);
        let event = parser.parse_line(EVENT_TASK_COMPLETE).unwrap();
        assert_eq!(event.model.as_deref(), Some("gpt-5-codex"));
    }

    #[test]
    fn test_task_complete_includes_cached_cwd() {
        let parser = CodexCliParser::new();
        parser.parse_line(SESSION_META);
        let event = parser.parse_line(EVENT_TASK_COMPLETE).unwrap();
        assert_eq!(event.cwd.as_deref(), Some("/Users/user/projects/myapp"));
    }

    #[test]
    fn test_token_delta_across_turns() {
        let parser = CodexCliParser::new();

        // Turn 1: 8799 input, 23 output
        let token1 = r#"{"timestamp":"2026-03-12T07:31:41.109Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":8799,"output_tokens":23}}}}"#;
        parser.parse_line(token1);
        let tc1 = parser.parse_line(EVENT_TASK_COMPLETE).unwrap();
        assert_eq!(tc1.tokens_in, Some(8799));
        assert_eq!(tc1.tokens_out, Some(23));

        // Turn 2: cumulative grows to 17632 input, 109 output
        let token2 = r#"{"timestamp":"2026-03-12T07:31:57.474Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17632,"output_tokens":109}}}}"#;
        parser.parse_line(token2);
        let tc2_line = r#"{"timestamp":"2026-03-12T07:32:10.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn2","last_agent_message":"Done"}}"#;
        let tc2 = parser.parse_line(tc2_line).unwrap();
        // Delta: 17632 - 8799 = 8833 input, 109 - 23 = 86 output
        assert_eq!(tc2.tokens_in, Some(8833));
        assert_eq!(tc2.tokens_out, Some(86));
    }

    // --- response_item subtypes ---

    #[test]
    fn test_parse_function_call() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(RESPONSE_FUNCTION_CALL).unwrap();
        assert_eq!(event.status, Status::ToolUse);
        assert_eq!(event.current_task, Some("tool: exec_command".to_string()));
    }

    #[test]
    fn test_parse_function_call_output() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(RESPONSE_FUNCTION_CALL_OUTPUT).unwrap();
        assert_eq!(event.status, Status::ToolUse);
    }

    #[test]
    fn test_parse_response_message_assistant() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(RESPONSE_MESSAGE_ASSISTANT).unwrap();
        assert_eq!(event.status, Status::Responding);
        assert_eq!(
            event.current_task,
            Some("Hi there! How can I help?".to_string())
        );
    }

    #[test]
    fn test_parse_response_message_developer_skipped() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line(RESPONSE_MESSAGE_DEVELOPER).is_none());
    }

    #[test]
    fn test_parse_response_message_user_skipped() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line(RESPONSE_MESSAGE_USER).is_none());
    }

    #[test]
    fn test_parse_response_reasoning_skipped() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line(RESPONSE_REASONING).is_none());
    }

    // --- Edge cases ---

    #[test]
    fn test_parse_empty_line() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line("").is_none());
    }

    #[test]
    fn test_parse_malformed_json() {
        let parser = CodexCliParser::new();
        assert!(parser.parse_line("this is not json {{{").is_none());
    }

    #[test]
    fn test_parse_unknown_top_type() {
        let parser = CodexCliParser::new();
        let line = r#"{"timestamp":"2026-03-12T07:31:39.000Z","type":"unknown_type","payload":{}}"#;
        assert!(parser.parse_line(line).is_none());
    }

    #[test]
    fn test_parse_unknown_event_msg_subtype() {
        let parser = CodexCliParser::new();
        let line = r#"{"timestamp":"2026-03-12T07:31:39.000Z","type":"event_msg","payload":{"type":"unknown_subtype"}}"#;
        assert!(parser.parse_line(line).is_none());
    }

    #[test]
    fn test_non_function_call_events_have_empty_sub_agents() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(EVENT_TASK_STARTED).unwrap();
        assert!(event.sub_agents.is_empty());
        assert!(event.completed_sub_agent_ids.is_empty());
    }

    #[test]
    fn test_task_complete_no_tokens_if_no_token_count() {
        let parser = CodexCliParser::new();
        // task_complete without prior token_count — deltas are 0
        let event = parser.parse_line(EVENT_TASK_COMPLETE).unwrap();
        assert_eq!(event.tokens_in, None);
        assert_eq!(event.tokens_out, None);
    }

    // --- path_to_agent_id ---

    #[test]
    fn test_path_to_agent_id_standard() {
        let parser = CodexCliParser::new();
        let path = Path::new(
            "/home/user/.codex/sessions/2026/03/12/rollout-2026-03-12T08-31-38-019ce0f5-4bc7-7731-adcb-8b2c34306db1.jsonl",
        );
        assert_eq!(parser.path_to_agent_id(path), "log-codex--019ce0f5");
    }

    #[test]
    fn test_path_to_agent_id_different_uuid() {
        let parser = CodexCliParser::new();
        let path = Path::new(
            "/home/user/.codex/sessions/2026/03/07/rollout-2026-03-07T08-48-58-019cc745-5f68-7523-996b-ded2c130e905.jsonl",
        );
        assert_eq!(parser.path_to_agent_id(path), "log-codex--019cc745");
    }

    #[test]
    fn test_path_to_agent_id_short_stem() {
        let parser = CodexCliParser::new();
        let path = Path::new("/home/user/.codex/sessions/2026/03/12/short.jsonl");
        assert_eq!(parser.path_to_agent_id(path), "log-codex--short");
    }

    // --- resolve_log_dirs ---

    #[test]
    fn test_resolve_log_dirs_today_and_yesterday() {
        let dir = tempfile::tempdir().unwrap();
        let today = chrono::Local::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);

        // Create today's dir
        let today_dir = dir
            .path()
            .join(today.format("%Y").to_string())
            .join(today.format("%m").to_string())
            .join(today.format("%d").to_string());
        std::fs::create_dir_all(&today_dir).unwrap();

        // Create yesterday's dir
        let yesterday_dir = dir
            .path()
            .join(yesterday.format("%Y").to_string())
            .join(yesterday.format("%m").to_string())
            .join(yesterday.format("%d").to_string());
        std::fs::create_dir_all(&yesterday_dir).unwrap();

        // Create an old dir (should be ignored)
        let old_dir = dir.path().join("2025").join("01").join("01");
        std::fs::create_dir_all(&old_dir).unwrap();

        let parser = CodexCliParser::new();
        let dirs = parser.resolve_log_dirs(dir.path());
        assert_eq!(dirs.len(), 2);
        assert!(dirs.contains(&today_dir));
        assert!(dirs.contains(&yesterday_dir));
    }

    #[test]
    fn test_resolve_log_dirs_nonexistent_root() {
        let parser = CodexCliParser::new();
        let dirs = parser.resolve_log_dirs(Path::new("/nonexistent/path"));
        assert!(dirs.is_empty());
    }

    #[test]
    fn test_resolve_log_dirs_empty_root() {
        let dir = tempfile::tempdir().unwrap();
        let parser = CodexCliParser::new();
        let dirs = parser.resolve_log_dirs(dir.path());
        assert!(dirs.is_empty());
    }

    // --- Full turn simulation ---

    #[test]
    fn test_full_turn_flow() {
        let parser = CodexCliParser::new();

        // 1. Session start
        assert!(parser.parse_line(SESSION_META).is_none());
        assert!(parser.parse_line(TURN_CONTEXT).is_none());

        // 2. Task started
        let e = parser.parse_line(EVENT_TASK_STARTED).unwrap();
        assert_eq!(e.status, Status::Thinking);
        assert_eq!(e.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(e.cwd.as_deref(), Some("/Users/user/projects/myapp"));

        // 3. User message
        let e = parser.parse_line(EVENT_USER_MESSAGE).unwrap();
        assert_eq!(e.status, Status::Thinking);

        // 4. Agent reasoning
        let e = parser.parse_line(EVENT_AGENT_REASONING).unwrap();
        assert_eq!(e.status, Status::Thinking);

        // 5. Function call (tool use)
        let e = parser.parse_line(RESPONSE_FUNCTION_CALL).unwrap();
        assert_eq!(e.status, Status::ToolUse);

        // 6. Function call output
        let e = parser.parse_line(RESPONSE_FUNCTION_CALL_OUTPUT).unwrap();
        assert_eq!(e.status, Status::ToolUse);

        // 7. Agent message
        let e = parser.parse_line(EVENT_AGENT_MESSAGE).unwrap();
        assert_eq!(e.status, Status::Responding);

        // 8. Token count
        assert!(parser.parse_line(EVENT_TOKEN_COUNT).is_none());

        // 9. Task complete
        let e = parser.parse_line(EVENT_TASK_COMPLETE).unwrap();
        assert_eq!(e.status, Status::TaskComplete);
        assert_eq!(e.tokens_in, Some(8799));
        assert_eq!(e.tokens_out, Some(23));
        assert_eq!(e.model.as_deref(), Some("gpt-5-codex"));
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

    // --- parse_parallel_bash_commands ---

    #[test]
    fn test_parse_parallel_bash_simple() {
        let cmd = "bash -lc '(npm test) & (cargo test) & wait'";
        let cmds = parse_parallel_bash_commands(cmd).unwrap();
        assert_eq!(cmds, vec!["npm test", "cargo test"]);
    }

    #[test]
    fn test_parse_parallel_bash_with_redirects() {
        let cmd = "bash -lc '(npm run test > logs/job1.log 2>&1) & (cargo test > logs/job2.log 2>&1) & (find src -type f | wc -l > logs/job3.log 2>&1) & wait'";
        let cmds = parse_parallel_bash_commands(cmd).unwrap();
        assert_eq!(cmds, vec!["npm run test", "cargo test", "find src -type f | wc -l"]);
    }

    #[test]
    fn test_parse_parallel_bash_with_dash_c() {
        let cmd = "bash -c '(echo hello) & (echo world) & wait'";
        let cmds = parse_parallel_bash_commands(cmd).unwrap();
        assert_eq!(cmds, vec!["echo hello", "echo world"]);
    }

    #[test]
    fn test_parse_non_parallel_returns_none() {
        assert!(parse_parallel_bash_commands("npm test").is_none());
        assert!(parse_parallel_bash_commands("bash -lc 'npm test'").is_none());
        assert!(parse_parallel_bash_commands("cargo build && cargo test").is_none());
    }

    #[test]
    fn test_parse_single_subshell_returns_none() {
        // A single subshell is not "parallel"
        assert!(parse_parallel_bash_commands("bash -lc '(npm test) & wait'").is_none());
    }

    // --- Sub-agent tracking via function_call / function_call_output ---

    #[test]
    fn test_function_call_creates_sub_agent() {
        let parser = CodexCliParser::new();
        let line = r#"{"timestamp":"2026-03-12T07:31:57.465Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"src/main.rs\"}","call_id":"call_single"}}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
        assert_eq!(event.sub_agents.len(), 1);
        assert_eq!(event.sub_agents[0].id, "call_single");
        assert_eq!(event.sub_agents[0].description, "read_file");
    }

    #[test]
    fn test_function_call_exec_single_creates_one_sub_agent() {
        let parser = CodexCliParser::new();
        let event = parser.parse_line(RESPONSE_FUNCTION_CALL).unwrap();
        assert_eq!(event.sub_agents.len(), 1);
        assert_eq!(event.sub_agents[0].id, "call_abc123");
        assert_eq!(event.sub_agents[0].description, "npm test");
    }

    #[test]
    fn test_function_call_exec_parallel_creates_multiple_sub_agents() {
        let parser = CodexCliParser::new();
        let line = r#"{"timestamp":"2026-03-12T07:32:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"bash -lc '(npm run test > logs/job1.log 2>&1) & (cargo test > logs/job2.log 2>&1) & (find src -type f | wc -l > logs/job3.log 2>&1) & wait'\"}","call_id":"call_parallel"}}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::ToolUse);
        assert_eq!(event.sub_agents.len(), 3);
        assert_eq!(event.sub_agents[0].id, "call_parallel:0");
        assert_eq!(event.sub_agents[0].description, "npm run test");
        assert_eq!(event.sub_agents[1].id, "call_parallel:1");
        assert_eq!(event.sub_agents[1].description, "cargo test");
        assert_eq!(event.sub_agents[2].id, "call_parallel:2");
        assert_eq!(event.sub_agents[2].description, "find src -type f | wc -l");
    }

    #[test]
    fn test_function_call_output_completes_sub_agents() {
        let parser = CodexCliParser::new();

        // First: function_call spawns sub-agents
        parser.parse_line(RESPONSE_FUNCTION_CALL).unwrap();

        // Then: function_call_output completes them
        let event = parser.parse_line(RESPONSE_FUNCTION_CALL_OUTPUT).unwrap();
        assert_eq!(event.completed_sub_agent_ids, vec!["call_abc123"]);
        assert!(event.sub_agents.is_empty());

        // Verify call is no longer tracked
        let state = parser.state.lock().unwrap();
        assert!(state.active_calls.is_empty());
    }

    #[test]
    fn test_function_call_output_parallel_completes_all() {
        let parser = CodexCliParser::new();

        // Spawn 3 parallel sub-agents
        let call_line = r#"{"timestamp":"2026-03-12T07:32:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"bash -lc '(npm test) & (cargo test) & (make lint) & wait'\"}","call_id":"call_p1"}}"#;
        let spawn_event = parser.parse_line(call_line).unwrap();
        assert_eq!(spawn_event.sub_agents.len(), 3);

        // Complete them all at once
        let output_line = r#"{"timestamp":"2026-03-12T07:32:10.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_p1","output":"done"}}"#;
        let complete_event = parser.parse_line(output_line).unwrap();
        assert_eq!(complete_event.completed_sub_agent_ids.len(), 3);
        assert_eq!(complete_event.completed_sub_agent_ids[0], "call_p1:0");
        assert_eq!(complete_event.completed_sub_agent_ids[1], "call_p1:1");
        assert_eq!(complete_event.completed_sub_agent_ids[2], "call_p1:2");
    }

    #[test]
    fn test_concurrent_calls_partial_completion() {
        let parser = CodexCliParser::new();

        // Two concurrent function calls
        let call1 = r#"{"timestamp":"2026-03-12T07:32:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm test\"}","call_id":"call_a"}}"#;
        let call2 = r#"{"timestamp":"2026-03-12T07:32:00.100Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"foo.rs\"}","call_id":"call_b"}}"#;

        parser.parse_line(call1).unwrap();
        parser.parse_line(call2).unwrap();

        // Verify 2 active calls
        {
            let state = parser.state.lock().unwrap();
            assert_eq!(state.active_calls.len(), 2);
        }

        // Complete call_a only
        let output_a = r#"{"timestamp":"2026-03-12T07:32:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_a","output":"ok"}}"#;
        let event = parser.parse_line(output_a).unwrap();
        assert_eq!(event.completed_sub_agent_ids, vec!["call_a"]);

        // call_b still active
        {
            let state = parser.state.lock().unwrap();
            assert_eq!(state.active_calls.len(), 1);
            assert!(state.active_calls.contains_key("call_b"));
        }

        // Complete call_b
        let output_b = r#"{"timestamp":"2026-03-12T07:32:06.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_b","output":"contents"}}"#;
        let event = parser.parse_line(output_b).unwrap();
        assert_eq!(event.completed_sub_agent_ids, vec!["call_b"]);

        let state = parser.state.lock().unwrap();
        assert!(state.active_calls.is_empty());
    }

    #[test]
    fn test_function_call_output_unknown_call_id() {
        let parser = CodexCliParser::new();
        // Output for a call_id we never saw — should not panic
        let line = r#"{"timestamp":"2026-03-12T07:32:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_unknown","output":"?"}}"#;
        let event = parser.parse_line(line).unwrap();
        assert!(event.completed_sub_agent_ids.is_empty());
    }
}
