// Windsurf IDE parser — detects AI activity via file modification monitoring.
// Windsurf (Codeium) stores data in Protobuf files across multiple directories:
//   ~/.codeium/windsurf/cascade/ — agentic/cascade tasks (current)
//   ~/.codeium/cascade/          — agentic tasks (legacy)
//   ~/.codeium/implicit/         — regular AI chat requests
// This parser consumes synthetic activity events from FileActivityReader.

use super::parsed_event::ParsedEvent;
use super::parser_trait::AgentLogParser;
use crate::discovery::file_activity_reader::FileActivityReader;
use crate::discovery::log_reader::LogFileReader;
use crate::models::Status;
use std::path::{Path, PathBuf};

/// Parser for Windsurf IDE AI activity.
/// Uses file modification timestamps as a proxy for AI usage.
pub struct WindsurfIdeParser;

impl AgentLogParser for WindsurfIdeParser {
    fn name(&self) -> &str {
        "windsurf-ide"
    }

    fn model_hint(&self) -> &str {
        "windsurf"
    }

    fn can_parse(&self, path: &Path, _first_line: &str) -> bool {
        path.components()
            .any(|c| c.as_os_str().to_string_lossy() == ".codeium")
    }

    fn parse_line(&self, line: &str) -> Option<ParsedEvent> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v.get("type")?.as_str()? != "activity" {
            return None;
        }
        let timestamp = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        Some(ParsedEvent {
            status: Status::Thinking,
            model: None,
            current_task: None,
            tokens_in: None,
            tokens_out: None,
            sub_agents: vec![],
            completed_sub_agent_ids: vec![],
            timestamp,
            cwd: None,
        })
    }

    fn path_to_agent_id(&self, _path: &Path) -> String {
        "log-windsurf--activity".to_string()
    }

    fn log_roots(&self) -> Vec<PathBuf> {
        dirs::home_dir()
            .map(|h| {
                vec![
                    h.join(".codeium").join("windsurf").join("cascade"),
                    h.join(".codeium").join("implicit"),
                    h.join(".codeium").join("cascade"),
                ]
            })
            .unwrap_or_default()
    }

    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf> {
        // Flat directory — monitor files directly in root
        if root.exists() {
            vec![root.to_path_buf()]
        } else {
            vec![]
        }
    }

    fn create_reader(&self) -> Box<dyn LogFileReader> {
        Box::new(FileActivityReader::new(
            "windsurf",
            vec![".codeium".to_string()],
        ))
    }

    fn activity_timeout_ms(&self) -> Option<u64> {
        Some(15_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_name_and_hint() {
        let parser = WindsurfIdeParser;
        assert_eq!(parser.name(), "windsurf-ide");
        assert_eq!(parser.model_hint(), "windsurf");
    }

    #[test]
    fn test_activity_timeout() {
        let parser = WindsurfIdeParser;
        assert_eq!(parser.activity_timeout_ms(), Some(15_000));
    }

    #[test]
    fn test_can_parse() {
        let parser = WindsurfIdeParser;
        assert!(parser.can_parse(
            Path::new("/home/user/.codeium/cascade/abc123.pb"),
            ""
        ));
        assert!(parser.can_parse(
            Path::new("/home/user/.codeium/windsurf/cascade/abc123.pb"),
            ""
        ));
        assert!(!parser.can_parse(
            Path::new("/home/user/.cursor/ai-tracking/db.sqlite"),
            ""
        ));
        // Must not match paths where ".codeium" is a substring of another component
        assert!(!parser.can_parse(
            Path::new("/home/user/my.codeium.backup/file.pb"),
            ""
        ));
    }

    #[test]
    fn test_parse_activity_event() {
        let parser = WindsurfIdeParser;
        let line =
            r#"{"type":"activity","source":"windsurf","timestamp":"2026-03-27T10:00:00Z"}"#;
        let event = parser.parse_line(line).unwrap();
        assert_eq!(event.status, Status::Thinking);
        assert_eq!(event.timestamp, "2026-03-27T10:00:00Z");
    }

    #[test]
    fn test_parse_non_activity_returns_none() {
        let parser = WindsurfIdeParser;
        assert!(parser.parse_line(r#"{"type":"other"}"#).is_none());
        assert!(parser.parse_line("not json").is_none());
    }

    #[test]
    fn test_path_to_agent_id() {
        let parser = WindsurfIdeParser;
        assert_eq!(
            parser.path_to_agent_id(Path::new("/home/user/.codeium/cascade/abc.pb")),
            "log-windsurf--activity"
        );
        assert_eq!(
            parser.path_to_agent_id(Path::new("/home/user/.codeium/windsurf/cascade/abc.pb")),
            "log-windsurf--activity"
        );
    }

    #[test]
    fn test_log_roots_contain_all_paths() {
        let parser = WindsurfIdeParser;
        let roots = parser.log_roots();
        if let Some(home) = dirs::home_dir() {
            let cascade_path = home.join(".codeium").join("windsurf").join("cascade");
            let implicit_path = home.join(".codeium").join("implicit");
            let legacy_path = home.join(".codeium").join("cascade");
            assert!(roots.contains(&cascade_path), "missing windsurf cascade path");
            assert!(roots.contains(&implicit_path), "missing implicit path");
            assert!(roots.contains(&legacy_path), "missing legacy cascade path");
            assert_eq!(roots.len(), 3);
        }
    }
}
