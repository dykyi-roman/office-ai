// Cursor IDE parser — detects AI activity via agent transcript JSONL files.
// Cursor writes real-time conversation logs to:
//   ~/.cursor/projects/{project-slug}/agent-transcripts/{session-uuid}/{session-uuid}.jsonl
//
// Format:
//   {"role":"user","message":{"content":[{"type":"text","text":"<user_query>\n...\n</user_query>"}]}}
//   {"role":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//
// Note: ~/.cursor/ai-tracking/ai-code-tracking.db was tested but rejected — it is
// a background analytics database (code hashes, commit scoring) that does NOT update
// in real-time when the user sends prompts.

use super::parsed_event::ParsedEvent;
use super::parser_trait::AgentLogParser;
use crate::discovery::log_reader::{JsonlReader, LogFileReader};
use crate::models::Status;
use std::path::{Path, PathBuf};

/// Parser for Cursor IDE AI agent transcripts.
/// Reads JSONL conversation logs from `~/.cursor/projects/*/agent-transcripts/*/`.
pub struct CursorIdeParser;

/// Extract text between `<user_query>` and `</user_query>` tags.
fn extract_user_query(text: &str) -> Option<&str> {
    let start_tag = "<user_query>";
    let end_tag = "</user_query>";
    let start = text.find(start_tag)? + start_tag.len();
    let end = text.find(end_tag)?;
    let query = text[start..end].trim();
    if query.is_empty() {
        None
    } else {
        Some(query)
    }
}

/// Truncate text to `max_len` chars, appending "..." if truncated.
fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        let boundary = text
            .char_indices()
            .nth(max_len)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        format!("{}...", &text[..boundary])
    }
}

impl AgentLogParser for CursorIdeParser {
    fn name(&self) -> &str {
        "cursor-ide"
    }

    fn model_hint(&self) -> &str {
        "cursor"
    }

    fn can_parse(&self, path: &Path, _first_line: &str) -> bool {
        let has_cursor = path
            .components()
            .any(|c| c.as_os_str().to_string_lossy() == ".cursor");
        let has_transcripts = path
            .components()
            .any(|c| c.as_os_str().to_string_lossy() == "agent-transcripts");
        has_cursor && has_transcripts
    }

    fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        let role = v.get("role")?.as_str()?;

        let timestamp = chrono::Utc::now().to_rfc3339();

        match role {
            "user" => {
                let task = v
                    .pointer("/message/content/0/text")
                    .and_then(|t| t.as_str())
                    .and_then(extract_user_query)
                    .map(|s| truncate_text(s, 200));

                Some(ParsedEvent {
                    status: Status::Thinking,
                    model: None,
                    current_task: task,
                    tokens_in: None,
                    tokens_out: None,
                    sub_agents: vec![],
                    completed_sub_agent_ids: vec![],
                    timestamp,
                    cwd: None,
                })
            }
            "assistant" => Some(ParsedEvent {
                status: Status::Responding,
                model: None,
                current_task: None,
                tokens_in: None,
                tokens_out: None,
                sub_agents: vec![],
                completed_sub_agent_ids: vec![],
                timestamp,
                cwd: None,
            }),
            _ => None,
        }
    }

    fn path_to_agent_id(&self, path: &Path) -> String {
        // Path: ~/.cursor/projects/{project}/agent-transcripts/{session-uuid}/{session-uuid}.jsonl
        // Parent directory name is the session UUID
        let session_id = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let prefix = if session_id.len() > 8 {
            &session_id[..8]
        } else {
            &session_id
        };

        format!("log-cursor--{prefix}")
    }

    fn log_roots(&self) -> Vec<PathBuf> {
        dirs::home_dir()
            .map(|h| vec![h.join(".cursor").join("projects")])
            .unwrap_or_default()
    }

    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf> {
        // Return stable agent-transcripts/ directories (not session-uuid/ subdirs).
        // The log watcher's collect_files() descends one level into subdirectories,
        // automatically discovering new session directories created after app start.
        let mut dirs = Vec::new();
        if !root.exists() {
            return dirs;
        }
        let Ok(projects) = std::fs::read_dir(root) else {
            return dirs;
        };
        for project in projects.flatten() {
            let transcripts_dir = project.path().join("agent-transcripts");
            if transcripts_dir.is_dir() {
                dirs.push(transcripts_dir);
            }
        }
        dirs
    }

    fn create_reader(&self) -> Box<dyn LogFileReader> {
        Box::new(JsonlReader::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_name_and_hint() {
        let parser = CursorIdeParser;
        assert_eq!(parser.name(), "cursor-ide");
        assert_eq!(parser.model_hint(), "cursor");
    }

    #[test]
    fn test_can_parse_cursor_transcript_path() {
        let parser = CursorIdeParser;
        assert!(parser.can_parse(
            Path::new("/home/user/.cursor/projects/my-project/agent-transcripts/abc123/abc123.jsonl"),
            ""
        ));
    }

    #[test]
    fn test_can_parse_rejects_claude_path() {
        let parser = CursorIdeParser;
        assert!(!parser.can_parse(
            Path::new("/home/user/.claude/projects/test/abc.jsonl"),
            ""
        ));
    }

    #[test]
    fn test_can_parse_rejects_old_tracking_path() {
        let parser = CursorIdeParser;
        // The old ai-tracking path has no agent-transcripts component
        assert!(!parser.can_parse(
            Path::new("/home/user/.cursor/ai-tracking/db.sqlite"),
            ""
        ));
    }

    #[test]
    fn test_can_parse_rejects_gemini_path() {
        let parser = CursorIdeParser;
        assert!(!parser.can_parse(
            Path::new("/home/user/.gemini/tmp/session/chats/session-1.json"),
            ""
        ));
    }

    #[test]
    fn test_parse_user_message() {
        let parser = CursorIdeParser;
        let line = r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\nhello world\n</user_query>"}]}}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert_eq!(event.current_task.as_deref(), Some("hello world"));
    }

    #[test]
    fn test_parse_user_message_without_query_tags() {
        let parser = CursorIdeParser;
        let line = r#"{"role":"user","message":{"content":[{"type":"text","text":"plain text without tags"}]}}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert!(event.current_task.is_none());
    }

    #[test]
    fn test_parse_user_message_empty_query() {
        let parser = CursorIdeParser;
        let line = r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\n\n</user_query>"}]}}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert!(event.current_task.is_none());
    }

    #[test]
    fn test_parse_assistant_message() {
        let parser = CursorIdeParser;
        let line = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Here is my response"}]}}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Responding);
        assert!(event.current_task.is_none());
    }

    #[test]
    fn test_parse_unknown_role_returns_none() {
        let parser = CursorIdeParser;
        assert!(parser.parse_line(r#"{"role":"system","message":{}}"#).is_none());
        assert!(parser.parse_line(r#"{"role":"tool","message":{}}"#).is_none());
    }

    #[test]
    fn test_parse_malformed_json_returns_none() {
        let parser = CursorIdeParser;
        assert!(parser.parse_line("not json").is_none());
        assert!(parser.parse_line("").is_none());
        assert!(parser.parse_line("{}").is_none());
    }

    #[test]
    fn test_path_to_agent_id() {
        let parser = CursorIdeParser;
        assert_eq!(
            parser.path_to_agent_id(Path::new(
                "/home/user/.cursor/projects/my-project/agent-transcripts/4ee3e698-c063-4348-8098-1239a82fd788/4ee3e698-c063-4348-8098-1239a82fd788.jsonl"
            )),
            "log-cursor--4ee3e698"
        );
    }

    #[test]
    fn test_path_to_agent_id_short_name() {
        let parser = CursorIdeParser;
        assert_eq!(
            parser.path_to_agent_id(Path::new("/home/user/.cursor/projects/proj/agent-transcripts/abc/abc.jsonl")),
            "log-cursor--abc"
        );
    }

    #[test]
    fn test_log_roots_contain_cursor_projects_path() {
        let parser = CursorIdeParser;
        let roots = parser.log_roots();
        if let Some(home) = dirs::home_dir() {
            let expected = home.join(".cursor").join("projects");
            assert!(roots.contains(&expected));
        }
    }

    #[test]
    fn test_resolve_log_dirs_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // Create: root/project-a/agent-transcripts/ (with a session inside)
        let transcripts_dir = root.join("project-a").join("agent-transcripts");
        let session_dir = transcripts_dir.join("session-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("session-1.jsonl"), "{}").unwrap();

        // Create: root/project-b/ (no agent-transcripts)
        std::fs::create_dir_all(root.join("project-b")).unwrap();

        let parser = CursorIdeParser;
        let dirs = parser.resolve_log_dirs(root);
        // Returns the stable agent-transcripts/ dir, not the session dir
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0], transcripts_dir);
    }

    #[test]
    fn test_resolve_log_dirs_nonexistent_root() {
        let parser = CursorIdeParser;
        let dirs = parser.resolve_log_dirs(Path::new("/nonexistent/path"));
        assert!(dirs.is_empty());
    }

    #[test]
    fn test_extract_user_query_basic() {
        assert_eq!(
            extract_user_query("<user_query>\nhello world\n</user_query>"),
            Some("hello world")
        );
    }

    #[test]
    fn test_extract_user_query_empty() {
        assert_eq!(
            extract_user_query("<user_query>\n\n</user_query>"),
            None
        );
    }

    #[test]
    fn test_extract_user_query_no_tags() {
        assert_eq!(extract_user_query("plain text"), None);
    }

    #[test]
    fn test_truncate_text_short() {
        assert_eq!(truncate_text("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_text_long() {
        let long = "a".repeat(250);
        let result = truncate_text(&long, 200);
        assert!(result.ends_with("..."));
        assert!(result.len() <= 204); // 200 chars + "..."
    }
}
