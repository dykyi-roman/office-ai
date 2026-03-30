// Application configuration
// Loaded from ~/.config/office-ai/config.toml

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// Default: ["claude", "node.*claude", "gemini", "node.*gemini"]
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

    /// Enable verbose diagnostic logging (e.g. scanner "filtered out" messages).
    /// Default: false
    #[serde(default)]
    pub debug_mode: bool,

    /// User-defined keyword → model mappings for process detection.
    /// Checked before built-in MODEL_KEYWORDS, so custom entries take priority.
    /// Example in config.toml:
    /// ```toml
    /// [customModelKeywords]
    /// windsurf = "windsurf"
    /// cody = "cody"
    /// ```
    #[serde(default)]
    pub custom_model_keywords: HashMap<String, String>,

    /// Port for the HTTP server that receives Chrome extension messages.
    /// Default: 7842
    #[serde(default = "default_extension_port")]
    pub extension_port: u16,
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
    vec![
        "claude".to_string(),
        "node.*claude".to_string(),
        "gemini".to_string(),
        "node.*gemini".to_string(),
        "codex".to_string(),
        "node.*codex".to_string(),
        "^Cursor$".to_string(),
        "^Windsurf$".to_string(),
    ]
}

fn default_work_timeout() -> u64 {
    120_000
}

fn default_responding_timeout() -> u64 {
    30_000
}

fn default_extension_port() -> u16 {
    7842
}

fn default_log_roots() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|h| {
            vec![
                h.join(".claude").join("projects"),
                h.join(".gemini").join("tmp"),
                h.join(".codex").join("sessions"),
            ]
        })
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
            debug_mode: false,
            custom_model_keywords: HashMap::new(),
            extension_port: default_extension_port(),
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

    /// Ensure all default patterns and log roots are present.
    /// Called after loading config from disk to migrate old configs
    /// that were saved before new defaults were added.
    pub fn ensure_defaults(&mut self) -> bool {
        let mut changed = false;
        let defaults = default_agent_process_patterns();
        for pattern in &defaults {
            if !self.agent_process_patterns.contains(pattern) {
                self.agent_process_patterns.push(pattern.clone());
                changed = true;
            }
        }
        let default_roots = default_log_roots();
        for root in &default_roots {
            if !self.log_roots.contains(root) {
                self.log_roots.push(root.clone());
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ensure_defaults_adds_missing_patterns() {
        let mut config = AppConfig {
            agent_process_patterns: vec!["claude".to_string(), "node.*claude".to_string()],
            ..AppConfig::default()
        };
        let changed = config.ensure_defaults();
        assert!(changed);
        assert!(config
            .agent_process_patterns
            .contains(&"gemini".to_string()));
        assert!(config
            .agent_process_patterns
            .contains(&"node.*gemini".to_string()));
        assert!(config.agent_process_patterns.contains(&"codex".to_string()));
        assert!(config
            .agent_process_patterns
            .contains(&"node.*codex".to_string()));
    }

    #[test]
    fn test_ensure_defaults_noop_when_complete() {
        let mut config = AppConfig::default();
        let changed = config.ensure_defaults();
        assert!(!changed);
    }

    #[test]
    fn test_ensure_defaults_preserves_custom_patterns() {
        let mut config = AppConfig {
            agent_process_patterns: vec![
                "claude".to_string(),
                "node.*claude".to_string(),
                "my-custom-agent".to_string(),
            ],
            ..AppConfig::default()
        };
        config.ensure_defaults();
        assert!(config
            .agent_process_patterns
            .contains(&"my-custom-agent".to_string()));
        assert!(config
            .agent_process_patterns
            .contains(&"gemini".to_string()));
    }

    #[test]
    fn test_default_patterns_include_gemini() {
        let defaults = default_agent_process_patterns();
        assert!(defaults.contains(&"gemini".to_string()));
        assert!(defaults.contains(&"node.*gemini".to_string()));
    }

    #[test]
    fn test_default_patterns_include_codex() {
        let defaults = default_agent_process_patterns();
        assert!(defaults.contains(&"codex".to_string()));
        assert!(defaults.contains(&"node.*codex".to_string()));
    }

    #[test]
    fn test_default_debug_mode_is_false() {
        let config = AppConfig::default();
        assert!(!config.debug_mode);
    }

    #[test]
    fn test_default_patterns_include_cursor_windsurf() {
        let defaults = default_agent_process_patterns();
        assert!(defaults.contains(&"^Cursor$".to_string()));
        assert!(defaults.contains(&"^Windsurf$".to_string()));
    }

    #[test]
    fn test_ensure_defaults_adds_cursor_windsurf() {
        let mut config = AppConfig {
            agent_process_patterns: vec![
                "claude".to_string(),
                "node.*claude".to_string(),
                "gemini".to_string(),
                "node.*gemini".to_string(),
                "codex".to_string(),
                "node.*codex".to_string(),
            ],
            ..AppConfig::default()
        };
        let changed = config.ensure_defaults();
        assert!(changed);
        assert!(config.agent_process_patterns.contains(&"^Cursor$".to_string()));
        assert!(config
            .agent_process_patterns
            .contains(&"^Windsurf$".to_string()));
    }

    #[test]
    fn test_default_log_roots_include_gemini() {
        let roots = default_log_roots();
        let has_gemini = roots
            .iter()
            .any(|r| r.to_string_lossy().contains(".gemini"));
        assert!(has_gemini);
    }

    #[test]
    fn test_default_log_roots_include_codex() {
        let roots = default_log_roots();
        let has_codex = roots.iter().any(|r| r.to_string_lossy().contains(".codex"));
        assert!(has_codex);
    }
}
