//! The model client against a local stand-in provider: request shape, auth,
//! retries, timeouts, invalid output, the size cap and redirects.

mod common;

use std::time::{Duration, Instant};

use clipy_local_moments::{
    plan_with_provider, Input, MomentSource, Planner, PlannerError, Preset, ProviderConfig,
    TranscriptSegment, MAX_COMPLETION_BYTES, SYSTEM_PROMPT,
};
use common::{serve, Reply};
use serde_json::Value;

const SECRET_WORDS: &str = "the confidential roadmap item";

fn input() -> Input {
    Input {
        duration_ms: 10_000,
        transcript: vec![TranscriptSegment {
            start_ms: 1000.0,
            end_ms: 2500.0,
            text: SECRET_WORDS.into(),
        }],
        ..Input::default()
    }
}

const GOOD: &str =
    r#"{"moments":[{"timestamp_ms":1000,"reason":"The speaker points at the item."}]}"#;

fn config(base_url: &str) -> ProviderConfig {
    let mut c = ProviderConfig::new(base_url, "test/model").with_api_key("sk-test-secret");
    c.retry_delays = vec![Duration::from_millis(20), Duration::from_millis(20)];
    c.attempt_timeout = Duration::from_secs(5);
    c
}

fn assert_safe(error: &PlannerError) {
    let shown = format!("{error} {error:?} {}", error.describe());
    assert!(!shown.contains("sk-test-secret"), "{shown}");
    assert!(!shown.contains("confidential"), "{shown}");
}

#[tokio::test]
async fn sends_the_planner_request() {
    let server = serve(|_| Reply::completion(GOOD)).await;
    let plan = plan_with_provider(&input(), &config(&format!("{}//", server.base_url)))
        .await
        .unwrap();
    assert_eq!(plan.planner, Planner::RulesAndModel);
    assert_eq!(plan.moments.len(), 1);
    assert_eq!(plan.moments[0].source, MomentSource::Spoken);
    assert_eq!(plan.moments[0].timestamp_ms, 1000);
    assert_eq!(plan.moments[0].x, None);

    let seen = &server.requests()[0];
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/chat/completions");
    assert_eq!(seen.header("authorization"), Some("Bearer sk-test-secret"));
    assert_eq!(seen.header("content-type"), Some("application/json"));
    let body: Value = serde_json::from_str(&seen.body).unwrap();
    assert_eq!(body["model"], "test/model");
    assert_eq!(body["temperature"], 0);
    assert_eq!(body["max_tokens"], 4096);
    assert_eq!(body["response_format"]["type"], "json_object");
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][0]["content"], SYSTEM_PROMPT);
    let user: Value =
        serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(user["durationMs"], 10_000);
    assert_eq!(user["transcript"][0]["text"], SECRET_WORDS);
    assert_eq!(user["cursorContext"], Value::Null);
}

#[tokio::test]
async fn no_key_means_no_authorization_header_and_preset_headers_are_sent() {
    let server = serve(|_| Reply::completion(GOOD)).await;
    let local =
        ProviderConfig::from_preset(Preset::Custom, None, Some("m"), Some(&server.base_url))
            .unwrap();
    plan_with_provider(&input(), &local).await.unwrap();
    let routed = ProviderConfig::from_preset(
        Preset::OpenRouter,
        Some("or-key"),
        None,
        Some(&server.base_url),
    )
    .unwrap();
    plan_with_provider(&input(), &routed).await.unwrap();
    let seen = server.requests();
    assert_eq!(seen[0].header("authorization"), None);
    assert_eq!(seen[1].header("authorization"), Some("Bearer or-key"));
    assert_eq!(seen[1].header("http-referer"), Some("https://clipy.online"));
    assert_eq!(seen[1].header("x-title"), Some("Clipy"));
    let body: Value = serde_json::from_str(&seen[1].body).unwrap();
    assert_eq!(body["model"], "google/gemini-3.1-flash-lite");
}

#[tokio::test]
async fn retries_server_errors_and_rate_limits_with_the_delays() {
    let server = serve(|n| match n {
        0 => Reply::json(503, "{}"),
        1 => Reply::json(429, "{}"),
        _ => Reply::completion(GOOD),
    })
    .await;
    let mut c = config(&server.base_url);
    c.retry_delays = vec![Duration::from_millis(150), Duration::from_millis(250)];
    let started = Instant::now();
    let plan = plan_with_provider(&input(), &c).await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(400),
        "waited {:?}",
        started.elapsed()
    );
    assert_eq!(plan.planner, Planner::RulesAndModel);
    assert_eq!(server.requests().len(), 3);
}

#[tokio::test]
async fn gives_up_after_three_attempts() {
    let server = serve(|_| Reply::json(500, format!("{{\"error\":\"{SECRET_WORDS}\"}}"))).await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        PlannerError::Http {
            status: 500,
            transient: true
        }
    );
    assert!(error.is_transient());
    assert_eq!(server.requests().len(), 3);
    assert_safe(&error);
}

#[tokio::test]
async fn does_not_retry_configuration_errors() {
    for status in [400u16, 401, 402, 403, 404] {
        let server = serve(move |_| Reply::json(status, "{}")).await;
        let error = plan_with_provider(&input(), &config(&server.base_url))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            PlannerError::Http {
                status,
                transient: false
            },
            "{status}"
        );
        assert!(!error.is_transient());
        assert_eq!(server.requests().len(), 1, "{status}");
        assert_eq!(error.describe()["kind"], "provider_error");
    }
}

#[tokio::test]
async fn retries_invalid_output_then_reports_it() {
    let server = serve(|n| match n {
        0 => Reply::completion("not json"),
        1 => Reply::completion(r#"{"moments":[{"timestamp_ms":99999,"reason":"after the end"}]}"#),
        _ => Reply::completion(GOOD),
    })
    .await;
    plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap();
    assert_eq!(server.requests().len(), 3);

    let server = serve(|_| {
        Reply::completion(r#"{"moments":[{"timestamp_ms":1,"reason":"ok","extra":true}]}"#)
    })
    .await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert!(
        matches!(error, PlannerError::InvalidOutput { .. }),
        "{error:?}"
    );
    assert_eq!(error.describe()["kind"], "invalid_output");
    assert_eq!(server.requests().len(), 3);

    let server = serve(|_| Reply::completion("```json\n{oops\n```")).await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(error, PlannerError::Unparseable { status: 200 });
    assert_eq!(error.describe()["kind"], "unparseable_json");

    let server = serve(|_| Reply::json(200, r#"{"choices":[{"message":{"content":""}}]}"#)).await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(error, PlannerError::EmptyCompletion { status: 200 });
    assert_eq!(server.requests().len(), 3);

    let server = serve(|_| Reply::json(200, "<html>gateway</html>")).await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(error, PlannerError::EmptyCompletion { status: 200 });
}

#[tokio::test]
async fn times_out_each_attempt() {
    let server = serve(|_| Reply {
        delay: Duration::from_secs(3),
        ..Reply::completion(GOOD)
    })
    .await;
    let mut c = config(&server.base_url);
    c.attempt_timeout = Duration::from_millis(200);
    c.retry_delays = vec![Duration::ZERO, Duration::ZERO];
    let started = Instant::now();
    let error = plan_with_provider(&input(), &c).await.unwrap_err();
    assert_eq!(error, PlannerError::Timeout);
    assert_eq!(server.requests().len(), 3);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn the_timeout_covers_reading_the_answer() {
    let server = serve(|_| Reply {
        stall_after_headers: Some(Duration::from_secs(3)),
        ..Reply::completion(GOOD)
    })
    .await;
    let mut c = config(&server.base_url);
    c.attempt_timeout = Duration::from_millis(300);
    c.retry_delays = vec![Duration::ZERO, Duration::ZERO];
    let started = Instant::now();
    let error = plan_with_provider(&input(), &c).await.unwrap_err();
    assert_eq!(error, PlannerError::Timeout);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn refuses_answers_over_the_size_cap() {
    // Declared too large: refused before reading, and not retried.
    let server = serve(|_| Reply {
        declared_length: Some(MAX_COMPLETION_BYTES + 1),
        ..Reply::json(200, "{}")
    })
    .await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(error, PlannerError::TooLarge { status: 200 });
    assert!(!error.is_transient());
    assert_eq!(server.requests().len(), 1);

    // No length, streamed past the cap.
    let server = serve(|_| Reply {
        no_length: true,
        ..Reply::json(200, vec![b' '; MAX_COMPLETION_BYTES + 10])
    })
    .await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(error, PlannerError::TooLarge { status: 200 });

    // Exactly at the cap is read.
    let padded = {
        let reply = serde_json::json!({"choices": [{"message": {"content": GOOD}}]}).to_string();
        let mut bytes = reply.into_bytes();
        bytes.resize(MAX_COMPLETION_BYTES, b' ');
        bytes
    };
    let server = serve(move |_| Reply {
        no_length: true,
        ..Reply::json(200, padded.clone())
    })
    .await;
    plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap();
}

#[tokio::test]
async fn does_not_follow_redirects() {
    let server = serve(|_| {
        let mut r = Reply::completion(GOOD);
        r.status = 307;
        r.headers.push(("Location".into(), "/v1/elsewhere".into()));
        r
    })
    .await;
    let error = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap_err();
    assert_eq!(error, PlannerError::Redirect { status: 307 });
    let seen = server.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/v1/chat/completions");
}

#[tokio::test]
async fn reports_unreachable_providers_as_network_errors() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let mut c = config(&format!("http://127.0.0.1:{port}/v1"));
    c.retry_delays = vec![Duration::ZERO, Duration::ZERO];
    let error = plan_with_provider(&input(), &c).await.unwrap_err();
    assert!(matches!(error, PlannerError::Network { .. }), "{error:?}");
    assert!(error.is_transient());
    assert_safe(&error);
}

#[tokio::test]
async fn never_asks_without_a_transcript_or_with_invalid_input() {
    let server = serve(|_| Reply::completion(GOOD)).await;
    let mut silent = input();
    silent.transcript.clear();
    let plan = plan_with_provider(&silent, &config(&server.base_url))
        .await
        .unwrap();
    assert_eq!(plan.planner, Planner::Rules);

    let mut bad = input();
    bad.transcript[0].end_ms = 20_000.0; // past the end
    let error = plan_with_provider(&bad, &config(&server.base_url))
        .await
        .unwrap_err();
    assert!(matches!(error, PlannerError::InvalidInput(_)), "{error:?}");
    assert_safe(&error);

    let error = plan_with_provider(&input(), &ProviderConfig::new("file:///etc", "m"))
        .await
        .unwrap_err();
    assert!(matches!(error, PlannerError::InvalidConfig(_)), "{error:?}");
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn accepts_prose_wrapped_fenced_json_responses() {
    let wrapped = format!("Here are the moments:\n\n```json\n{GOOD}\n```");
    let server = serve(move |_| Reply::completion(&wrapped)).await;
    let plan = plan_with_provider(&input(), &config(&server.base_url))
        .await
        .unwrap();
    assert_eq!(plan.planner, Planner::RulesAndModel);
    assert_eq!(plan.moments.len(), 1);
    assert_eq!(plan.moments[0].source, MomentSource::Spoken);
    assert_eq!(plan.moments[0].timestamp_ms, 1000);
}
