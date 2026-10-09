//! Framework onboarding flow (deterministic first-run customization).
//!
//! A framework ZIP may carry a root-level `onboarding.json`. Two forms are
//! accepted:
//!
//! ```json
//! [ …items ]
//! ```
//!
//! ```json
//! { "output": "PROFILE.md", "items": [ …items ] }
//! ```
//!
//! `output` (object form only) is the sandbox-relative file answers render
//! into — default `USER.md`.
//!
//! Items are `{kind: "text", text, showIf?}`, `{kind: "question", …}` (the
//! `kind` may be omitted) and `{kind: "include", src, showIf?}` — the latter
//! splices in the item array of a subfile (framework-root-relative `src`),
//! with the include's `showIf` ANDed onto each spliced item's own condition.
//! Subfiles may nest includes; cycles are rejected at parse time.
//!
//! ```json
//! [
//!   { "kind": "text",  "text": "## Let's set things up" },
//!   { "kind": "question", "id": "experience", "answer": "choice",
//!     "prompt": "Prior training experience?", "choices": ["none", "some", "lots"] },
//!   { "kind": "text", "text": "Since you're experienced…",
//!     "showIf": { "id": "experience", "equals": "lots" } },
//!   { "kind": "question", "id": "limits", "answer": "open",
//!     "prompt": "Hard limits?", "showIf": { "id": "experience", "notEquals": "none" } },
//!   { "kind": "include", "src": "onboarding/advanced.json",
//!     "showIf": { "part": "journal" } }
//! ]
//! ```
//!
//! The user answers right after install, as the final step of the setup
//! wizard. The questionnaire is purely an init mechanism: once onboarding
//! is done it is never asked again. Answers are stored at
//! `<data_dir>/onboarding_answers.json` and rendered into the agent sandbox
//! as `agent_data/USER.md` (or the flow's `output`) — plus an auto-added
//! "App setup" section snapshotting app-managed state (chastity, inventory)
//! so the agent gets a heads-up about it. Nothing is added to
//! the system prompt: the framework decides how the agent consumes the
//! profile (typically `{{include './USER.md'}}` in its own prompts).
//!
//! Conditions (`showIf`) may reference answers of questions *above* the
//! item (validated at parse time) and the framework parts that were
//! selected at install (`{ "part": "journal" }`, optionally
//! `installed: false` — part names are validated against `config.json` at
//! stage time). The flow engine — visibility, step screens, save-time
//! pruning — lives entirely here so the frontend never re-implements it.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

const QUESTIONS_FILE: &str = "onboarding.json";
const ANSWERS_FILE: &str = "onboarding_answers.json";
const DEFAULT_OUTPUT: &str = "USER.md";
/// Answers-map key prefix under which a question's free-text clarification
/// is stored (`note:<id>`) — the addendum the UI offers on non-`open`
/// questions. Reserved: question ids must not start with it.
const NOTE_PREFIX: &str = "note:";

/// The answers-map key holding a question's free-text clarification.
fn note_key(id: &str) -> String {
    format!("{NOTE_PREFIX}{id}")
}

pub type Answers = BTreeMap<String, serde_json::Value>;

/// A parsed onboarding flow: the spliced item list plus the settings that
/// ride along from the root file.
#[derive(Clone, Debug)]
pub struct Flow {
    pub items: Vec<OnboardingItem>,
    /// Sandbox-relative path the rendered answer file is written to.
    pub output: String,
    /// Every subfile `src` this flow (transitively) includes — the install
    /// step copies them next to `onboarding.json` in the data dir.
    pub includes: Vec<String>,
}

impl Default for Flow {
    fn default() -> Self {
        Flow {
            items: Vec::new(),
            output: DEFAULT_OUTPUT.to_string(),
            includes: Vec::new(),
        }
    }
}

// ============================================================================
// Schema
// ============================================================================

/// Display condition. Either a comparison against a previous answer, a
/// check on an installed framework part, or a compound (`all` / `any` /
/// `not`). Multiple comparators on one comparison are ANDed.
///
/// `tier` / `tierAtLeast` scope a comparison into one tier of a `tierlist`
/// answer: `includes` then tests whether an item sits in that tier (or in
/// it or any tier above, for `tierAtLeast` — tiers listed earlier rank
/// higher), `answered` whether the tier holds anything, and `min`/`max`
/// bound the tier's item count.
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
        /// substring. On tierlist answers: the item is placed in the
        /// scoped tier(s) (any tier when unscoped).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        includes: Option<serde_json::Value>,
        /// Numeric bounds (rating answers; tierlist: item counts in the
        /// scoped tier(s)).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        /// `true`: the question has an answer; `false`: it doesn't. With
        /// `tier`/`tierAtLeast`: the scoped tier(s) hold at least one item.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answered: Option<bool>,
        /// Tierlist scope: exactly this tier.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tier: Option<String>,
        /// Tierlist scope: this tier or any tier above it.
        #[serde(default, rename = "tierAtLeast", skip_serializing_if = "Option::is_none")]
        tier_at_least: Option<String>,
    },
    /// True when the named part folder (a `config.json` choice target) was
    /// installed. `installed: false` inverts it.
    Part {
        part: String,
        #[serde(default = "default_true")]
        installed: bool,
    },
}

fn default_true() -> bool {
    true
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
    /// All of `choices`, ordered by preference (stored as the ranked array).
    Ranking,
    /// All of `choices` sorted into `tiers` (stored as
    /// `{tier: [items…]}` — tier order top→bottom is the tiers array's,
    /// item order within a tier is left→right as placed).
    Tierlist,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TextItem {
    /// Markdown shown between questions.
    pub text: String,
    #[serde(default, rename = "showIf", skip_serializing_if = "Option::is_none")]
    pub show_if: Option<Condition>,
}

/// `{kind: "include", src}` — splices a subfile's item array in place. The
/// include's own `showIf` is ANDed onto every spliced item's condition, so
/// a hidden include hides everything it pulls in. Never survives into a
/// resolved [`Flow`].
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct IncludeItem {
    /// Framework-root-relative path of a JSON file containing an item array.
    pub src: String,
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
    /// `tierlist` answers only — the tier rows, top→bottom. Conditions and
    /// the stored answer reference tiers by their label.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multiple: bool,
    #[serde(default = "default_min", skip_serializing_if = "is_default_min")]
    pub min: i64,
    #[serde(default = "default_max", skip_serializing_if = "is_default_max")]
    pub max: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// `true`: the question may be left unanswered (the UI offers a Skip).
    /// A skip is stored as an explicit `null` answer — it counts as
    /// resolved for flow progress, is not rendered into `USER.md`, and
    /// evaluates as unanswered in `showIf` conditions.
    #[serde(default, skip_serializing_if = "is_false")]
    pub optional: bool,
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
        Condition::Part { .. } => {}
    }
}

/// Collect every part name referenced by a condition (for validation
/// against the parts `config.json` can select).
fn condition_parts(c: &Condition, out: &mut Vec<String>) {
    match c {
        Condition::All { all } => all.iter().for_each(|c| condition_parts(c, out)),
        Condition::Any { any } => any.iter().for_each(|c| condition_parts(c, out)),
        Condition::Not { not } => condition_parts(not, out),
        Condition::Cmp { .. } => {}
        Condition::Part { part, .. } => out.push(part.clone()),
    }
}

fn validate_condition(c: &Condition, label: &str) -> Result<(), String> {
    match c {
        Condition::All { all } if all.is_empty() => Err(format!("{label}: `all` is empty")),
        Condition::Any { any } if any.is_empty() => Err(format!("{label}: `any` is empty")),
        Condition::All { all } => all.iter().try_for_each(|c| validate_condition(c, label)),
        Condition::Any { any } => any.iter().try_for_each(|c| validate_condition(c, label)),
        Condition::Not { not } => validate_condition(not, label),
        Condition::Part { part, .. } => {
            if part.trim().is_empty() {
                Err(format!("{label}: `part` must be non-empty"))
            } else {
                Ok(())
            }
        }
        Condition::Cmp {
            id,
            equals,
            not_equals,
            includes,
            min,
            max,
            answered,
            tier,
            tier_at_least,
        } => {
            if id.trim().is_empty() {
                return Err(format!("{label}: condition id must be non-empty"));
            }
            for name in [tier, tier_at_least] {
                if let Some(t) = name {
                    if t.trim().is_empty() {
                        return Err(format!(
                            "{label}: condition on `{id}` has an empty tier name"
                        ));
                    }
                }
            }
            if tier.is_some() && tier_at_least.is_some() {
                return Err(format!(
                    "{label}: condition on `{id}` cannot combine `tier` and `tierAtLeast`"
                ));
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

/// Tier scoping in a condition — `(question id, tier name, atLeast)` pairs.
fn condition_tiers(c: &Condition, out: &mut Vec<(String, String, bool)>) {
    match c {
        Condition::All { all } => all.iter().for_each(|c| condition_tiers(c, out)),
        Condition::Any { any } => any.iter().for_each(|c| condition_tiers(c, out)),
        Condition::Not { not } => condition_tiers(not, out),
        Condition::Cmp {
            id,
            tier,
            tier_at_least,
            ..
        } => {
            if let Some(t) = tier {
                out.push((id.clone(), t.clone(), false));
            }
            if let Some(t) = tier_at_least {
                out.push((id.clone(), t.clone(), true));
            }
        }
        Condition::Part { .. } => {}
    }
}

/// AND two optional conditions into one (`all` when both are present).
fn and_conditions(a: Condition, b: Option<Condition>) -> Option<Condition> {
    match b {
        None => Some(a),
        Some(b) => Some(Condition::All { all: vec![a, b] }),
    }
}

/// A sandbox/data-dir-relative output path is safe when it is relative,
/// has no `..` component, and has no drive/UNC prefix.
fn safe_rel_path(p: &str) -> Result<(), String> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() || trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(format!("`{trimmed}` must be a relative path"));
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("`{trimmed}` must not contain `..`"));
    }
    Ok(())
}

/// Parse + validate a flat item array (what a subfile contains, and what
/// the root file becomes once includes are spliced).
pub fn parse_flow(json: &str) -> Result<Vec<OnboardingItem>, String> {
    let items: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("invalid onboarding items: {e}"))?;
    if items.is_empty() {
        return Err("onboarding items must contain at least one item".to_string());
    }

    let mut parsed: Vec<OnboardingItem> = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    // Tierlist questions seen so far: id → tiers (for condition validation).
    let mut tiered_above: BTreeMap<String, Vec<String>> = BTreeMap::new();
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
                if q.id.trim().starts_with(NOTE_PREFIX) {
                    return Err(format!(
                        "question `{}`: ids must not start with `{NOTE_PREFIX}` \
                         (reserved for answer clarifications)",
                        q.id
                    ));
                }
                if q.prompt.trim().is_empty() {
                    return Err(format!("question `{}`: `prompt` must not be empty", q.id));
                }
                if q.min >= q.max {
                    return Err(format!("question `{}`: min must be below max", q.id));
                }
                if matches!(
                    q.answer,
                    AnswerKind::Choice | AnswerKind::Ranking | AnswerKind::Tierlist
                ) {
                    if q.choices.len() < 2 {
                        return Err(format!(
                            "question `{}`: choice/ranking/tierlist questions need at least \
                             2 choices",
                            q.id
                        ));
                    }
                }
                if q.answer == AnswerKind::Tierlist {
                    let mut seen_items = HashSet::new();
                    if q
                        .choices
                        .iter()
                        .any(|c| c.trim().is_empty() || !seen_items.insert(c.trim().to_string()))
                    {
                        return Err(format!(
                            "question `{}`: tierlist items must be non-empty and unique",
                            q.id
                        ));
                    }
                    if q.tiers.len() < 2 {
                        return Err(format!(
                            "question `{}`: tierlist questions need at least 2 tiers",
                            q.id
                        ));
                    }
                    let mut seen_tiers = HashSet::new();
                    if q
                        .tiers
                        .iter()
                        .any(|t| t.trim().is_empty() || !seen_tiers.insert(t.trim().to_string()))
                    {
                        return Err(format!(
                            "question `{}`: tiers must be non-empty and unique",
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
            // Tier scoping must name a tierlist question above and one of
            // its tiers.
            let mut tier_refs = Vec::new();
            condition_tiers(cond, &mut tier_refs);
            for (id, tier, _) in tier_refs {
                match tiered_above.get(id.as_str()) {
                    None => {
                        return Err(format!(
                            "{label}: showIf scopes `{id}` by tier, but `{id}` is not a \
                             tierlist question above it"
                        ));
                    }
                    Some(tiers) if !tiers.contains(&tier) => {
                        return Err(format!(
                            "{label}: showIf references tier `{tier}`, which `{id}` does \
                             not define"
                        ));
                    }
                    _ => {}
                }
            }
        }
        if let OnboardingItem::Question(q) = &item {
            seen_ids.push(q.id.trim().to_string());
            if q.answer == AnswerKind::Tierlist {
                tiered_above.insert(q.id.trim().to_string(), q.tiers.clone());
            }
        }
        parsed.push(item);
    }
    Ok(parsed)
}

/// Recursively splice `include` items (raw JSON) into a flat raw array.
/// `stack` carries the include chain for cycle detection. Returns the
/// resolved array plus every `src` touched.
fn resolve_includes(
    root: &Path,
    items: &[serde_json::Value],
    stack: &mut Vec<String>,
    includes_out: &mut Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for (i, raw) in items.iter().enumerate() {
        let is_include = raw.get("kind").and_then(|k| k.as_str()) == Some("include");
        if !is_include {
            out.push(raw.clone());
            continue;
        }
        let inc: IncludeItem = serde_json::from_value(raw.clone())
            .map_err(|e| format!("include #{i}: {e}"))?;
        let label = format!("include `{}`", inc.src);
        safe_rel_path(&inc.src).map_err(|e| format!("{label}: {e}"))?;
        if stack.contains(&inc.src) {
            return Err(format!(
                "include cycle: {} → {src}",
                stack.join(" → "),
                src = inc.src
            ));
        }
        let path = root.join(inc.src.trim());
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("{label}: cannot read ({e})"))?;
        let sub: Vec<serde_json::Value> = serde_json::from_str(&text)
            .map_err(|e| format!("{label}: invalid JSON ({e})"))?;
        includes_out.push(inc.src.trim().to_string());
        stack.push(inc.src.trim().to_string());
        let spliced = resolve_includes(root, &sub, stack, includes_out);
        stack.pop();

        // Hoist the include's showIf onto each spliced item so a hidden
        // include hides everything it pulls in. (Non-object entries pass
        // through untouched — parse_flow rejects them later.)
        for mut item in spliced? {
            if let Some(cond) = &inc.show_if {
                if let Some(obj) = item.as_object_mut() {
                    let own = obj
                        .get("showIf")
                        .cloned()
                        .and_then(|v| serde_json::from_value::<Condition>(v).ok());
                    let merged = and_conditions(cond.clone(), own);
                    if let Some(merged) = merged {
                        obj.insert(
                            "showIf".to_string(),
                            serde_json::to_value(merged).unwrap(),
                        );
                    }
                }
            }
            out.push(item);
        }
    }
    Ok(out)
}

/// Read + resolve the onboarding flow under `root` (a staged framework root
/// or the installed data dir). `Ok(None)` when no `onboarding.json` exists.
/// `known_parts` — the part names `config.json` can select — enables part
/// reference validation (only available at stage time; `None` skips it).
pub fn resolve_flow(
    root: &Path,
    known_parts: Option<&[String]>,
) -> Result<Option<Flow>, String> {
    let path = root.join(QUESTIONS_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("{QUESTIONS_FILE}: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid {QUESTIONS_FILE}: {e}"))?;

    // Root form: bare item array, or `{ output, items }`.
    let (output, raw_items): (String, Vec<serde_json::Value>) = match &value {
        serde_json::Value::Array(items) => (DEFAULT_OUTPUT.to_string(), items.clone()),
        serde_json::Value::Object(obj) => {
            let items = obj
                .get("items")
                .cloned()
                .ok_or_else(|| format!("{QUESTIONS_FILE}: object form needs an `items` array"))?;
            let items: Vec<serde_json::Value> = serde_json::from_value(items)
                .map_err(|e| format!("{QUESTIONS_FILE}: `items` must be an array ({e})"))?;
            let output = obj
                .get("output")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| DEFAULT_OUTPUT.to_string());
            (output, items)
        }
        _ => {
            return Err(format!(
                "{QUESTIONS_FILE}: must be an item array or an object with `items`"
            ))
        }
    };
    safe_rel_path(&output).map_err(|e| format!("{QUESTIONS_FILE}: `output` {e}"))?;

    let mut includes = Vec::new();
    let flat = resolve_includes(root, &raw_items, &mut Vec::new(), &mut includes)?;
    let flat_json = serde_json::to_string(&flat)
        .map_err(|e| format!("{QUESTIONS_FILE}: re-encode failed ({e})"))?;
    let items = parse_flow(&flat_json)?;

    if let Some(known) = known_parts {
        let mut refs = Vec::new();
        for item in &items {
            if let Some(cond) = item.show_if() {
                condition_parts(cond, &mut refs);
            }
        }
        for r in refs {
            if !known.contains(&r) {
                return Err(format!(
                    "{QUESTIONS_FILE}: showIf references part `{r}`, which no config.json \
                     choice selects"
                ));
            }
        }
    }

    Ok(Some(Flow {
        items,
        output,
        includes,
    }))
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

/// Tier rows per tierlist question: id → tiers in definition order (top→
/// bottom, best first by convention). `tierAtLeast` needs the order to
/// resolve "this tier or above".
fn tier_orders(items: &[OnboardingItem]) -> BTreeMap<String, Vec<String>> {
    items
        .iter()
        .filter_map(|i| match i {
            OnboardingItem::Question(q) if q.answer == AnswerKind::Tierlist => {
                Some((q.id.clone(), q.tiers.clone()))
            }
            _ => None,
        })
        .collect()
}

/// The items of a tierlist answer a tier-scoped comparison tests against:
/// exactly `tier`, or — for `tierAtLeast` — everything in that tier or any
/// tier above it (definition order). An unknown scope yields an empty list
/// (the comparison then tests against nothing, i.e. false for `includes`).
fn tier_scoped_items<'a>(
    answer: &'a serde_json::Value,
    tiers: &[String],
    scope: &str,
    at_least: bool,
) -> Option<Vec<&'a str>> {
    let map = answer.as_object()?;
    let in_scope: Vec<&str> = if at_least {
        let mut acc: Vec<&str> = Vec::new();
        let mut hit = false;
        for t in tiers {
            acc.push(t);
            if t == scope {
                hit = true;
                break;
            }
        }
        if hit { acc } else { Vec::new() }
    } else if tiers.iter().any(|t| t == scope) {
        vec![scope]
    } else {
        Vec::new()
    };
    let mut out: Vec<&str> = Vec::new();
    for t in in_scope {
        if let Some(list) = map.get(t).and_then(|v| v.as_array()) {
            out.extend(list.iter().filter_map(|v| v.as_str()));
        }
    }
    Some(out)
}

/// Every placed item of a tierlist answer, in tier order. Items in tiers
/// the question no longer defines (a framework update renamed one) still
/// count as placed.
fn all_placed_items<'a>(answer: &'a serde_json::Value) -> Vec<&'a str> {
    let mut out: Vec<&'a str> = Vec::new();
    if let Some(map) = answer.as_object() {
        for list in map.values() {
            if let Some(arr) = list.as_array() {
                out.extend(arr.iter().filter_map(|v| v.as_str()));
            }
        }
    }
    out
}

fn eval_condition(
    c: &Condition,
    answers: &Answers,
    parts: &HashSet<String>,
    orders: &BTreeMap<String, Vec<String>>,
) -> bool {
    match c {
        Condition::All { all } => all.iter().all(|c| eval_condition(c, answers, parts, orders)),
        Condition::Any { any } => any.iter().any(|c| eval_condition(c, answers, parts, orders)),
        Condition::Not { not } => !eval_condition(not, answers, parts, orders),
        Condition::Part { part, installed } => parts.contains(part) == *installed,
        Condition::Cmp {
            id,
            equals,
            not_equals,
            includes,
            min,
            max,
            answered,
            tier,
            tier_at_least,
        } => {
            let answer = answers.get(id);
            // The value list a tierlist-scoped comparison sees (None = not
            // tier-scoped or the answer isn't a tierlist object).
            let scoped: Option<Option<Vec<&str>>> = match (tier, tier_at_least) {
                (Some(t), _) => Some(answer.and_then(|a| {
                    orders
                        .get(id)
                        .and_then(|tiers| tier_scoped_items(a, tiers, t, false))
                })),
                (None, Some(t)) => Some(answer.and_then(|a| {
                    orders
                        .get(id)
                        .and_then(|tiers| tier_scoped_items(a, tiers, t, true))
                })),
                // Unscoped tierlist answers still count as item lists for
                // `includes`/`min`/`max` — "placed anywhere".
                (None, None) => match answer {
                    Some(a) if a.is_object() => Some(Some(all_placed_items(a))),
                    _ => None,
                },
            };
            let mut ok = true;
            if let Some(expected) = equals {
                ok &= answer.map(|a| value_matches(a, expected)).unwrap_or(false);
            }
            if let Some(expected) = not_equals {
                // Unknown answers can't be asserted unequal.
                ok &= answer.map(|a| !value_matches(a, expected)).unwrap_or(false);
            }
            if let Some(needle) = includes {
                let needle_str = needle.as_str();
                ok &= match &scoped {
                    Some(items) => items
                        .as_ref()
                        .map(|items| {
                            needle_str
                                .map(|n| items.contains(&n))
                                .unwrap_or(false)
                        })
                        .unwrap_or(false),
                    None => answer
                        .map(|a| match a {
                            serde_json::Value::Array(items) => items
                                .iter()
                                .any(|v| value_matches(v, needle)),
                            serde_json::Value::String(s) => needle_str
                                .map(|n| s.contains(n))
                                .unwrap_or(false),
                            _ => false,
                        })
                        .unwrap_or(false),
                };
            }
            if let Some(bound) = min {
                ok &= match &scoped {
                    Some(items) => items.as_ref().map(|i| i.len()).unwrap_or(0) as f64 >= *bound,
                    None => answer.and_then(|a| a.as_f64()).map(|a| a >= *bound).unwrap_or(false),
                };
            }
            if let Some(bound) = max {
                ok &= match &scoped {
                    Some(items) => items.as_ref().map(|i| i.len()).unwrap_or(0) as f64 <= *bound,
                    None => answer.and_then(|a| a.as_f64()).map(|a| a <= *bound).unwrap_or(false),
                };
            }
            if let Some(want) = answered {
                let has = match &scoped {
                    // Scoped: the named tier(s) hold at least one item.
                    Some(items) => items.as_ref().map(|i| !i.is_empty()).unwrap_or(false),
                    // Unscoped: the question has an answer at all.
                    None => is_answered(answer),
                };
                ok &= has == *want;
            }
            ok
        }
    }
}

/// Items visible given the current answers and installed parts
/// (evaluated top to bottom).
pub fn visible_items<'a>(
    items: &'a [OnboardingItem],
    answers: &Answers,
    parts: &HashSet<String>,
) -> Vec<&'a OnboardingItem> {
    let orders = tier_orders(items);
    items
        .iter()
        .filter(|item| {
            item.show_if()
                .map(|c| eval_condition(c, answers, parts, &orders))
                .unwrap_or(true)
        })
        .collect()
}

/// Question ids that are visible (not hidden by the answer set).
fn visible_question_ids(
    items: &[OnboardingItem],
    answers: &Answers,
    parts: &HashSet<String>,
) -> Vec<String> {
    visible_items(items, answers, parts)
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
            // Tierlist placement objects: any item placed anywhere counts.
            serde_json::Value::Object(map) => map.values().any(|v| {
                v.as_array().map(|a| !a.is_empty()).unwrap_or(false)
            }),
            serde_json::Value::Null => false,
            _ => true,
        })
        .unwrap_or(false)
}

/// A question the flow can move past: answered, or explicitly skipped
/// (`null` — only possible for `optional` questions).
fn is_resolved(answer: Option<&serde_json::Value>) -> bool {
    match answer {
        Some(serde_json::Value::Null) => true,
        other => is_answered(other),
    }
}

// ============================================================================
// Storage
// ============================================================================

/// Every part name a `config.json` under `root` could select (used to
/// validate `part` conditions at stage time).
fn config_parts(pkg_root: &Path) -> Vec<String> {
    crate::package_manifest::Config::from_pkg_root(pkg_root)
        .map(|c| {
            let mut parts: Vec<String> = Vec::new();
            for group in &c.options {
                for choice in group.choices() {
                    if !parts.contains(&choice.part) {
                        parts.push(choice.part.clone());
                    }
                }
            }
            parts
        })
        .unwrap_or_default()
}

/// Read + validate the framework's onboarding flow from a staged/extracted
/// package root. `Ok(None)` when the framework ships none.
pub fn from_pkg_root(pkg_root: &Path) -> Result<Option<Flow>, String> {
    let parts = config_parts(pkg_root);
    resolve_flow(pkg_root, Some(&parts))
}

/// The installed flow under the data dir (include files were copied there
/// at install). Tolerant: a broken/missing flow yields an empty default.
fn load_installed_flow(data_dir: &Path) -> Flow {
    resolve_flow(data_dir, None)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Part folders that were installed (from the installed-framework record).
fn installed_parts(data_dir: &Path) -> HashSet<String> {
    crate::package_manifest::read_installed_framework(data_dir)
        .map(|rec| rec.parts.into_iter().collect())
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
    let parts = installed_parts(data_dir);
    let mut merged = load_answers(data_dir);
    merged.extend(session.iter().map(|(k, v)| (k.clone(), v.clone())));
    let visible = visible_question_ids(&flow.items, &merged, &parts);
    for q in flow.items.iter().filter_map(|i| match i {
        OnboardingItem::Question(q) => Some(q),
        _ => None,
    }) {
        if !visible.contains(&q.id) {
            merged.remove(&q.id);
        }
    }
    // Clarifications (`note:<id>`) ride along with their question: drop
    // them when the question is hidden, skipped, or otherwise unanswered —
    // a clarification without an answer has nothing to clarify.
    let stale: Vec<String> = merged
        .keys()
        .filter(|k| k.starts_with(NOTE_PREFIX))
        .filter(|k| {
            k.strip_prefix(NOTE_PREFIX)
                .map(|id| !visible.iter().any(|v| v == id) || !is_answered(merged.get(id)))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    for k in stale {
        merged.remove(&k);
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
    let parts = installed_parts(data_dir);
    let answered = merged_answers(data_dir, &Answers::default());
    let pending_count = visible_items(&flow.items, &answered, &parts)
        .iter()
        .filter(|item| match item {
            OnboardingItem::Question(q) => !is_resolved(answered.get(&q.id)),
            _ => false,
        })
        .count();
    OnboardingState {
        items: flow.items,
        answered,
        pending_count,
    }
}

/// Render the answer file (`USER.md` or the flow's `output`) into the agent
/// sandbox. One line per visible, answered question — the prompt as a bold
/// key followed by the answer — kept deliberately terse since the file is
/// typically inlined into prompts. Choice questions also list the options
/// the user did NOT pick (and flag multi-select) so the agent knows the
/// full option set, not just the selection; tierlist answers read tier by
/// tier in definition order (`S: a, b | B: c`). A question's free-text
/// clarification (`note:<id>`, the addendum the UI offers on non-open
/// questions) is appended to its line. Skipped (`null`) and
/// still-unanswered questions render nothing. A trailing "App setup"
/// section heads the agent up about app-managed state the questionnaire
/// never asked about (chastity, inventory).
pub(crate) fn write_user_md(agent_dir: &Path, data_dir: &Path) -> Result<(), String> {
    let flow = load_installed_flow(data_dir);
    let parts = installed_parts(data_dir);
    let answered = merged_answers(data_dir, &Answers::default());
    let mut md = String::from(
        "# User profile\n\n\
         Onboarding answers. Plain sandbox data — the framework's prompts decide how the\n\
         agent consumes this file.\n\n",
    );
    let mut wrote = 0;
    for item in visible_items(&flow.items, &answered, &parts) {
        let OnboardingItem::Question(q) = item else {
            continue;
        };
        // Skipped (`null`) answers render nothing — there is no data.
        let answer = match answered.get(&q.id) {
            Some(serde_json::Value::Null) | None => continue,
            Some(answer) => answer,
        };
        let mut line = match (&q.answer, answer) {
            // Choices: the picked option(s) plus the declined ones, so the
            // agent sees the whole menu. Multi-select is flagged.
            (
                AnswerKind::Choice,
                serde_json::Value::Array(selected),
            ) => {
                let chosen: Vec<&str> = selected
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect();
                let declined: Vec<&str> = q
                    .choices
                    .iter()
                    .map(String::as_str)
                    .filter(|c| !chosen.contains(c))
                    .collect();
                let list = chosen.join(", ");
                let mut line = format!("**{}** (multiple choice) {}", q.prompt, list);
                if !declined.is_empty() {
                    line.push_str(&format!(" (not chosen: {})", declined.join(", ")));
                }
                line
            }
            (AnswerKind::Choice, single) => {
                let chosen = single
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| single.to_string());
                let declined: Vec<&str> = q
                    .choices
                    .iter()
                    .map(String::as_str)
                    .filter(|c| *c != chosen)
                    .collect();
                let mut line = format!("**{}** {}", q.prompt, chosen);
                if !declined.is_empty() {
                    line.push_str(&format!(" (not chosen: {})", declined.join(", ")));
                }
                line
            }
            // Ratings carry their scale — a bare "7" is meaningless without
            // the range it came from.
            (AnswerKind::Rating, value) => format!(
                "**{}** {} (scale {}–{})",
                q.prompt,
                value.as_str().unwrap_or(&value.to_string()),
                q.min,
                q.max
            ),
            // Rankings keep the user's order; "a > b > c" reads as preference.
            (AnswerKind::Ranking, serde_json::Value::Array(items)) => {
                let ranked: Vec<&str> =
                    items.iter().filter_map(|v| v.as_str()).collect();
                format!("**{}** (ranking) {}", q.prompt, ranked.join(" > "))
            }
            // Tierlists read tier by tier, in the tiers' definition order;
            // empty tiers render nothing (only what the user placed).
            (AnswerKind::Tierlist, serde_json::Value::Object(map)) => {
                let rows: Vec<String> = q
                    .tiers
                    .iter()
                    .filter_map(|tier| {
                        let items = map.get(tier)?;
                        let items: Vec<&str> = items
                            .as_array()?
                            .iter()
                            .filter_map(|v| v.as_str())
                            .collect();
                        if items.is_empty() {
                            None
                        } else {
                            Some(format!("{tier}: {}", items.join(", ")))
                        }
                    })
                    .collect();
                let body = if rows.is_empty() {
                    "nothing placed".to_string()
                } else {
                    rows.join(" | ")
                };
                format!("**{}** (tierlist) {}", q.prompt, body)
            }
            (_, other) => format!(
                "**{}** {}",
                q.prompt,
                other.as_str().unwrap_or(&other.to_string())
            ),
        };
        // The clarification the UI offers on non-open questions rides on the
        // answer's line, in the user's own words.
        if let Some(note) = answered
            .get(&note_key(&q.id))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            line.push_str(&format!(" — note: \"{note}\""));
        }
        md.push_str(&line);
        md.push_str("\n\n");
        wrote += 1;
    }
    if wrote == 0 {
        md.push_str("_(No answers yet.)_\n\n");
    }
    md.push_str(&app_setup_section(&data_dir.join("state")));
    let target = agent_dir.join(flow.output.trim());
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("{}: {e}", flow.output))?;
    }
    std::fs::write(&target, md).map_err(|e| format!("{}: {e}", flow.output))
}

/// The app-setup heads-up appended to the answer file: a save-time
/// snapshot of app-managed state the questionnaire didn't ask about, so
/// the agent knows chastity and the gear inventory are in play. The
/// builtins are the live source of truth.
fn app_setup_section(state_dir: &Path) -> String {
    let ch = crate::chastity::ChastityState::load(&state_dir.join("chastity.json"));
    let chastity_line = if ch.locked {
        format!(
            "**Chastity** locked (since {}) — the user is locked in right now; only the \
             agent can release them (`chastity unlock`, or a `state: unlocked` gate that \
             also reveals their code).\n",
            ch.locked_at.as_deref().unwrap_or("?")
        )
    } else if ch.locked_at.is_some() {
        "**Chastity** currently unlocked — the user has trained with a lock before.\n"
            .to_string()
    } else {
        "**Chastity** not set up.\n".to_string()
    };
    let items = crate::inventory::count_items(&state_dir.join("inventory.db")).unwrap_or(0);
    let inventory_line = if items > 0 {
        format!(
            "**Inventory** filled — {items} items owned (list them with `inventory items`).\n"
        )
    } else {
        "**Inventory** empty so far.\n".to_string()
    };
    format!(
        "## App setup\n\n\
         Auto-added by the app; live values come from the `chastity` and `inventory` \
         builtins.\n\n{}\n{}\n",
        chastity_line, inventory_line
    )
}

// ============================================================================
// Stepping
// ============================================================================

#[derive(Serialize, Clone, Debug)]
pub struct OnboardingStep {
    /// Consecutive visible text blocks leading up to the question.
    pub texts: Vec<String>,
    /// The next visible, unresolved question (`None` = flow complete).
    pub question: Option<QuestionItem>,
    /// Unresolved visible questions, including the current one.
    pub remaining: usize,
    /// Total visible questions.
    pub total: usize,
}

/// Compute the next screen: walk visible items, accumulating text blocks;
/// the first unresolved question ends the screen (answered or skipped —
/// `null` — both count as resolved). Text blocks after the last resolved
/// question with no question left arrive on a final, question-less screen.
fn step_for(
    flow: &[OnboardingItem],
    answers: &Answers,
    parts: &HashSet<String>,
) -> OnboardingStep {
    let visible = visible_items(flow, answers, parts);
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
        .filter(|q| !is_resolved(answers.get(&q.id)))
        .count();

    let mut texts: Vec<String> = Vec::new();
    for item in &visible {
        match item {
            OnboardingItem::Text(t) => texts.push(t.text.clone()),
            OnboardingItem::Question(q) => {
                if !is_resolved(answers.get(&q.id)) {
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
    let parts = installed_parts(&state.data_dir);
    let mut answers = load_answers(&state.data_dir);
    if let Some(session) = session {
        answers.extend(session);
    }
    Ok(step_for(&flow.items, &answers, &parts))
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

    fn no_parts() -> HashSet<String> {
        HashSet::new()
    }

    fn parts(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

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
        // `note:`-prefixed ids are reserved for answer clarifications.
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "note:x", "answer": "open", "prompt": "p" }]"#
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
            eval_condition(&cond, a, &no_parts(), &BTreeMap::new())
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
    fn part_conditions() {
        let installed = parts(&["journal", "fitness"]);
        let eval = |c: &str, p: &HashSet<String>| {
            let cond: Condition = serde_json::from_str(c).unwrap();
            eval_condition(&cond, &Answers::default(), p, &BTreeMap::new())
        };
        assert!(eval(r#"{ "part": "journal" }"#, &installed));
        assert!(!eval(r#"{ "part": "voice" }"#, &installed));
        assert!(eval(r#"{ "part": "voice", "installed": false }"#, &installed));
        assert!(!eval(r#"{ "part": "journal", "installed": false }"#, &installed));
        // Combines with other conditions.
        assert!(eval(
            r#"{ "all": [ { "part": "journal" }, { "not": { "part": "voice" } } ] }"#,
            &installed
        ));
    }

    #[test]
    fn visibility_hides_downstream_questions() {
        let f = flow();
        // "none": advanced questions hidden.
        let mut a = Answers::new();
        a.insert("exp".into(), json!("none"));
        let ids = visible_question_ids(&f, &a, &no_parts());
        assert_eq!(ids, vec!["exp".to_string()]);

        // "lots": everything visible.
        a.insert("exp".into(), json!("lots"));
        assert_eq!(visible_question_ids(&f, &a, &no_parts()).len(), 4);

        // Step: after answering exp, the next screen is the conditional
        // text + the focus question.
        let step = step_for(&f, &a, &no_parts());
        assert_eq!(step.question.as_ref().unwrap().id, "focus");
        assert_eq!(step.texts.len(), 1);
        assert_eq!(step.remaining, 3);

        // Complete flow: remaining hits 0 and the final screen has no
        // question.
        a.insert("focus".into(), json!("voice"));
        a.insert("intensity".into(), json!(8));
        a.insert("contact".into(), json!("no"));
        let step = step_for(&f, &a, &no_parts());
        assert!(step.question.is_none());
        assert_eq!(step.remaining, 0);
    }

    #[test]
    fn optional_questions_can_be_skipped() {
        let flow = parse_flow(
            r###"[
            { "kind": "question", "id": "name", "answer": "open",
              "prompt": "Name?", "optional": true },
            { "kind": "question", "id": "why", "answer": "open",
              "prompt": "Why?", "showIf": { "id": "name", "answered": true } }
        ]"###,
        )
        .unwrap();

        // Unanswered: the optional question is the next screen.
        let step = step_for(&flow, &Answers::new(), &no_parts());
        assert_eq!(step.question.as_ref().unwrap().id, "name");
        assert_eq!(step.remaining, 1);

        // Skipped (`null`): counts as resolved for progress…
        let mut a = Answers::new();
        a.insert("name".into(), serde_json::Value::Null);
        let step = step_for(&flow, &a, &no_parts());
        assert!(step.question.is_none(), "skipped optional completes the flow");
        assert_eq!(step.remaining, 0);
        // …but evaluates as unanswered for `showIf` (the `why` question
        // stayed hidden above).

        // USER.md renders nothing for a skipped question.
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let agent = data.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(data.join(QUESTIONS_FILE), serde_json::to_string(&flow).unwrap()).unwrap();
        std::fs::write(data.join(ANSWERS_FILE), serde_json::to_string(&a).unwrap()).unwrap();
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains("(No answers yet.)"));
        assert!(!md.contains("Name?"));
        let _ = tmp;
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
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains("**Experience?** none"));
        assert!(md.contains("not chosen: some, lots"));
        assert!(!md.contains("focus"));
        assert!(!md.contains("<!--"), "no id comment headers");
        let _ = tmp;
    }

    #[test]
    fn user_md_marks_multi_choice_and_declined_options() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let agent = data.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        let flow = parse_flow(
            r###"[
            { "kind": "question", "id": "topics", "answer": "choice", "multiple": true,
              "prompt": "Topics?", "choices": ["voice", "posture", "fitness"] },
            { "kind": "question", "id": "style", "answer": "choice",
              "prompt": "Style?", "choices": ["strict", "gentle"] },
            { "kind": "question", "id": "heat", "answer": "rating", "min": 1, "max": 5,
              "prompt": "Heat?" },
            { "kind": "question", "id": "order", "answer": "ranking",
              "prompt": "Prefer?", "choices": ["rope", "impact"] }
        ]"###,
        )
        .unwrap();
        std::fs::write(data.join(QUESTIONS_FILE), serde_json::to_string(&flow).unwrap()).unwrap();
        let mut answers = Answers::new();
        answers.insert("topics".into(), json!(["voice", "fitness"]));
        answers.insert("style".into(), json!("strict"));
        answers.insert("heat".into(), json!(4));
        answers.insert("order".into(), json!(["impact", "rope"]));
        std::fs::write(data.join(ANSWERS_FILE), serde_json::to_string(&answers).unwrap()).unwrap();
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains("**Topics?** (multiple choice) voice, fitness (not chosen: posture)"));
        assert!(md.contains("**Style?** strict (not chosen: gentle)"));
        assert!(md.contains("**Heat?** 4 (scale 1–5)"));
        assert!(md.contains("**Prefer?** (ranking) impact > rope"));
        let _ = tmp;
    }

    #[test]
    fn ranking_questions_validate_and_answer_like_arrays() {
        // Ranking needs choices, same as choice…
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "r", "answer": "ranking", "prompt": "p" }]"#
        )
        .is_err());
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "r", "answer": "ranking", "prompt": "p", "choices": ["a"] }]"#
        )
        .is_err());
        let _flow = parse_flow(
            r#"[{ "kind": "question", "id": "r", "answer": "ranking", "prompt": "p", "choices": ["a", "b"] }]"#
        )
        .unwrap();

        // …and a ranked answer is a plain array, so `includes` conditions
        // match against its entries.
        let mut a = Answers::new();
        a.insert("r".into(), json!(["b", "a"]));
        assert!(eval_condition(
            &serde_json::from_str::<Condition>(r#"{ "id": "r", "includes": "b" }"#).unwrap(),
            &a,
            &no_parts(),
            &BTreeMap::new()
        ));
        assert!(is_answered(a.get("r")));
    }

    #[test]
    fn tierlist_questions_validate() {
        // Needs tiers…
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "t", "answer": "tierlist", "prompt": "p",
                 "choices": ["a", "b"] }]"#
        )
        .is_err());
        // …at least two of them,…
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "t", "answer": "tierlist", "prompt": "p",
                 "choices": ["a", "b"], "tiers": ["S"] }]"#
        )
        .is_err());
        // …unique and non-empty,…
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "t", "answer": "tierlist", "prompt": "p",
                 "choices": ["a", "b"], "tiers": ["S", "S"] }]"#
        )
        .is_err());
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "t", "answer": "tierlist", "prompt": "p",
                 "choices": ["a", "b"], "tiers": ["S", " "] }]"#
        )
        .is_err());
        // …and at least two unique items.
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "t", "answer": "tierlist", "prompt": "p",
                 "choices": ["a", "a"], "tiers": ["S", "A"] }]"#
        )
        .is_err());
        assert!(parse_flow(
            r#"[{ "kind": "question", "id": "t", "answer": "tierlist", "prompt": "p",
                 "choices": ["a", "b"], "tiers": ["S", "A"] }]"#
        )
        .is_ok());
    }

    #[test]
    fn tier_conditions_scope_placements() {
        let f = parse_flow(
            r###"[
            { "kind": "question", "id": "toys", "answer": "tierlist", "prompt": "Rate",
              "choices": ["rope", "impact", "blindfold"], "tiers": ["S", "A", "B"] }
        ]"###,
        )
        .unwrap();
        let orders = tier_orders(&f);
        let eval = |c: &str, a: &Answers| {
            let cond: Condition = serde_json::from_str(c).unwrap();
            eval_condition(&cond, a, &no_parts(), &orders)
        };

        let mut a = Answers::new();
        a.insert("toys".into(), json!({ "S": ["rope"], "B": ["impact"] }));

        // `includes` without a tier: placed anywhere.
        assert!(eval(r#"{ "id": "toys", "includes": "rope" }"#, &a));
        assert!(eval(r#"{ "id": "toys", "includes": "impact" }"#, &a));
        assert!(!eval(r#"{ "id": "toys", "includes": "blindfold" }"#, &a));

        // `tier` is an exact placement test.
        assert!(eval(r#"{ "id": "toys", "tier": "S", "includes": "rope" }"#, &a));
        assert!(!eval(r#"{ "id": "toys", "tier": "A", "includes": "rope" }"#, &a));

        // `tierAtLeast` includes the named tier and everything above it:
        // impact sits in B, so it's "at least B" but not "at least A".
        assert!(eval(r#"{ "id": "toys", "tierAtLeast": "B", "includes": "impact" }"#, &a));
        assert!(eval(r#"{ "id": "toys", "tierAtLeast": "S", "includes": "rope" }"#, &a));
        assert!(!eval(r#"{ "id": "toys", "tierAtLeast": "A", "includes": "impact" }"#, &a));

        // Unknown tiers never match.
        assert!(!eval(r#"{ "id": "toys", "tier": "Z", "includes": "rope" }"#, &a));
        assert!(!eval(r#"{ "id": "toys", "tierAtLeast": "Z", "includes": "rope" }"#, &a));

        // Tier item counts (`min`/`max`) and per-tier `answered`.
        assert!(eval(r#"{ "id": "toys", "tier": "S", "min": 1 }"#, &a));
        assert!(eval(r#"{ "id": "toys", "tier": "S", "max": 1 }"#, &a));
        assert!(!eval(r#"{ "id": "toys", "tier": "A", "answered": true }"#, &a));
        assert!(eval(r#"{ "id": "toys", "tier": "A", "answered": false }"#, &a));
        // Unscoped: totals across all tiers.
        assert!(eval(r#"{ "id": "toys", "min": 2 }"#, &a));
        assert!(!eval(r#"{ "id": "toys", "min": 3 }"#, &a));
        assert!(eval(r#"{ "id": "toys", "answered": true }"#, &a));

        // Tier scoping a non-tierlist question is a parse error, as is an
        // unknown tier name, as is combining both scopes.
        assert!(parse_flow(
            r###"[
            { "kind": "question", "id": "n", "answer": "open", "prompt": "p" },
            { "kind": "text", "text": "x",
              "showIf": { "id": "n", "tier": "S", "includes": "x" } }
        ]"###,
        )
        .is_err());
        assert!(parse_flow(
            r###"[
            { "kind": "question", "id": "toys", "answer": "tierlist", "prompt": "Rate",
              "choices": ["a", "b"], "tiers": ["S", "A"] },
            { "kind": "text", "text": "x",
              "showIf": { "id": "toys", "tier": "Z", "includes": "a" } }
        ]"###,
        )
        .is_err());
        assert!(parse_flow(
            r###"[
            { "kind": "question", "id": "toys", "answer": "tierlist", "prompt": "Rate",
              "choices": ["a", "b"], "tiers": ["S", "A"] },
            { "kind": "text", "text": "x",
              "showIf": { "id": "toys", "tier": "S", "tierAtLeast": "A", "includes": "a" } }
        ]"###,
        )
        .is_err());
        // Conditions still need a comparator alongside the tier scope.
        assert!(parse_flow(
            r###"[
            { "kind": "question", "id": "toys", "answer": "tierlist", "prompt": "Rate",
              "choices": ["a", "b"], "tiers": ["S", "A"] },
            { "kind": "text", "text": "x", "showIf": { "id": "toys", "tier": "S" } }
        ]"###,
        )
        .is_err());
    }

    #[test]
    fn tierlist_answers_drive_visibility_and_render_per_tier() {
        let flow = parse_flow(
            r###"[
            { "kind": "question", "id": "toys", "answer": "tierlist", "prompt": "Rate your toys",
              "choices": ["rope", "impact", "blindfold"], "tiers": ["S", "A", "B"] },
            { "kind": "question", "id": "rope_depth", "answer": "open", "prompt": "Rope how?",
              "showIf": { "id": "toys", "tierAtLeast": "A", "includes": "rope" } },
            { "kind": "question", "id": "blindfold_when", "answer": "open", "prompt": "Blindfolds when?",
              "showIf": { "id": "toys", "tier": "S", "includes": "blindfold" } }
        ]"###,
        )
        .unwrap();

        // rope in B: the "rope how?" follow-up (A or better) hides; blindfold
        // unplaced hides too. Placing rope in A and blindfold in S shows both.
        let mut a = Answers::new();
        a.insert("toys".into(), json!({ "B": ["rope"] }));
        assert_eq!(visible_question_ids(&flow, &a, &no_parts()).len(), 1);
        a.insert("toys".into(), json!({ "A": ["rope"], "S": ["blindfold", "impact"] }));
        let ids = visible_question_ids(&flow, &a, &no_parts());
        assert_eq!(ids.len(), 3);

        // An empty placement object counts as unanswered.
        a.insert("toys".into(), json!({}));
        assert!(!is_answered(a.get("toys")));

        // USER.md renders tier by tier, definition order, skipping empties.
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let agent = data.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        a.insert("toys".into(), json!({ "A": ["rope"], "S": ["blindfold", "impact"] }));
        std::fs::write(data.join(QUESTIONS_FILE), serde_json::to_string(&flow).unwrap()).unwrap();
        std::fs::write(data.join(ANSWERS_FILE), serde_json::to_string(&a).unwrap()).unwrap();
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains(
            "**Rate your toys** (tierlist) S: blindfold, impact | A: rope"
        ));
        let _ = tmp;
    }

    #[test]
    fn clarifications_render_and_prune_with_their_question() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let agent = data.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(data.join(QUESTIONS_FILE), serde_json::to_string(&flow()).unwrap()).unwrap();

        // Clarifications ride on their answers' lines…
        let mut session = Answers::new();
        session.insert("exp".into(), json!("lots"));
        session.insert(note_key("exp"), json!("mostly rope, light impact"));
        session.insert("intensity".into(), json!(8));
        session.insert(note_key("intensity"), json!("higher on weekends"));
        // …but one without an answer, and one for a non-question, are
        // dropped at merge time.
        session.insert(note_key("focus"), json!("orphan"));
        session.insert(note_key("ghost"), json!("no such question"));
        let merged = merged_answers(data, &session);
        assert!(merged.contains_key(note_key("exp").as_str()));
        assert!(merged.contains_key(note_key("intensity").as_str()));
        assert!(!merged.contains_key(note_key("focus").as_str()));
        assert!(!merged.contains_key(note_key("ghost").as_str()));

        std::fs::write(
            data.join(ANSWERS_FILE),
            serde_json::to_string(&merged).unwrap(),
        )
        .unwrap();
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains(
            "**Experience?** lots (not chosen: none, some) — note: \"mostly rope, light impact\""
        ));
        assert!(md.contains("**Intensity 1-10?** 8 (scale 1–10) — note: \"higher on weekends\""));
        assert!(!md.contains("orphan"));
        let _ = tmp;
    }

    #[test]
    fn user_md_appends_app_setup_headsup() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let agent = data.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(data.join(QUESTIONS_FILE), serde_json::to_string(&flow()).unwrap())
            .unwrap();

        // No app state at all → neutral lines.
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains("## App setup"));
        assert!(md.contains("**Chastity** not set up."));
        assert!(md.contains("**Inventory** empty so far."));

        // Locked + filled inventory → the agent gets a real heads-up.
        let state = data.join("state");
        std::fs::create_dir_all(&state).unwrap();
        crate::chastity::ChastityState {
            locked: true,
            hidden_string: Some("1234".into()),
            revealed: false,
            locked_at: Some("2026-08-28T10:00:00+02:00".into()),
        }
        .save(&state.join("chastity.json"))
        .unwrap();
        crate::inventory::ensure_schema(&state.join("inventory.db")).unwrap();
        rusqlite::Connection::open(state.join("inventory.db"))
            .unwrap()
            .execute(
                "INSERT INTO items (name, category, quantity, notes, created_at, updated_at) \
                 VALUES ('cage', NULL, 1, NULL, 't', 't')",
                [],
            )
            .unwrap();
        write_user_md(&agent, data).unwrap();
        let md = std::fs::read_to_string(agent.join("USER.md")).unwrap();
        assert!(md.contains("**Chastity** locked (since 2026-08-28T10:00:00+02:00)"));
        assert!(md.contains("**Inventory** filled — 1 items owned"));
        // The hidden code itself must NOT leak into the answer file.
        assert!(!md.contains("1234"));
        let _ = tmp;
    }

    #[test]
    fn object_form_sets_output_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"{ "output": "profile/PROFILE.md", "items": [
                { "kind": "question", "id": "nick", "answer": "open",
                  "prompt": "Nickname?" } ] }"#,
        )
        .unwrap();
        let flow = resolve_flow(root, None).unwrap().expect("flow present");
        assert_eq!(flow.output, "profile/PROFILE.md");
        assert_eq!(flow.items.len(), 1);

        // The answer file lands at the custom path (dirs created).
        let agent = root.join("agent_data");
        std::fs::create_dir_all(&agent).unwrap();
        let mut answers = Answers::new();
        answers.insert("nick".into(), json!("spark"));
        std::fs::write(root.join(ANSWERS_FILE), serde_json::to_string(&answers).unwrap()).unwrap();
        write_user_md(&agent, root).unwrap();
        let md = std::fs::read_to_string(agent.join("profile").join("PROFILE.md")).unwrap();
        assert!(md.contains("**Nickname?** spark"));
        assert!(!agent.join("USER.md").exists());

        // Unsafe output paths are rejected.
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"{ "output": "../escape.md", "items": [ { "kind": "text", "text": "x" } ] }"#,
        )
        .unwrap();
        assert!(resolve_flow(root, None).is_err());
        let _ = tmp;
    }

    #[test]
    fn includes_splice_and_hoist_conditions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("onboarding")).unwrap();
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"{ "items": [
                { "kind": "question", "id": "exp", "answer": "choice",
                  "prompt": "Experience?", "choices": ["none", "lots"] },
                { "kind": "include", "src": "onboarding/advanced.json",
                  "showIf": { "id": "exp", "equals": "lots" } },
                { "kind": "include", "src": "onboarding/journal.json",
                  "showIf": { "part": "journal" } } ] }"#,
        )
        .unwrap();
        std::fs::write(
            root.join("onboarding").join("advanced.json"),
            r#"[
                { "kind": "text", "text": "Advanced section" },
                { "kind": "question", "id": "deep", "answer": "open", "prompt": "Deep?",
                  "showIf": { "id": "exp", "answered": true } } ]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("onboarding").join("journal.json"),
            r#"[ { "kind": "question", "id": "jrn", "answer": "open", "prompt": "Journaling?" } ]"#,
        )
        .unwrap();

        // Part validation: journal is a config-selectable part.
        let flow = resolve_flow(root, Some(&["journal".to_string()]))
            .unwrap()
            .expect("flow present");
        assert_eq!(flow.items.len(), 4, "includes spliced in place");
        assert_eq!(
            flow.includes,
            vec!["onboarding/advanced.json", "onboarding/journal.json"]
        );

        // Include showIf is ANDed onto each spliced item's own condition:
        // with exp="none" the advanced block (incl. its text) hides; the
        // journal block shows because the part is installed.
        let mut a = Answers::new();
        a.insert("exp".into(), json!("none"));
        let with_part = parts(&["journal"]);
        let ids = visible_question_ids(&flow.items, &a, &with_part);
        assert_eq!(ids, vec!["exp".to_string(), "jrn".to_string()]);

        // Without the part installed, only exp is visible.
        let ids = visible_question_ids(&flow.items, &a, &no_parts());
        assert_eq!(ids, vec!["exp".to_string()]);

        // exp="lots": the nested per-item showIf (answered: true) also
        // gates `deep`.
        a.insert("exp".into(), json!("lots"));
        let ids = visible_question_ids(&flow.items, &a, &with_part);
        assert!(ids.contains(&"deep".to_string()));

        // Unknown part reference fails validation when parts are known.
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"[ { "kind": "text", "text": "x", "showIf": { "part": "nope" } } ]"#,
        )
        .unwrap();
        assert!(resolve_flow(root, Some(&["journal".to_string()])).is_err());
        // …but passes without known parts (runtime re-read has no config).
        assert!(resolve_flow(root, None).is_ok());
        let _ = tmp;
    }

    #[test]
    fn include_errors_missing_file_and_cycles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Missing subfile.
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"[ { "kind": "include", "src": "onboarding/gone.json" } ]"#,
        )
        .unwrap();
        assert!(resolve_flow(root, None).is_err());

        // Include cycle.
        std::fs::create_dir_all(root.join("onboarding")).unwrap();
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"[ { "kind": "include", "src": "onboarding/a.json" } ]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("onboarding").join("a.json"),
            r#"[ { "kind": "include", "src": "onboarding/b.json" } ]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("onboarding").join("b.json"),
            r#"[ { "kind": "include", "src": "onboarding/a.json" } ]"#,
        )
        .unwrap();
        let err = resolve_flow(root, None).unwrap_err();
        assert!(err.contains("cycle"), "got: {err}");

        // Escaping paths are rejected.
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"[ { "kind": "include", "src": "../secrets.json" } ]"#,
        )
        .unwrap();
        assert!(resolve_flow(root, None).is_err());
        let _ = tmp;
    }

    #[test]
    fn from_pkg_root_validates_against_config_parts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("base")).unwrap();
        std::fs::write(
            root.join("config.json"),
            r#"{ "options": [ { "type": "multiple", "id": "extras", "title": "Extras",
                "choices": [ { "id": "j", "label": "J", "part": "journal" } ] } ] }"#,
        )
        .unwrap();
        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"[ { "kind": "question", "id": "q", "answer": "open", "prompt": "Q?",
                 "showIf": { "part": "journal" } } ]"#,
        )
        .unwrap();
        assert!(from_pkg_root(root).unwrap().is_some());

        std::fs::write(
            root.join(QUESTIONS_FILE),
            r#"[ { "kind": "question", "id": "q", "answer": "open", "prompt": "Q?",
                 "showIf": { "part": "ghost" } } ]"#,
        )
        .unwrap();
        assert!(from_pkg_root(root).is_err());
        let _ = tmp;
    }
}
