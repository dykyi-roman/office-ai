// Application configuration
// Loaded from ~/.config/office-ai/config.toml

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_scan_interval")]
    pub scan_interval_ms: u64,

    #[serde(default)]
    pub custom_log_paths: Vec<PathBuf>,

    #[serde(default = "default_idle_timeout")]
    pub idle_timeout_ms: u64,

    #[serde(default = "default_max_agents")]
    pub max_agents: u32,

    #[serde(default = "default_theme")]
    pub theme: String,

    #[serde(default = "default_sound_enabled")]
    pub sound_enabled: bool,

    #[serde(default = "default_debounce")]
    pub state_debounce_ms: u64,

    #[serde(default = "default_animation_speed")]
    pub animation_speed: f64,

    #[serde(default = "default_show_agent_metrics")]
    pub show_agent_metrics: bool,

    /// Regex patterns for detecting AI agent processes by name/cmdline.
    /// Default: ["claude", "node.*claude"]
    #[serde(default = "default_agent_process_patterns")]
    pub agent_process_patterns: Vec<String>,

    /// Root directories to watch for agent log files.
    /// Default: [~/.claude/projects]
    #[serde(default = "default_log_roots")]
    pub log_roots: Vec<PathBuf>,

    /// Safety timeout (ms) for Thinking/ToolUse statuses.
    /// If no JSONL events arrive within this period, the agent transitions to Idle.
    /// Default: 120000 (120s)
    #[serde(default = "default_work_timeout")]
    pub work_timeout_ms: u64,

    /// Inactivity timeout (ms) for Responding status.
    /// If no JSONL events arrive within this period, the agent transitions to Idle.
    /// Default: 30000 (30s)
    #[serde(default = "default_responding_timeout")]
    pub responding_timeout_ms: u64,
}

fn default_scan_interval() -> u64 {
    2000
}

fn default_idle_timeout() -> u64 {
    3000
}

fn default_max_agents() -> u32 {
    20
}

fn default_theme() -> String {
    "modern".to_string()
}

fn default_sound_enabled() -> bool {
    false
}

fn default_debounce() -> u64 {
    300
}

fn default_animation_speed() -> f64 {
    1.0
}

fn default_show_agent_metrics() -> bool {
    true
}

fn default_agent_process_patterns() -> Vec<String> {
    vec!["claude".to_string(), "node.*claude".to_string()]
}

fn default_work_timeout() -> u64 {
    120_000
}

fn default_responding_timeout() -> u64 {
    30_000
}

fn default_log_roots() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|h| vec![h.join(".claude").join("projects")])
        .unwrap_or_default()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            scan_interval_ms: default_scan_interval(),
            custom_log_paths: Vec::new(),
            idle_timeout_ms: default_idle_timeout(),
            max_agents: default_max_agents(),
            theme: default_theme(),
            sound_enabled: default_sound_enabled(),
            state_debounce_ms: default_debounce(),
            animation_speed: default_animation_speed(),
            show_agent_metrics: default_show_agent_metrics(),
            agent_process_patterns: default_agent_process_patterns(),
            log_roots: default_log_roots(),
            work_timeout_ms: default_work_timeout(),
            responding_timeout_ms: default_responding_timeout(),
        }
    }
}

impl AppConfig {
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("office-ai")
            .join("config.toml")
    }
}
