// Bug report data structures
// Rust-only — not mirrored in TypeScript (written directly to file, not sent via IPC)

use serde::Serialize;

use super::agent_state::AppStats;
use super::config::AppConfig;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BugReport {
    pub generated_at: String,
    pub app_version: String,
    pub os: OsInfo,
    pub config: AppConfig,
    pub stats: AppStats,
    pub recent_logs: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub name: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_count: usize,
    pub total_memory_mb: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bug_report_serializes_camel_case() {
        let report = BugReport {
            generated_at: "2026-03-02T14:30:00Z".to_string(),
            app_version: "0.1.0".to_string(),
            os: OsInfo {
                name: "macOS".to_string(),
                os_version: "15.2.0".to_string(),
                arch: "aarch64".to_string(),
                cpu_count: 10,
                total_memory_mb: 16384,
            },
            config: AppConfig::default(),
            stats: AppStats {
                total_agents: 3,
                active_agents: 1,
                total_tokens_in: 15420,
                total_tokens_out: 8230,
                uptime_seconds: 3600,
            },
            recent_logs: vec!["[14:29:50.123] [SCANNER] test".to_string()],
        };

        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("generatedAt"));
        assert!(json.contains("appVersion"));
        assert!(json.contains("osVersion"));
        assert!(json.contains("cpuCount"));
        assert!(json.contains("totalMemoryMb"));
        assert!(json.contains("totalAgents"));
        assert!(json.contains("activeAgents"));
        assert!(json.contains("recentLogs"));
    }

    #[test]
    fn test_os_info_serializes_camel_case() {
        let info = OsInfo {
            name: "Linux".to_string(),
            os_version: "6.1.0".to_string(),
            arch: "x86_64".to_string(),
            cpu_count: 8,
            total_memory_mb: 32768,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"osVersion\""));
        assert!(json.contains("\"cpuCount\""));
        assert!(json.contains("\"totalMemoryMb\""));
        assert!(!json.contains("os_version"));
    }
}
