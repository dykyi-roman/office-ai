// Shared data models — mirrors TypeScript types
// Source of truth: src/lib/types/*.ts
// Office layout types are defined here for future frontend use

#[allow(dead_code)]
pub mod agent_state;
pub mod bug_report;
pub mod config;

pub use agent_state::*;
pub use bug_report::*;
pub use config::AppConfig;
