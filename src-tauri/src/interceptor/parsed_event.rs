// Parsed event extracted from agent log lines.
// Shared by all agent parsers — lives in its own module to avoid circular dependencies.

use crate::models::{Status, SubAgentInfo};

/// Parsed event extracted from a single log line.
/// All agent parsers produce this common type regardless of log format.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEvent {
    pub status: Status,
    pub model: Option<String>,
    pub current_task: Option<String>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub sub_agents: Vec<SubAgentInfo>,
    /// IDs of sub-agents that completed (from tool_result blocks matching sub-agent tool_use IDs)
    pub completed_sub_agent_ids: Vec<String>,
    pub timestamp: String,
    /// Working directory from the log entry (used for agent <-> process correlation)
    pub cwd: Option<String>,
}
