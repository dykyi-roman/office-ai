// Mirrors TypeScript types in src/lib/types/agent.ts and src/lib/types/office.ts
// Source of truth: TypeScript. When adding a field — update BOTH files.

use serde::{Deserialize, Serialize};

// --- Agent types (mirrors agent.ts) ---

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Expert,
    Senior,
    Middle,
    Junior,
}

impl Tier {
    /// Infer tier from model name string.
    ///
    /// Supports Claude, Gemini, GPT, and O-series model families:
    /// - Expert: opus, ultra, gpt-4o (not mini), o1-* (not mini), o3-* (not mini)
    /// - Senior: sonnet, pro, gpt-4 (not gpt-4o)
    /// - Junior: haiku, nano, flash, gpt-3.5, mini
    /// - Middle: everything else
    pub fn from_model(model: &str) -> Self {
        let m = model.to_lowercase();

        // Junior tier — check "-mini" (hyphenated) to avoid false positive on "gemini".
        // Also check other junior-only keywords that don't appear in higher-tier names.
        if m.contains("haiku")
            || m.contains("nano")
            || m.contains("flash")
            || m.contains("gpt-3.5")
            || m.contains("-mini")
            || m.contains("codex-spark")
        {
            return Tier::Junior;
        }

        // Expert tier
        if m.contains("opus")
            || m.contains("ultra")
            || m.contains("gpt-4o")
            || m.contains("gpt-5.4")
            || m.starts_with("o1")
            || m.starts_with("o3")
        {
            return Tier::Expert;
        }

        // Senior tier
        if m.contains("sonnet")
            || m.contains("pro")
            || m.contains("gpt-4")
            || m.contains("gpt-5-codex")
            || m.contains("gpt-5.3-codex")
        {
            return Tier::Senior;
        }

        Tier::Middle
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    WalkingToDesk,
    Thinking,
    Responding,
    ToolUse,
    Collaboration,
    TaskComplete,
    Error,
    Offline,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum IdleLocation {
    WaterCooler,
    Kitchen,
    Sofa,
    MeetingRoom,
    StandingDesk,
    Desk,
    Bathroom,
    HrZone,
    Lounge,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Cli,
    BrowserExtension,
    SdkHook,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentInfo {
    pub id: String,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub id: String,
    pub pid: Option<u32>,
    pub name: String,
    pub model: String,
    pub tier: Tier,
    pub role: String,
    pub status: Status,
    pub idle_location: IdleLocation,
    pub current_task: Option<String>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub sub_agents: Vec<SubAgentInfo>,
    pub last_activity: String, // ISO 8601
    pub started_at: String,    // ISO 8601
    pub source: Source,
}

// --- Office types (mirrors office.ts) ---

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LayoutSize {
    Small,
    Medium,
    Large,
    Campus,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridPosition {
    pub col: u32,
    pub row: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeskAssignment {
    pub agent_id: String,
    pub position: GridPosition,
    pub is_occupied: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ZoneType {
    WaterCooler,
    Kitchen,
    Sofa,
    MeetingRoom,
    StandingDesk,
    Bathroom,
    HrZone,
    Lounge,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub id: String,
    #[serde(rename = "type")]
    pub zone_type: ZoneType,
    pub position: GridPosition,
    pub capacity: u32,
    pub current_occupants: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLayout {
    pub size: LayoutSize,
    pub width: u32,
    pub height: u32,
    pub desks: Vec<DeskAssignment>,
    pub zones: Vec<Zone>,
    pub walkable_grid: Vec<Vec<bool>>,
}

// --- Event payloads (mirrors events.ts) ---

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentFoundPayload {
    pub agent: AgentState,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentLostPayload {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateChangedPayload {
    pub agent: AgentState,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLayoutChangedPayload {
    pub layout: OfficeLayout,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppStats {
    pub total_agents: u32,
    pub active_agents: u32,
    pub total_tokens_in: u64,
    pub total_tokens_out: u64,
    pub uptime_seconds: u64,
}

// Tauri event name constants
pub mod event_names {
    pub const AGENT_FOUND: &str = "agent:found";
    pub const AGENT_LOST: &str = "agent:lost";
    pub const AGENT_STATE_CHANGED: &str = "agent:state-changed";
    pub const OFFICE_LAYOUT_CHANGED: &str = "office:layout-changed";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tier_from_model_opus() {
        assert_eq!(Tier::from_model("claude-opus-4"), Tier::Expert);
        assert_eq!(Tier::from_model("claude-opus-4-turbo"), Tier::Expert);
    }

    #[test]
    fn test_tier_from_model_sonnet() {
        assert_eq!(Tier::from_model("claude-sonnet-4"), Tier::Senior);
        assert_eq!(Tier::from_model("claude-sonnet-4-6"), Tier::Senior);
    }

    #[test]
    fn test_tier_from_model_haiku() {
        assert_eq!(Tier::from_model("claude-haiku-4"), Tier::Junior);
    }

    #[test]
    fn test_tier_from_model_unknown_defaults_to_middle() {
        assert_eq!(Tier::from_model("claude"), Tier::Middle);
        assert_eq!(Tier::from_model("some-custom-model"), Tier::Middle);
        // "unknown" from infer_initial_model() must also map to Middle
        assert_eq!(Tier::from_model("unknown"), Tier::Middle);
    }

    #[test]
    fn test_tier_from_model_case_insensitive() {
        assert_eq!(Tier::from_model("Claude-Opus-4"), Tier::Expert);
        assert_eq!(Tier::from_model("SONNET"), Tier::Senior);
    }

    // Gemini model family
    #[test]
    fn test_tier_from_model_gemini_ultra() {
        assert_eq!(Tier::from_model("gemini-ultra"), Tier::Expert);
    }

    #[test]
    fn test_tier_from_model_gemini_pro() {
        assert_eq!(Tier::from_model("gemini-pro"), Tier::Senior);
        assert_eq!(Tier::from_model("gemini-1.5-pro"), Tier::Senior);
    }

    #[test]
    fn test_tier_from_model_gemini_flash() {
        assert_eq!(Tier::from_model("gemini-flash"), Tier::Junior);
        assert_eq!(Tier::from_model("gemini-1.5-flash"), Tier::Junior);
    }

    #[test]
    fn test_tier_from_model_gemini_nano() {
        assert_eq!(Tier::from_model("gemini-nano"), Tier::Junior);
    }

    // GPT model family
    #[test]
    fn test_tier_from_model_gpt4o() {
        assert_eq!(Tier::from_model("gpt-4o"), Tier::Expert);
        assert_eq!(Tier::from_model("gpt-4o-2024-05-13"), Tier::Expert);
    }

    #[test]
    fn test_tier_from_model_gpt4o_mini() {
        assert_eq!(Tier::from_model("gpt-4o-mini"), Tier::Junior);
    }

    #[test]
    fn test_tier_from_model_gpt4() {
        assert_eq!(Tier::from_model("gpt-4"), Tier::Senior);
        assert_eq!(Tier::from_model("gpt-4-turbo"), Tier::Senior);
    }

    #[test]
    fn test_tier_from_model_gpt35() {
        assert_eq!(Tier::from_model("gpt-3.5-turbo"), Tier::Junior);
    }

    // O-series models
    #[test]
    fn test_tier_from_model_o1() {
        assert_eq!(Tier::from_model("o1"), Tier::Expert);
        assert_eq!(Tier::from_model("o1-preview"), Tier::Expert);
    }

    #[test]
    fn test_tier_from_model_o1_mini() {
        assert_eq!(Tier::from_model("o1-mini"), Tier::Junior);
    }

    #[test]
    fn test_tier_from_model_o3() {
        assert_eq!(Tier::from_model("o3"), Tier::Expert);
    }

    #[test]
    fn test_tier_from_model_o3_mini() {
        assert_eq!(Tier::from_model("o3-mini"), Tier::Junior);
    }

    // Codex / GPT-5 model family
    #[test]
    fn test_tier_from_model_gpt5_4() {
        assert_eq!(Tier::from_model("gpt-5.4"), Tier::Expert);
        assert_eq!(Tier::from_model("gpt-5.4-preview"), Tier::Expert);
    }

    #[test]
    fn test_tier_from_model_gpt5_codex() {
        assert_eq!(Tier::from_model("gpt-5-codex"), Tier::Senior);
        assert_eq!(Tier::from_model("gpt-5.3-codex"), Tier::Senior);
    }

    #[test]
    fn test_tier_from_model_codex_spark() {
        assert_eq!(Tier::from_model("codex-spark"), Tier::Junior);
    }

    #[test]
    fn test_tier_from_model_codex_mini() {
        assert_eq!(Tier::from_model("codex-mini"), Tier::Junior);
        assert_eq!(Tier::from_model("gpt-5.1-codex-mini"), Tier::Junior);
        assert_eq!(Tier::from_model("o4-mini"), Tier::Junior);
    }

    #[test]
    fn test_tier_from_model_gpt5_other() {
        // Generic gpt-5 models without specific keywords → Middle
        assert_eq!(Tier::from_model("gpt-5"), Tier::Middle);
        assert_eq!(Tier::from_model("gpt-5.2"), Tier::Middle);
    }
}
