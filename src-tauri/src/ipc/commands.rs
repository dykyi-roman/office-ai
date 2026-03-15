// Tauri invoke commands
// Exposed to frontend via tauri::Builder::invoke_handler

use crate::discovery::agent_registry::AgentRegistry;
use crate::models::{AgentState, AppConfig, AppStats, BugReport, OsInfo};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::RwLock;

/// Shared application state managed by Tauri.
pub struct AppState {
    pub registry: Arc<RwLock<AgentRegistry>>,
    pub config: Arc<RwLock<AppConfig>>,
    pub start_time: Instant,
}

impl AppState {
    pub fn new(registry: Arc<RwLock<AgentRegistry>>, config: Arc<RwLock<AppConfig>>) -> Self {
        Self {
            registry,
            config,
            start_time: Instant::now(),
        }
    }
}

/// Return all currently registered agents.
#[tauri::command]
pub async fn get_all_agents(state: State<'_, AppState>) -> Result<Vec<AgentState>, String> {
    let registry = state.registry.read().await;
    Ok(registry.get_all())
}

/// Return a single agent by id, or None if not found.
#[tauri::command]
pub async fn get_agent(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentState>, String> {
    let registry = state.registry.read().await;
    Ok(registry.get(&id))
}

/// Return current config as a JSON object with frontend-compatible keys.
#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state.config.read().await;
    Ok(serde_json::json!({
        "theme": config.theme,
        "soundEnabled": config.sound_enabled,
        "showAgentMetrics": config.show_agent_metrics,
        "animationSpeed": config.animation_speed,
        "scanInterval": config.scan_interval_ms / 1000,
        "maxAgents": config.max_agents,
        "customLogPaths": config.custom_log_paths.iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        "debugMode": config.debug_mode,
    }))
}

/// Update a config value by key.
/// Supported keys: scan_interval_ms, idle_timeout_ms, state_debounce_ms, work_timeout_ms,
///                  responding_timeout_ms, theme, sound_enabled, show_agent_metrics,
///                  animation_speed, max_agents
#[tauri::command]
pub async fn set_config(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    app_log!("CONFIG", "set_config: {}={}", key, value);
    let mut config = state.config.write().await;
    apply_config_value(&mut config, &key, &value)?;
    let result = persist_config(&config);
    if result.is_ok() {
        app_log!("CONFIG", "config persisted to disk");
    } else {
        app_log!(
            "CONFIG",
            "config persist failed: {:?}",
            result.as_ref().err()
        );
    }
    result
}

/// Return aggregate statistics about all agents.
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<AppStats, String> {
    let registry = state.registry.read().await;
    let uptime = state.start_time.elapsed().as_secs();

    Ok(AppStats {
        total_agents: registry.len() as u32,
        active_agents: registry.active_count(),
        total_tokens_in: registry.total_tokens_in(),
        total_tokens_out: registry.total_tokens_out(),
        uptime_seconds: uptime,
    })
}

/// Collect OS information for bug reports.
fn collect_os_info() -> OsInfo {
    let sys = sysinfo::System::new_all();
    OsInfo {
        name: sysinfo::System::name().unwrap_or_else(|| "Unknown".to_string()),
        os_version: sysinfo::System::os_version().unwrap_or_else(|| "Unknown".to_string()),
        arch: std::env::consts::ARCH.to_string(),
        cpu_count: sys.cpus().len(),
        total_memory_mb: sys.total_memory() / (1024 * 1024),
    }
}

/// Generate a bug report JSON file and save it via a system file dialog.
#[tauri::command]
pub async fn generate_bug_report(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let os_info = collect_os_info();
    let config = state.config.read().await.clone();
    let uptime = state.start_time.elapsed().as_secs();

    let stats = {
        let registry = state.registry.read().await;
        AppStats {
            total_agents: registry.len() as u32,
            active_agents: registry.active_count(),
            total_tokens_in: registry.total_tokens_in(),
            total_tokens_out: registry.total_tokens_out(),
            uptime_seconds: uptime,
        }
    };

    let recent_logs = crate::logger::read_recent_lines(500);

    let report = BugReport {
        generated_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: os_info,
        config,
        stats,
        recent_logs,
    };

    let json = serde_json::to_string_pretty(&report)
        .map_err(|e| format!("Failed to serialize bug report: {e}"))?;

    let file_path = app
        .dialog()
        .file()
        .set_file_name("officeai-bug-report.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    if let Some(path) = file_path {
        std::fs::write(path.as_path().unwrap(), &json)
            .map_err(|e| format!("Failed to write bug report: {e}"))?;
    }

    Ok(())
}

/// Apply a single key=value update to AppConfig.
pub fn apply_config_value(config: &mut AppConfig, key: &str, value: &str) -> Result<(), String> {
    match key {
        "scanInterval" | "scan_interval_ms" => {
            let raw: u64 = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
            // Frontend sends seconds (1-10), backend stores milliseconds
            config.scan_interval_ms = if key == "scanInterval" {
                raw * 1000
            } else {
                raw
            };
        }
        "idle_timeout_ms" => {
            config.idle_timeout_ms = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
        }
        "state_debounce_ms" => {
            config.state_debounce_ms = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
        }
        "work_timeout_ms" | "workTimeoutMs" => {
            config.work_timeout_ms = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
        }
        "responding_timeout_ms" | "respondingTimeoutMs" => {
            config.responding_timeout_ms = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
        }
        "max_agents" | "maxAgents" => {
            config.max_agents = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
        }
        "animation_speed" | "animationSpeed" => {
            config.animation_speed = value
                .parse()
                .map_err(|_| format!("Invalid value for {key}: {value}"))?;
        }
        "theme" => {
            config.theme = value.to_string();
        }
        "sound_enabled" | "soundEnabled" => {
            config.sound_enabled = value
                .parse::<bool>()
                .map_err(|_| format!("Invalid boolean for {key}: {value}"))?;
        }
        "show_agent_metrics" | "showAgentMetrics" => {
            config.show_agent_metrics = value
                .parse::<bool>()
                .map_err(|_| format!("Invalid boolean for {key}: {value}"))?;
        }
        "customLogPaths" => {
            config.custom_log_paths = value
                .lines()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect();
        }
        "debug_mode" | "debugMode" => {
            config.debug_mode = value
                .parse::<bool>()
                .map_err(|_| format!("Invalid boolean for {key}: {value}"))?;
        }
        "customModelKeywords" => {
            // Accepts JSON object: {"windsurf":"windsurf","cody":"cody"}
            config.custom_model_keywords =
                serde_json::from_str(value).map_err(|e| format!("Invalid JSON for {key}: {e}"))?;
        }
        _ => {
            return Err(format!("Unknown config key: {key}"));
        }
    }
    Ok(())
}

/// Persist AppConfig to disk as TOML.
pub fn persist_config(config: &AppConfig) -> Result<(), String> {
    let path = AppConfig::config_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }

    let toml_str =
        toml::to_string(config).map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(&path, toml_str).map_err(|e| format!("Failed to write config file: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::agent_registry::AgentRegistry;
    use crate::models::{IdleLocation, Source, Status, Tier};

    fn make_agent(id: &str, status: Status, tokens_in: u64, tokens_out: u64) -> AgentState {
        AgentState {
            id: id.to_string(),
            pid: Some(1234),
            name: "claude".to_string(),
            model: "claude".to_string(),
            tier: Tier::Middle,
            role: "agent".to_string(),
            status,
            idle_location: IdleLocation::Desk,
            current_task: None,
            tokens_in,
            tokens_out,
            sub_agents: vec![],
            last_activity: "2026-01-01T00:00:00Z".to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            source: Source::Cli,
        }
    }

    fn insert_agent(registry: &mut AgentRegistry, agent: AgentState) {
        // Register without AppHandle — use the internal insert directly via test helper
        registry.insert_for_test(agent);
    }

    #[test]
    fn test_get_all_agents_empty() {
        let registry = AgentRegistry::new();
        let all = registry.get_all();
        assert!(all.is_empty());
    }

    #[test]
    fn test_get_all_agents_with_data() {
        let mut registry = AgentRegistry::new();
        insert_agent(&mut registry, make_agent("a1", Status::Idle, 0, 0));
        let all = registry.get_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "a1");
    }

    #[test]
    fn test_get_agent_found() {
        let mut registry = AgentRegistry::new();
        insert_agent(
            &mut registry,
            make_agent("find-me", Status::Thinking, 100, 50),
        );
        let found = registry.get("find-me");
        assert!(found.is_some());
        assert_eq!(found.unwrap().tokens_in, 100);
    }

    #[test]
    fn test_get_agent_not_found() {
        let registry = AgentRegistry::new();
        assert!(registry.get("does-not-exist").is_none());
    }

    #[test]
    fn test_get_stats_calculation() {
        let mut registry = AgentRegistry::new();
        insert_agent(&mut registry, make_agent("idle-1", Status::Idle, 100, 50));
        insert_agent(
            &mut registry,
            make_agent("think-1", Status::Thinking, 200, 80),
        );
        insert_agent(
            &mut registry,
            make_agent("resp-1", Status::Responding, 300, 120),
        );

        assert_eq!(registry.len(), 3);
        assert_eq!(registry.active_count(), 2); // Thinking + Responding
        assert_eq!(registry.total_tokens_in(), 600);
        assert_eq!(registry.total_tokens_out(), 250);
    }

    #[test]
    fn test_apply_config_scan_interval_ms_key() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "scan_interval_ms", "5000").unwrap();
        assert_eq!(config.scan_interval_ms, 5000);
    }

    #[test]
    fn test_apply_config_scan_interval_from_frontend() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "scanInterval", "5").unwrap();
        assert_eq!(config.scan_interval_ms, 5000);
    }

    #[test]
    fn test_apply_config_scan_interval_boundary_values() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "scanInterval", "1").unwrap();
        assert_eq!(config.scan_interval_ms, 1000);
        apply_config_value(&mut config, "scanInterval", "10").unwrap();
        assert_eq!(config.scan_interval_ms, 10000);
    }

    #[test]
    fn test_apply_config_theme() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "theme", "dark").unwrap();
        assert_eq!(config.theme, "dark");
    }

    #[test]
    fn test_apply_config_sound_enabled_false() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "sound_enabled", "false").unwrap();
        assert!(!config.sound_enabled);
    }

    #[test]
    fn test_apply_config_unknown_key() {
        let mut config = AppConfig::default();
        let result = apply_config_value(&mut config, "unknown_key", "value");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown config key"));
    }

    #[test]
    fn test_apply_config_invalid_number() {
        let mut config = AppConfig::default();
        let result = apply_config_value(&mut config, "scan_interval_ms", "not-a-number");
        assert!(result.is_err());
    }

    #[test]
    fn test_apply_config_custom_log_paths() {
        let mut config = AppConfig::default();
        apply_config_value(
            &mut config,
            "customLogPaths",
            "/path/one\n/path/two\n  \n/path/three",
        )
        .unwrap();
        assert_eq!(config.custom_log_paths.len(), 3);
        assert_eq!(config.custom_log_paths[0], PathBuf::from("/path/one"));
        assert_eq!(config.custom_log_paths[1], PathBuf::from("/path/two"));
        assert_eq!(config.custom_log_paths[2], PathBuf::from("/path/three"));
    }

    #[test]
    fn test_apply_config_work_timeout_ms() {
        let mut config = AppConfig::default();
        assert_eq!(config.work_timeout_ms, 120_000);
        apply_config_value(&mut config, "work_timeout_ms", "60000").unwrap();
        assert_eq!(config.work_timeout_ms, 60_000);
    }

    #[test]
    fn test_apply_config_work_timeout_ms_camel_case() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "workTimeoutMs", "45000").unwrap();
        assert_eq!(config.work_timeout_ms, 45_000);
    }

    #[test]
    fn test_apply_config_responding_timeout_ms() {
        let mut config = AppConfig::default();
        assert_eq!(config.responding_timeout_ms, 30_000);
        apply_config_value(&mut config, "responding_timeout_ms", "45000").unwrap();
        assert_eq!(config.responding_timeout_ms, 45_000);
    }

    #[test]
    fn test_apply_config_responding_timeout_ms_camel_case() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "respondingTimeoutMs", "20000").unwrap();
        assert_eq!(config.responding_timeout_ms, 20_000);
    }

    #[test]
    fn test_apply_config_debug_mode_true() {
        let mut config = AppConfig::default();
        assert!(!config.debug_mode);
        apply_config_value(&mut config, "debugMode", "true").unwrap();
        assert!(config.debug_mode);
    }

    #[test]
    fn test_apply_config_debug_mode_false() {
        let mut config = AppConfig::default();
        config.debug_mode = true;
        apply_config_value(&mut config, "debugMode", "false").unwrap();
        assert!(!config.debug_mode);
    }

    #[test]
    fn test_apply_config_debug_mode_snake_case() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "debug_mode", "true").unwrap();
        assert!(config.debug_mode);
    }

    #[test]
    fn test_apply_config_custom_log_paths_empty() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "customLogPaths", "").unwrap();
        assert!(config.custom_log_paths.is_empty());
    }

    #[test]
    fn test_collect_os_info_returns_non_empty_data() {
        let info = collect_os_info();
        assert!(!info.name.is_empty());
        assert!(!info.arch.is_empty());
        assert!(info.cpu_count > 0);
        assert!(info.total_memory_mb > 0);
    }

    #[test]
    fn test_set_config_persists_to_toml() {
        let mut config = AppConfig::default();
        apply_config_value(&mut config, "theme", "retro").unwrap();
        // Write to a temp path for test
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let toml_str = toml::to_string(&config).unwrap();
        std::fs::write(tmp.path(), &toml_str).unwrap();
        let read_back = std::fs::read_to_string(tmp.path()).unwrap();
        assert!(read_back.contains("retro"));
    }

    #[test]
    fn test_apply_config_custom_model_keywords() {
        let mut config = AppConfig::default();
        apply_config_value(
            &mut config,
            "customModelKeywords",
            r#"{"windsurf":"windsurf","cody":"cody"}"#,
        )
        .unwrap();
        assert_eq!(config.custom_model_keywords.len(), 2);
        assert_eq!(
            config.custom_model_keywords.get("windsurf"),
            Some(&"windsurf".to_string())
        );
        assert_eq!(
            config.custom_model_keywords.get("cody"),
            Some(&"cody".to_string())
        );
    }

    #[test]
    fn test_apply_config_custom_model_keywords_invalid_json() {
        let mut config = AppConfig::default();
        let result = apply_config_value(&mut config, "customModelKeywords", "not json");
        assert!(result.is_err());
    }
}
