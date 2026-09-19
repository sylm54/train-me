//! Provider/model construction from settings (port of the provider half of
//! `src/lib/agent.ts`).
//!
//! The JS transport picks the official OpenRouter provider for
//! `provider: "openrouter"` and the OpenAI provider (base URL
//! `https://api.openai.com/v1`) for `provider: "openai"`, always forcing the
//! **Chat Completions** API via `.chat()` — the default OpenAI SDK surface
//! is the Responses API, whose `item_reference`/`function_call_output` item
//! types OpenRouter and most OpenAI-compatible providers don't understand.
//!
//! rig's `providers::openai` / `providers::openrouter` completion models are
//! both the shared Chat Completions implementation (`/chat/completions` —
//! the Responses API lives in a separate `responses_api` module this module
//! never touches), which is exactly the surface the JS `.chat()` call
//! selects. Verified against rig-core 0.42.0 sources.
//!
//! Reasoning effort plumbing: rig 0.42's request builders have no first-class
//! reasoning option, but `CompletionRequest.additional_params` is
//! `#[serde(flatten)]`-ed into the JSON body verbatim — so the effort is
//! passed through as provider-native body fields, no fork needed:
//!   - OpenRouter: `{"reasoning": {"enabled": true, "effort": "…"}}`
//!     (mirrors the JS `includeReasoning: true` model setting plus the
//!     `openrouter.reasoning.effort` provider option)
//!   - OpenAI: `{"reasoning_effort": "…"}` (mirrors the JS
//!     `openai.reasoningEffort` provider option; the JS `forceReasoning`
//!     flag is an SDK-side output shim with no chat-completions body field,
//!     so it has nothing to map to and is dropped with a debug log).

use rig_core as rig;
use rig::client::CompletionClient;
use rig::completion::{CompletionError, CompletionRequest, CompletionResponse};
use rig::streaming::StreamingCompletionResponse;

use crate::settings::AgentSettings;

/// The configured LLM handle for one agent: provider client + model string
/// + best-effort reasoning-effort body params.
pub struct ModelHandle {
    /// The exact model string from settings (sent verbatim).
    pub model: String,
    inner: AnyModel,
    /// Flattened into every request's body when the agent has a
    /// `reasoningEffort` configured (see module docs).
    pub reasoning_params: Option<serde_json::Value>,
}

enum AnyModel {
    OpenRouter(rig::providers::openrouter::CompletionModel),
    /// The Chat Completions flavor. IMPORTANT: rig's default `openai::Client`
    /// maps `completion_model` to the **Responses API** — the same trap the
    /// JS transport avoids with `.chat()` (OpenRouter and most
    /// OpenAI-compatible providers don't understand Responses item types).
    /// `CompletionsClient` is the client extension whose `completion_model`
    /// is the shared `/chat/completions` implementation.
    OpenAi(rig::providers::openai::completion::CompletionModel),
}

impl ModelHandle {
    /// Stream one completion (the multi-turn loop only ever streams).
    pub async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse, CompletionError> {
        match &self.inner {
            AnyModel::OpenRouter(m) => rig::completion::CompletionModel::stream(m, request).await,
            AnyModel::OpenAi(m) => rig::completion::CompletionModel::stream(m, request).await,
        }
    }

    /// One non-streaming completion (the compaction summarizer — the JS
    /// summarizer uses `generateText`).
    pub async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, CompletionError> {
        match &self.inner {
            AnyModel::OpenRouter(m) => rig::completion::CompletionModel::completion(m, request).await,
            AnyModel::OpenAi(m) => rig::completion::CompletionModel::completion(m, request).await,
        }
    }
}

/// Build the model handle for `agent` (`"main"` today) from settings.
/// Fails with the SAME user-facing message the JS transport throws when the
/// provider has no API key — Stage 3b surfaces it identically.
pub fn build(settings: &AgentSettings, agent: &str) -> Result<ModelHandle, String> {
    let cfg = settings
        .agents
        .get(agent)
        .ok_or_else(|| format!("no model configured for agent \"{agent}\""))?;
    let api_key = settings
        .api_keys
        .get(&cfg.provider)
        .and_then(|k| k.as_deref())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            format!(
                "No API key configured for provider \"{}\". Open Settings and add your API key.",
                cfg.provider
            )
        })?;

    let effort = cfg.reasoning_effort.as_deref().filter(|e| !e.is_empty());

    match cfg.provider.as_str() {
        "openrouter" => {
            let client = rig::providers::openrouter::Client::new(api_key)
                .map_err(|e| format!("openrouter client: {e}"))?;
            Ok(ModelHandle {
                model: cfg.model.clone(),
                inner: AnyModel::OpenRouter(client.completion_model(&cfg.model)),
                reasoning_params: effort.map(|e| {
                    serde_json::json!({ "reasoning": { "enabled": true, "effort": e } })
                }),
            })
        }
        "openai" => {
            // Chat Completions client (NOT the default Responses client —
            // see AnyModel::OpenAi). Its default base URL is already
            // `https://api.openai.com/v1`, the same URL the JS transport
            // passes explicitly via PROVIDER_BASE_URL.
            let client = rig::providers::openai::CompletionsClient::new(api_key)
                .map_err(|e| format!("openai client: {e}"))?;
            if effort.is_some() {
                log::debug!(
                    "reasoning effort {:?}: passing `reasoning_effort` in the chat-completions body; \
                     the JS provider's `forceReasoning` output shim has no body field to map",
                    effort
                );
            }
            Ok(ModelHandle {
                model: cfg.model.clone(),
                inner: AnyModel::OpenAi(client.completion_model(&cfg.model)),
                reasoning_params: effort.map(|e| serde_json::json!({ "reasoning_effort": e })),
            })
        }
        other => Err(format!("unknown provider \"{other}\" for agent \"{agent}\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn settings(provider: &str, key: Option<&str>, effort: Option<&str>) -> AgentSettings {
        let mut s = AgentSettings::with_default_agent();
        s.agents.insert(
            "main".into(),
            crate::settings::AgentModelConfig {
                provider: provider.into(),
                model: "test-model".into(),
                reasoning_effort: effort.map(str::to_string),
            },
        );
        let mut keys = HashMap::new();
        if let Some(k) = key {
            keys.insert(provider.to_string(), Some(k.to_string()));
        }
        s.api_keys = keys;
        s
    }

    #[test]
    fn missing_key_fails_with_js_message() {
        let s = settings("openrouter", None, None);
        let err = match build(&s, "main") {
            Err(e) => e,
            Ok(_) => panic!("expected missing-key error"),
        };
        assert_eq!(
            err,
            "No API key configured for provider \"openrouter\". Open Settings and add your API key."
        );

        // An explicit null key behaves like an absent one (the TS type is
        // Partial<Record<ProviderName, string>>).
        let mut s = settings("openai", None, None);
        s.api_keys.insert("openai".into(), None);
        assert!(build(&s, "main").is_err());
    }

    #[test]
    fn openrouter_reasoning_params_match_js_options() {
        let s = settings("openrouter", Some("sk"), Some("high"));
        let h = build(&s, "main").unwrap();
        assert_eq!(h.reasoning_params, Some(serde_json::json!({"reasoning": {"enabled": true, "effort": "high"}})));

        // No effort → no extra body params.
        let s = settings("openrouter", Some("sk"), None);
        let h = build(&s, "main").unwrap();
        assert!(h.reasoning_params.is_none());
    }

    #[test]
    fn openai_reasoning_params_and_unknown_provider() {
        let s = settings("openai", Some("sk"), Some("xhigh"));
        let h = build(&s, "main").unwrap();
        assert_eq!(h.reasoning_params, Some(serde_json::json!({"reasoning_effort": "xhigh"})));

        let s = settings("anthropic", Some("sk"), None);
        assert!(build(&s, "main").is_err());
    }
}
