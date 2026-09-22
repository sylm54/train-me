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

use std::time::Duration;

use rig_core as rig;
use rig::client::CompletionClient;
use rig::completion::{CompletionError, CompletionRequest, CompletionResponse};
use rig::streaming::StreamingCompletionResponse;

use crate::settings::AgentSettings;

/// Shared HTTP client for every provider call. Explicitly bounded on the
/// CONNECT phase: rig ships no default timeouts, so an unroutable provider
/// — the normal case on a phone whose network can't reach the API host —
/// would leave every attempt (and any rig-internal reconnect between them)
/// pending for minutes on a blackholed route. The connect timeout fails
/// each attempt fast; the per-step no-progress watchdog in
/// `runner::stream_step` bounds the total silence either way.
///
/// This is rig's reqwest line (0.13), not the app's own 0.12 dep — rig's
/// `HttpClientExt` is implemented for its own version (see the renamed
/// `reqwest13` dependency).
///
/// No overall/request timeout: streams are long-lived by design (a
/// reasoning model can legitimately sit quiet for minutes mid-stream).
fn http_client() -> reqwest13::Client {
    reqwest13::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .expect("reqwest client builds without a TLS/runtime misconfiguration")
}

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
            let client = rig::providers::openrouter::Client::builder()
                .api_key(api_key)
                .http_client(http_client())
                .build()
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
            let client = rig::providers::openai::CompletionsClient::builder()
                .api_key(api_key)
                .http_client(http_client())
                .build()
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

/// Regression tests for the stream watchdog + bounded HTTP client.
///
/// rig ships no HTTP timeouts, so a provider route that blackholes — SYNs
/// silently dropped, a middlebox that accepts and swallows the request, a
/// connection NAT'd away mid-flight — leaves `stream_step` pending forever
/// with no error: the mobile "No data for Xs — the stream may be stuck"
/// report, eternal. These drive `stream_step` against loopback servers
/// that mimic the failure shapes and assert the watchdog bounds the silent
/// ones with a hard error, rig's own surfaced failures stay fast, and a
/// healthy stream flows untouched.
#[cfg(test)]
mod stream_tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    use crate::agent::runner::{stream_step, CancelHandle, StepEvent};

    /// A handle aimed at an arbitrary loopback base URL (tests talk to mock
    /// servers; the real `build` only ever constructs the two hardcoded
    /// provider URLs).
    fn handle_with_base_url(base: &str) -> ModelHandle {
        let client = rig::providers::openai::CompletionsClient::builder()
            .api_key("test-key")
            .base_url(base)
            .http_client(http_client())
            .build()
            .expect("openai test client builds");
        ModelHandle {
            model: "test-model".into(),
            inner: AnyModel::OpenAi(client.completion_model("test-model")),
            reasoning_params: None,
        }
    }

    fn completion_request() -> rig::completion::CompletionRequest {
        use rig::completion::message::{Message, UserContent};
        rig::completion::CompletionRequest {
            model: Some("test-model".into()),
            preamble: None,
            chat_history: vec![Message::User {
                content: vec![UserContent::text("hello")],
            }],
            documents: Vec::new(),
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        }
    }

    /// Bind a loopback listener on an ephemeral port and serve it on a
    /// detached thread; returns the port.
    fn spawn_server<F>(handler: F) -> u16
    where
        F: Fn(TcpStream) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let handler = std::sync::Arc::new(handler);
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let handler = handler.clone();
                std::thread::spawn(move || handler(conn));
            }
        });
        port
    }

    /// Accepts and holds every connection open without ever answering — the
    /// "provider blackholed" shape (SYNs answered by a middlebox, the
    /// request swallowed, no bytes ever come back).
    fn silent_server() -> u16 {
        spawn_server(|_conn| {
            // The request stays unread in kernel buffers (it's small); hold
            // the socket far past any test horizon.
            std::thread::sleep(Duration::from_secs(120));
        })
    }

    /// Every connect succeeds and headers come back, but the body ends
    /// short of its promised Content-Length (hyper raises a mid-body
    /// transport error — not a clean stream end). This is the shape that
    /// drives rig's SSE source into its silent reconnect loop: each
    /// attempt errors transport-level AFTER a successful open, the policy
    /// retries unbounded (300 ms → 5 s), and nothing is surfaced.
    fn midstream_reset_server() -> u16 {
        spawn_server(|mut conn| {
            use std::io::Write;
            let body = "data: {\"partial\": true}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Content-Length: {}\r\n\r\n{}",
                body.len() + 64, // promises bytes that will never arrive
                body
            );
            let _ = conn.write_all(response.as_bytes());
            let _ = conn.flush();
            drop(conn); // EOF well short of the promised length
        })
    }

    /// Closes every connection the moment it arrives — the request fails
    /// before any response exists. rig surfaces this shape as a terminal
    /// error on its own, fast; the test pins that.
    fn connect_reset_server() -> u16 {
        spawn_server(|_conn| drop(_conn))
    }

    /// A minimal well-formed chat-completions SSE response: one text delta,
    /// then the `[DONE]` sentinel.
    fn sse_server() -> u16 {
        let body = concat!(
            r#"data: {"id":"c1","object":"chat.completion.chunk","created":1700000000,"#,
            r#""model":"test-model","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}"#,
            "\n\n",
            "data: [DONE]\n\n",
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        spawn_server(move |mut conn| {
            use std::io::{Read, Write};
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf); // request headers
            let _ = conn.write_all(response.as_bytes());
            let _ = conn.flush();
            std::thread::sleep(Duration::from_secs(2)); // let the client drain
        })
    }

    async fn streamed_text(
        port: u16,
        no_progress: Duration,
    ) -> Result<Option<crate::agent::runner::StepOutcome>, rig::completion::CompletionError> {
        let handle = handle_with_base_url(&format!("http://127.0.0.1:{port}/v1"));
        let cancel = CancelHandle::new();
        let mut sink = |_: StepEvent<'_>| {};
        stream_step(&handle, completion_request(), &cancel, no_progress, &mut sink).await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn watchdog_bounds_a_blackholed_stream() {
        let port = silent_server();
        let started = std::time::Instant::now();
        let result = streamed_text(port, Duration::from_millis(500)).await;
        assert!(
            matches!(
                &result,
                Err(rig::completion::CompletionError::ResponseError(_))
            ),
            "held-open connection must trip the watchdog"
        );
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the failure must be bounded, not eternal"
        );
    }

    /// Transport failures rig surfaces on its own (dead endpoint before any
    /// response; body that ends short of its Content-Length) must still be
    /// BOUNDED errors — pinned here so a rig upgrade can't quietly turn
    /// them into hangs.
    #[tokio::test(flavor = "multi_thread")]
    async fn transport_failures_surface_as_errors_quickly() {
        for (name, port) in [
            ("connect-reset", connect_reset_server()),
            ("midstream-short-body", midstream_reset_server()),
        ] {
            let started = std::time::Instant::now();
            let result = streamed_text(port, Duration::from_secs(10)).await;
            assert!(result.is_err(), "{name}: a dead endpoint must error, not hang");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{name}: transport failures must surface quickly"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn healthy_stream_still_flows() {
        let port = sse_server();
        let outcome = match streamed_text(port, Duration::from_secs(10)).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => panic!("healthy stream must not be cancelled"),
            Err(e) => panic!("healthy stream must not error: {e}"),
        };
        assert_eq!(outcome.text, "Hi");
    }
}
