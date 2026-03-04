// Custom application error types
// All domain errors are mapped here for consistent error handling

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Agent not found: {0}")]
    AgentNotFound(String),

    #[error("Config error: {0}")]
    ConfigError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    SerdeError(#[from] serde_json::Error),

    #[error("File watch error: {0}")]
    WatchError(String),

    #[error("Tauri error: {0}")]
    TauriError(String),
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}
