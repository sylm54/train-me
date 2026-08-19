//! Framework onboarding flow (deterministic first-run customization).
//!
//! A framework ZIP may carry a root-level `onboarding.json`: an ordered
//! array of *items* —
//!
//! ```json
//! [
//!   { "kind": "text",  "text": "## Let's set things up" },
//!   { "kind": "question", "id": "experience", "answer": "choice",
//!     "prompt": "Prior training experience?", "choices": ["none", "some", "lots"] },
//!   { "kind": "text", "text": "Since you're experienced…",
//!     "showIf": { "id": "experience", "equals": "lots" } },
//!   { "kind": "question", "id": "limits", "answer": "open",
//!     "prompt": "Hard limits?", "showIf": { "id": "experience", "notEquals": "none" } }
//! ]
//! ```
//!
//! — the user answers them right after install (wizard) or as they
//! become pending after an update (Today banner). Answers are stored at
//! `<data_dir>/onboarding_answers.json` and rendered into the agent
//! sandbox as `agent_data/USER.md`. Nothing is added to the system
//! prompt: the framework decides how the agent consumes the profile
//! (typically `{{include './USER.md'}}` in its own prompts).
//!
//! Conditions (`showIf`) may reference answers of questions *above* the
//! item (validated at parse time). The flow engine — visibility, step
//! screens, save-time pruning — lives entirely here so the frontend never
//! re-implements it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

const QUESTIONS_FILE: &str = "onboarding.json";
const ANSWERS_FILE: &str = "onboarding_answers.json";
const USER_MD: &str = "USER.md";

pub type Answers = BTreeMap<String, serde_json::Value>;

// ============================================================================
// Schema
// ============================================================================

/// Display condition. Either a comparison against a previous answer, or
/// a compound (`all` / `any` / `not`). Multiple comparators on one
/// comparison are ANDed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Condition {
    All { all: Vec<Condition> },
    Any { any: Vec<Condition> },
    Not { not: Box<Condition> },
    Cmp {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        equals: Option<serde_json::Value>,
        #[serde(default, rename = "notEquals", skip_serializing_if = "Option::is_none")]
        not_equals: Option<serde_json::Value>,
        /// Array contains the value, or a text answer contains it as a
        /// substring.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        includes: Option<serde_json::Value>,
        /// Numeric bounds (rating answers).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        /// `true`: the question has an answer; `false`: it doesn't.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answered: Option<bool>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AnswerKind {
    /// Freeform text.
    Open,
    /// One of `choices` (`multiple: true` collects several).
    Choice,
    /// A number in `[min, max]` (default 1..=10).
    Rating,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TextItem {
    /// Markdown shown between questions.
    pub text: String,
    #[serde(default, rename = "showIf", skip_serializing_if = "Option::is_none")]
    pub show_if: Option<Condition>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QuestionItem {
    /// Stable id — answers are keyed by it and survive framework updates.
    pub id: String,
    pub answer: AnswerKind,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multiple: bool,
    #[serde(default = "default_min", skip_serializing_if = "is_default_min")]
    pub min: i64,
    #[serde(default = "default_max", skip_serializing_if = "is_default_max")]
    pub max: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, rename = "showIf", skip_serializing_if = "Option::is_none")]
    pub show_if: Option<Condition>,
}

fn default_min() -> i64 {
    1
}
fn default_max() -> i64 {
    10
}
fn is_default_min(v: &i64) -> bool {
    *v == 1
}
fn is_default_max(v: &i64) -> bool {
    *v == 10
}
fn is_false(v: &bool) -> bool {
    !*v
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OnboardingItem {
    Text(TextItem),
    Question(QuestionItem),
}

// ============================================================================
// Parsing + validation
// ============================================================================

fn condition_ids(c: &Condition, out: &mut Vec<String>) {
    match c {
        Condition::All { all } => all.iter().for_each(|c| condition_ids(c, out)),
        Condition::Any { any } => any.iter().for_each(|c| condition_ids(c, out)),
        Condition::Not { not } => condition_ids(not, out),
        Condition::Cmp { id, .. } => out.push(id.clone()),
    }
}

fn validate_condition(c: &Condition, label: &str) -> Result<(), String> {
    match c {
        Condition::All { all } if all.is_empty() => Err(format!("{label}: `all` is empty")),
        Condition::Any { any } if any.is_empty() => Err(format!("{label}: `any` is empty")),
        Condition::All { all } => all.iter().try_for_each(|c| validate_condition(c, label)),
        Condition::Any { any } => any.iter().try_for_each(|c| validate_condition(c, label)),
        Condition::Not { not } => validate_condition(not, label),
        Condition::Cmp {
            id,
            equals,
            not_equals,
            includes,
            min,
            max,
            answered,
        } => {
            if id.trim().is_empty() {
                return Err(format!("{label}: condition id must be non-empty"));
            }
            let has_comparator = equals.is_some()
                || not_equals.is_some()
                || includes.is_some()
                || min.is_some()
                || max.is_some()
                || answered.is_some();
            if !has_comparator {
                return Err(format!(
                    "{label}: condition on `{id}` needs at least one of equals, notEquals, \
                     includes, min, max, answered"
                ));
            }
            Ok(())
        }
    }
}

/// Parse + validate a framework's `onboarding.json`.
pub fn parse_flow(json: &str) -> Result<Vec<OnboardingItem>, String> {
    let items: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("invalid onboarding.json: {e}"))?;
    if items.is_empty() {
        return Err("onboarding.json must contain at least one item".to_string());
    }

    let mut parsed: Vec<OnboardingItem> = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    for (i, raw) in items.iter().enumerate() {
        // Items without a `kind` are questions (short form).
        let is_text = raw.get("kind").and_then(|k| k.as_str()) == Some("text");
        let item: OnboardingItem = if is_text {
            serde_json::from_value(raw.clone())
                .map(OnboardingItem::Text)
                .map_err(|e| format!("item #{i}: {e}"))?
        } else {
            serde_json::from_value(raw.clone())
                .map(OnboardingItem::Question)
                .map_err(|e| format!("item #{i}: {e}"))?
        };
        let label = format!("item #{i}");
        match &item {
            OnboardingItem::Text(t) => {
                if t.text.trim().is_empty() {
                    return Err(format!("{label}: text items must not be empty"));
                }
            }
            OnboardingItem::Question(q) => {
                if q.id.trim().is_empty() || seen_ids.contains(&q.id.trim().to_string()) {
                    return Err(format!("{label}: ids must be non-empty and unique"));
                }
                if q.prompt.trim().is_empty() {
                    return Err(format!("question `{}`: `prompt` must not be empty", q.id));
                }
                if q.min >= q.max {
                    return Err(format!("question `{}`: min must be below max", q.id));
                }
                if let AnswerKind::Choice = q.answer {
                    if q.choices.len() < 2 {
                        return Err(format!(
                            "question `{}`: choice questions need at least 2 choices",
                            q.id
                        ));
                    }
                }
            }
        }
        if let Some(cond) = item.show_if() {
            validate_condition(cond, &label)
                .map_err(|e| format!("{e} (showIf of {label})"))?;
            // Conditions may only reference questions ABOVE this item.
            let mut refs = Vec::new();
            condition_ids(cond, &mut refs);
            for r in refs {
                if !seen_ids.contains(&r) {
                    return Err(format!(
                        "{label}: showIf references `{r}`, which is not a question above it"
                    ));
                }
            }
        }
        if let OnboardingItem::Question(q) = &item {
            seen_ids.push(q.id.trim().to_string());
        }
        parsed.push(item);
    }
    Ok(parsed)
}

impl OnboardingItem {
    fn show_if(&self) -> Option<&Condition> {
        match self {
            OnboardingItem::Text(t) => t.show_if.as_ref(),
            OnboardingItem::Question(q) => q.show_if.as_ref(),
        }
    }
}

// ============================================================================
// Condition evaluation + visibility (the flow engine)
// ============================================================================

fn value_matches(answer: &serde_json::Value, expected: &serde_json::Value) -> bool {
    // Numbers compare across int/float representation.
    if let (Some(a), Some(b)) = (answer.as_f64(), expected.as_f64()) {
        return (a - b).abs() < f64::EPSILON;
    }
    answer == expected
}

fn eval_condition(c: &Condition, answers: &Answers) -> bool {
    match c {
        Condition::All { all } => all.iter().all(|c| eval_condition(c, answers)),
        Condition::Any { any } => any.iter().any(|c| eval_condition(c, answers)),
        Condition::Not { not } => !eval_condition(not, answers),
        Condition::Cmp {
            id,
            equals,
            not_equals,
            includes,
            min,
            max,
            answered,
        } => {
            let answer = answers.get(id);
            let mut ok = true;
            if let Some(expected) = equals {
                ok &= answer.map(|a| value_matches(a, expected)).unwrap_or(false);
            }
            if let Some(expected) = not_equals {
                // Unknown answers can't be asserted unequal.
                ok &= answer.map(|a| !value_matches(a, expected)).unwrap_or(false);
            }
            if let Some(needle) = includes {
                ok &= answer
                    .map(|a| match a {
                        serde_json::Value::Array(items) => {
                            items.iter().any(|v| value_matches(v, needle))
                        }
                        serde_json::Value::String(s) => needle
                            .as_str()
                            .map(|n| s.contains(n))
                            .unwrap_or(false),
                        _ => false,
                    })
                    .unwrap_or(false);
            }
            if let Some(lo) = min {
                ok &= answer.and_then(|a| a.as_f64()).map(|a| a >= *lo).unwrap_or(false);
            }
            if let Some(hi) = max {
                ok &= answer.and_then(|a| a.as_f64()).map(|a| a <= *hi).unwrap_or(false);
            }
            if let Some(want) = answered {
                ok &= is_answered(answer) == *want;
            }
            ok
        }
    }
}

/// Items visible given the current answers (evaluated top to bottom).
pub fn visible_items<'a>(items: &'a [OnboardingItem], answers: &Answers) -> Vec<&'a OnboardingItem> {
    items
        .iter()
        .filter(|item| {
            item.show_if()
                .map(|c| eval_condition(c, answers))
                .unwrap_or(true)
        })
        .collect()
}

/// Question ids that are visible (not hidden by the answer set).
fn visible_question_ids(items: &[OnboardingItem], answers: &Answers) -> Vec<String> {
    visible_items(items, answers)
        .iter()
        .filter_map(|item| match item {
            OnboardingItem::Question(q) => Some(q.id.clone()),
            _ => None,
        })
        .collect()
}

fn is_answered(answer: Option<&serde_json::Value>) -> bool {
    answer
        .map(|a| match a {
            serde_json::Value::String(s) => !s.trim().is_empty(),
            serde_json::Value::Array(items) => !items.is_empty(),
            serde_json::Value::Null => false,
            _ => true,
        })
        .unwrap_or(false)
}

// ============================================================================
// Storage
// ============================================================================

/// Read the framework's onboarding flow from a staged/extracted package
/// root. `Ok(None)` when the framework ships none.
pub fn from_pkg_root(pkg_root: &Path) -> Result<Option<Vec<OnboardingItem>>, String> {
    let path = pkg_root.join(QUESTIONS_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("{QUESTIONS_FILE}: {e}"))?;
    parse_flow(&raw).map(Some)
}

fn load_installed_flow(data_dir: &Path) -> Vec<OnboardingItem> {
    std::fs::read_to_string(data_dir.join(QUESTIONS_FILE))
        .ok()
        .and_then(|raw| parse_flow(&raw).ok())
        .unwrap_or_default()
}

fn load_answers(data_dir: &Path) -> Answers {
    std::fs::read_to_string(data_dir.join(ANSWERS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Merge stored answers with a session's new ones (new wins), then prune
/// answers for questions the final answer set has hidden.
fn merged_answers(data_dir: &Path, session: &Answers) -> Answers {
    let flow = load_installed_flow(data_dir);
    let mut merged = load_answers(data_dir);
    merged.extend(session.iter().map(|(k, v)| (k.clone(), v.clone())));
    let visible = visible_question_ids(&flow, &merged);
    for q in flow.iter().filter_map(|i| match i {
        OnboardingItem::Question(q) => Some(q),
        _ => None,
    }) {
        if !visible.contains(&q.id) {
            merged.remove(&q.id);
        }
    }
    merged
}

#[derive(Serialize, Clone, Debug)]
pub struct OnboardingState {
    pub items: Vec<OnboardingItem>,
    /// Every stored answer (post-pruning).
    pub answered: Answers,
    /// Visible questions with no stored answer.
    pub pending_count: usize,
}

fn state_for(data_dir: &Path) -> OnboardingState {
    let flow = load_installed_flow(data_dir);
    let answered = merged_answers(data_dir, &Answers::default());
    let pending_count = visible_items(&flow, &answered)
        .iter()
        .filter(|item| match item {
            OnboardingItem::Question(q) => !is_answered(answered.get(&q.id)),
            _ => false,
        })
        .count();
    OnboardingState {
        items: flow,
        answered,
        pending_count,
    }
}

/// Render `agent_data/USER.md` from the answer set. Only visible
/// questions appear; ids ride along as HTML comments so the file stays
/// readable markdown while remaining machine-parseable.
fn write_user_md(agent_dir: &Path, data_dir: &Path) -> Result<(), String> {
    let flow = load_installed_flow(data_dir);
    let answered = merged_answers(data_dir, &Answers::default());
    let mut md = String::from(
        "# User profile\n\n\
         Answers given during framework onboarding. This file is plain data on\n\
         the agent filesystem — nothing here is loaded into the system prompt\n\
         automatically; the framework decides how the agent consumes it\n\
         (e.g. `{{include './USER.md'}}` in its own prompts).\n\n",
    );
    let mut wrote = 0;
    for item in visible_items(&flow, &answered) {
        let OnboardingItem::Question(q) = item else {
            continue;
        };
        let Some(answer) = answered.get(&q.id) else {
            continue;
        };
        let rendered = match answer {
            serde_json::Value::Array(items) => items
                .iter()
                .map(|v| v.as_str().unwrap_or(&v.to_string()).to_string())
                .collect::<Vec<_>>()
                .join(", "),
            other => other.as_str().unwrap_or(&other.to_string()).to_string(),
        };
        md.push_str(&format!(
            "<!-- onboarding:{} -->\n**{}**\n\n{}\n\n",
            q.id, q.prompt, rendered
        ));
        wrote += 1;
    }
    if wrote == 0 {
        md.push_str("_(No answers yet.)_\n");
    }
    std::fs::write(agent_dir.join(USER_MD), md).map_err(|e| format!("USER.md: {e}"))
}

// ============================================================================
// Stepping
// ============================================================================

#[derive(Serialize, Clone, Debug)]
pub struct OnboardingStep {
    /// Consecutive visible text blocks leading up to the question.
    pub texts: Vec<String>,
    /// The next visible, unanswered question (`None` = flow complete).
    pub question: Option<QuestionItem>,
    /// Unanswered visible questions, including the current one.
    pub remaining: usize,
    /// Total visible questions.
    pub total: usize,
}

/// Compute the next screen: walk visible items, accumulating text blocks;
/// the first unanswered question ends the screen. Text blocks after the
/// last answered question with no question left arrive on a final,
/// question-less screen.
fn step_for(flow: &[OnboardingItem], answers: &Answers) -> OnboardingStep {
    let visible = visible_items(flow, answers);
    let questions: Vec<&QuestionItem> = visible
        .iter()
        .filter_map(|i| {
            if let OnboardingItem::Question(q) = i {
                Some(q)
            } else {
                None
            }
        })
        .collect();
    let remaining_total = questions
        .iter()
        .filter(|q| !is_answered(answers.get(&q.id)))
        .count();

    let mut texts: Vec<String> = Vec::new();
    for item in &visible {
        match item {
            OnboardingItem::Text(t) => texts.push(t.text.clone()),
            OnboardingItem::Question(q) => {
                if !is_answered(answers.get(&q.id)) {
                    return OnboardingStep {
                        texts,
                        question: Some((*q).clone()),
                        remaining: remaining_total,
                        total: questions.len(),
                    };
                }
                // Answered question: its leading texts are consumed.
                texts.clear();
            }
        }
    }
    OnboardingStep {
        texts,
        question: None,
        remaining: 0,
        total: questions.len(),
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub fn onboarding_questions(state: State<'_, AppState>) -> Result<OnboardingState, String> {
    Ok(state_for(&state.data_dir))
}

/// Next screen of the flow. `session` holds this session's answers so far
/// (merged over stored answers server-side).
#[tauri::command]
pub fn onboarding_step(
    session: Option<Answers>,
    state: State<'_, AppState>,
) -> Result<OnboardingStep, String> {
    let flow = load_installed_flow(&state.data_dir);
    let mut answers = load_answers(&state.data_dir);
    if let Some(session) = session {
        answers.extend(session);
    }
    Ok(step_for(&flow, &answers))
}

#[tauri::command]
pub fn save_onboarding_answers(
    app: AppHandle,
    session: Answers,
    state: State<'_, AppState>,
) -> Result<OnboardingState, String> {
    let merged = merged_answers(&state.data_dir, &session);
    let json =
        serde_json::to_string_pretty(&merged).map_err(|e| format!("serialize answers: {e}"))?;
    std::fs::write(state.data_dir.join(ANSWERS_FILE), json)
        .map_err(|e| format!("write answers: {e}"))?;
    write_user_md(&state.agent_dir, &state.data_dir)?;
    // USER.md is the canonical `{{include}}` target: prompts that inline it
    // must be rebuilt, else the agent keeps a stale system prompt until an
    // app restart (ChatView is mounted for the whole session).
    let _ = app.emit(crate::PROMPT_INPUTS_CHANGED, ());
    crate::schedule::log_activity(
        &state.agent_dir,
        "onboarding",
        "answers",
        &format!("{} answers stored", merged.len()),
    );
    Ok(state_for(&state.data_dir))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flow() -> Vec<OnboardingItem> {
        parse_flow(
            r###"[
            { "kind": "text", "text": "## Welcome" },
            { "kind": "question", "id": "exp", "answer": "choice",
              "prompt": "Experience?", "choices": ["none", "some", "lots"] },
            { "kind": "text", "text": "Nice — advanced questions follow.",
              "showIf": { "id": "exp", "equals": "lots" } },
            { "kind": "question", "id": "focus", "answer": "open",
              "prompt": "Focus areas?", "showIf": { "any": [
                  { "id": "exp", "equals": "some" },
                  { "id": "exp", "equals": "lots" } ] } },
            { "kind": "question", "id": "intensity", "answer": "rating",
              "prompt": "Intensity 1-10?", "showIf": { "id": "exp", "notEquals": "none" } },
            { "kind": "question", "id": "contact", "answer": "open",
              "prompt": "Anything else?", "showIf": { "not": { "id": "exp", "equals": "none" } } }
        ]"###,
        )
        .unwrap()
    }

    #[test]
    fn parse_validates_schema() {
        assert!(parse_flow("[]").is_err());
        assert!(parse_flow(r#"[{ "kind": "question", "id": "x", "answer": "open" }]"#).is_err()); // no prompt
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "x", "answer": "choice", "prompt": "p", "choices": ["a"] }]"#
        )
        .is_err());
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "x", "answer": "rating", "prompt": "p", "min": 10, "max": 1 }]"#
        )
        .is_err());
        // showIf must reference an EARLIER question.
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "a", "answer": "open", "prompt": "p",
                 "showIf": { "id": "b", "answered": true } }]"#
        )
        .is_err());
        // Conditions need a comparator.
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "a", "answer": "open", "prompt": "p" },
                 { "kind": "text", "text": "t", "showIf": { "id": "a" } }]"#
        )
        .is_err());
        assert_eq!(flow().len(), 6);
    }

    #[test]
    fn condition_semantics() {
        let mut answers = Answers::new();
        answers.insert("exp".into(), json!("lots"));
        answers.insert("score".into(), json!(7));
        answers.insert("tags".into(), json!(["a", "b"]));

        let eval = |c: &str, a: &Answers| {
            let cond: Condition = serde_json::from_str(c).unwrap();
            eval_condition(&cond, a)
        };
        assert!(eval(r#"{ "id": "exp", "equals": "lots" }"#, &answers));
        assert!(eval(r#"{ "id": "exp", "notEquals": "none" }"#, &answers));
        assert!(eval(r#"{ "id": "score", "min": 5, "max": 8 }"#, &answers));
        assert!(!eval(r#"{ "id": "score", "max": 5 }"#, &answers));
        assert!(eval(r#"{ "id": "tags", "includes": "a" }"#, &answers));
        assert!(!eval(r#"{ "id": "tags", "includes": "c" }"#, &answers));
        assert!(eval(r#"{ "id": "missing", "answered": false }"#, &answers));
        assert!(!eval(r#"{ "id": "missing", "notEquals": "x" }"#, &answers));
        assert!(eval(
            r#"{ "all": [ { "id": "exp", "equals": "lots" }, { "not": { "id": "score", "max": 3 } } ] }"#,
            &answers
        ));
    }

    #[test]
    fn visibility_hides_downstream_questions() {
        let f = flow();
        // "none": advanced questions hidden.
        let mut a = Answers::new();
        a.insert("exp".into(), json!("none"));
        let ids = visible_question_ids(&f, &a);
        assert_eq!(ids, vec!["exp".to_string()]);

        // "lots": everything visible.
        a.insert("exp".into(), json!("lots"));
        assert_eq!(visible_question_ids(&f, &a).len(), 4);

        // Step: after answering exp, the next screen is the conditional
        // text + the focus question.
        let step = step_for(&f, &a);
        assert_eq!(step.question.as_ref().unwrap().id, "focus");
        assert_eq!(step.texts.len(), 1);
        assert_eq!(step.remaining, 3);

        // Complete flow: remaining hits 0 and the final screen has no
        // question.
        a.insert("focus".into(), json!("voice"));
        a.insert("intensity".into(), json!(8));
        a.insert("contact".into(), json!("no"));
        let step = step_for(&f, &a);
        assert!(step.question.is_none());
        assert_eq!(step.remaining, 0);
    }

    #[test]
    fn save_prunes_hidden_answers_and_writes_user_md() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let agent = data.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(data.join(QUESTIONS_FILE), serde_json::to_string(&flow()).unwrap())
            .unwrap();

        // Answer exp="none" AND sneak in a focus answer (as if the answer
        // set changed upstream); the merge must prune focus.
        let mut session = Answers::new();
        session.insert("exp".into(), json!("none"));
        session.insert("focus".into(), json!("stale"));
        let merged = merged_answers(data, &session);
        assert!(merged.contains_key("exp"));
        assert!(!merged.contains_key("focus"), "hidden answers pruned");

        std::fs::write(
            data.join(ANSWERS_FILE),
            serde_json::to_string(&merged).unwrap(),
        )
        .unwrap();
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join(USER_MD)).unwrap();
        assert!(md.contains("<!-- onboarding:exp -->"));
        assert!(md.contains("none"));
        assert!(!md.contains("focus"));
    }
}
