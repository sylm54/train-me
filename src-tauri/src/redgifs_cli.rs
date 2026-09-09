//! Agent-facing `redgifs` shell builtin (registered in `bash.rs`).
//!
//! The writing agent steers `<visual>` slideshows with niche ids, tags, and a
//! free-text search — and needs to know what actually exists on the source
//! before authoring. This builtin is that lookup surface (it replaces the old
//! auto-generated `docs/redgifs-discovery.md` snapshot): against the live
//! RedGIFs API, with the same anonymous-token flow as the visual source, it
//!
//! - searches the curated niche communities (`redgifs niches …`),
//! - lists trending tags with usage counts (`redgifs tags …`),
//! - counts how many gifs a niche+tags+search combination resolves to,
//!   including the top tags the matches actually carry (`redgifs count …`).
//!
//! All subcommands are read-only lookups — nothing is downloaded or cached
//! here (the player's discovery snapshot and media cache live elsewhere).
//! The bash worker processes commands serially, so every request is tightly
//! timeout-bounded and the output capped: one slow lookup must not stall the
//! whole sandbox.

use bashkit::{async_trait, Builtin, BuiltinContext, ExecResult};
use std::time::Duration;

use crate::visual::{temp_token_async, urlencode, REDGIFS_API, REDGIFS_REFERER, REDGIFS_UA};

/// One niche hit, flattened to what the agent picks from.
struct NicheHit {
    id: String,
    name: String,
    gifs: u64,
    subscribers: u64,
    tags: Vec<String>,
}

/// One trending tag.
struct TagHit {
    name: String,
    count: u64,
}

/// Parsed `redgifs count` arguments.
#[derive(Debug)]
struct CountQuery {
    niches: Vec<String>,
    tags: Vec<String>,
    search: Option<String>,
    order: Option<String>,
}

impl CountQuery {
    fn is_empty(&self) -> bool {
        self.niches.is_empty() && self.tags.is_empty() && self.search.is_none()
    }
}

pub struct RedgifsBuiltin;

impl RedgifsBuiltin {
    /// Register this builtin on a [`bashkit::BashBuilder`].
    pub fn register(builder: bashkit::BashBuilder) -> bashkit::BashBuilder {
        builder.builtin("redgifs", Box::new(Self))
    }
}

const USAGE: &str = "Usage:
  redgifs niches [query] [--limit N]
      search RedGIFs niche communities (TSV: id, name, gifs, subscribers, tags)
  redgifs tags [query] [--limit N]
      trending tags, substring-filtered (TSV: name, count)
  redgifs count --niche a,b --tags x,y --search \"text\" [--order O]
      how many gifs match the combination + top tags among them;
      at least one of --niche/--tags/--search is required
Orders: top, top7, top28, latest, score, trending
Defaults: --limit 20, results ordered by subscribers / trending";

#[async_trait]
impl Builtin for RedgifsBuiltin {
    async fn execute(&self, ctx: BuiltinContext<'_>) -> bashkit::Result<ExecResult> {
        let Some(sub) = ctx.args.first() else {
            return Ok(ExecResult::err(USAGE, 1));
        };
        let rest = &ctx.args[1..];
        let result = match sub.as_str() {
            "niches" => run_niches(rest).await,
            "tags" => run_tags(rest).await,
            "count" => run_count(rest).await,
            "help" | "--help" | "-h" => return Ok(ExecResult::ok(format!("{USAGE}\n"))),
            other => return Ok(ExecResult::err(format!("redgifs: unknown subcommand '{other}'\n{USAGE}\n"), 1)),
        };
        match result {
            Ok(out) => Ok(ExecResult::ok(out)),
            Err(e) => Ok(ExecResult::err(format!("redgifs: {e}\n"), 1)),
        }
    }
}

/// Shared async HTTP client — the bash worker is serial, so timeouts are
/// tight to bound how long one lookup can hold it.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(REDGIFS_UA)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// `redgifs niches [query] [--limit N]` — server-side filtered niche search
/// (the API's `query` param), ordered by subscribers. One page of 100 covers
/// the default limit; larger limits page on up to a hard cap.
async fn run_niches(args: &[String]) -> Result<String, String> {
    let parsed = parse_query_args(args)?;
    let limit = parsed.limit;
    let http = http_client()?;
    let token = temp_token_async(&http).await.map_err(|e| format!("{e:#}"))?;

    let mut out: Vec<NicheHit> = Vec::new();
    let mut page = 1u32;
    loop {
        let mut url = format!(
            "{REDGIFS_API}/v2/niches?count=100&page={page}&order=subscribers",
        );
        if let Some(q) = &parsed.query {
            url.push_str("&query=");
            url.push_str(&urlencode(q));
        }
        let resp = http
            .get(&url)
            .bearer_auth(&token)
            .header("Referer", REDGIFS_REFERER)
            .send()
            .await
            .map_err(|e| format!("niches request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("redgifs niches returned {}", resp.status()));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("decoding niches response: {e}"))?;
        let Some(arr) = body.get("niches").and_then(|n| n.as_array()) else {
            break;
        };
        for n in arr {
            let Some(id) = n.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            out.push(NicheHit {
                id: id.to_string(),
                name: n
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(id)
                    .to_string(),
                gifs: n.get("gifs").and_then(|v| v.as_u64()).unwrap_or(0),
                subscribers: n.get("subscribers").and_then(|v| v.as_u64()).unwrap_or(0),
                tags: string_list(n.get("tags")),
            });
        }
        let total = body.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
        let pages = body.get("pages").and_then(|v| v.as_u64()).unwrap_or(1);
        if out.len() >= limit || arr.is_empty() || (page as u64) >= pages || (out.len() as u64) >= total
        {
            break;
        }
        page += 1;
        if page > 5 {
            break; // hard cap: 500 niches is far past picking-a-vibe territory
        }
    }
    out.truncate(limit);
    Ok(format_niches(&out))
}

/// `redgifs tags [query] [--limit N]` — trending tags with usage counts,
/// substring-filtered client-side (the API has no tag-search endpoint).
async fn run_tags(args: &[String]) -> Result<String, String> {
    let parsed = parse_query_args(args)?;
    let http = http_client()?;
    let token = temp_token_async(&http).await.map_err(|e| format!("{e:#}"))?;
    let resp = http
        .get(format!("{REDGIFS_API}/v2/tags/trending"))
        .bearer_auth(&token)
        .header("Referer", REDGIFS_REFERER)
        .send()
        .await
        .map_err(|e| format!("tags request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("redgifs tags returned {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("decoding tags response: {e}"))?;
    let needle = parsed.query.as_deref().map(str::to_lowercase);
    let mut tags: Vec<TagHit> = Vec::new();
    if let Some(arr) = body.get("tags").and_then(|t| t.as_array()) {
        for t in arr {
            let Some(name) = t.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some(n) = &needle {
                if !name.to_lowercase().contains(n) {
                    continue;
                }
            }
            tags.push(TagHit {
                name: name.to_string(),
                count: t.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
            });
            if tags.len() >= parsed.limit {
                break;
            }
        }
    }
    Ok(format_tags(&tags))
}

/// `redgifs count --niche … --tags … --search … [--order …]` — resolve the
/// combination the way the player's search would (`/v2/gifs/search`) and
/// report the match count plus the top tags the matches carry (a ready-made
/// palette of tag spellings that actually hit).
async fn run_count(args: &[String]) -> Result<String, String> {
    let query = parse_count_args(args)?;
    if query.is_empty() {
        return Err(
            "count needs at least one of --niche, --tags, --search (an unfiltered count is just the whole site)".to_string(),
        );
    }
    let http = http_client()?;
    let token = temp_token_async(&http).await.map_err(|e| format!("{e:#}"))?;

    let mut params: Vec<(String, String)> = vec![("count".into(), "1".into())];
    if !query.niches.is_empty() {
        params.push(("niche_ids".into(), query.niches.join(",")));
    }
    if !query.tags.is_empty() {
        params.push(("tags".into(), query.tags.join(",")));
    }
    if let Some(q) = &query.search {
        params.push(("search_text".into(), q.clone()));
    }
    if let Some(o) = &query.order {
        params.push(("order".into(), o.clone()));
    }
    let qs = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let resp = http
        .get(format!("{REDGIFS_API}/v2/gifs/search?{qs}"))
        .bearer_auth(&token)
        .header("Referer", REDGIFS_REFERER)
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("redgifs search returned {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("decoding search response: {e}"))?;
    let total = body.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(format_count(total, &string_list(body.get("tags"))))
}

// ============================================================================
// Formatting (unit-tested)
// ============================================================================

/// TSV rows, tags column capped so one niche can't flood the output.
fn format_niches(hits: &[NicheHit]) -> String {
    let mut out = String::from("id\tname\tgifs\tsubscribers\ttags\n");
    for n in hits {
        let tags = match n.tags.len() {
            0 => String::from("-"),
            _ => {
                let shown: Vec<String> = n.tags.iter().take(8).cloned().collect();
                if n.tags.len() > 8 {
                    format!("{}, …", shown.join(", "))
                } else {
                    shown.join(", ")
                }
            }
        };
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\n",
            n.id, n.name, n.gifs, n.subscribers, tags
        ));
    }
    out
}

fn format_tags(tags: &[TagHit]) -> String {
    let mut out = String::from("name\tcount\n");
    for t in tags {
        out.push_str(&format!("{}\t{}\n", t.name, t.count));
    }
    out
}

/// The server caps search counts at 10000 — surface that explicitly so the
/// agent doesn't read a capped number as exact. Zero-match guidance points
/// at the usual fix (loosen a term).
fn format_count(total: u64, top_tags: &[String]) -> String {
    let mut out = String::new();
    if total == 0 {
        out.push_str("matches: 0 (nothing matches this combination — loosen a term)\n");
    } else if total >= 10_000 {
        out.push_str("matches: 10000+ (the server caps counts at 10000)\n");
    } else {
        out.push_str(&format!("matches: {total}\n"));
    }
    if !top_tags.is_empty() {
        out.push_str(&format!(
            "top tags in results: {}\n",
            top_tags.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    out
}

// ============================================================================
// Argument parsing (unit-tested)
// ============================================================================

/// `niches`/`tags` arguments: an optional positional query (joined words) and
/// an optional `--limit N`.
struct QueryArgs {
    query: Option<String>,
    limit: usize,
}

fn parse_query_args(args: &[String]) -> Result<QueryArgs, String> {
    let mut query: Vec<String> = Vec::new();
    let mut limit = 20usize;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--limit" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--limit needs a number".to_string());
                };
                limit = v.parse().map_err(|_| format!("--limit: '{v}' is not a number"))?;
                if limit == 0 {
                    return Err("--limit must be > 0".to_string());
                }
                limit = limit.min(100);
                i += 2;
            }
            other => {
                query.push(other.to_string());
                i += 1;
            }
        }
    }
    let query = if query.is_empty() {
        None
    } else {
        Some(query.join(" "))
    };
    Ok(QueryArgs { query, limit })
}

/// `count` arguments: `--niche`/`--tags`/`--search`/`--order`, each taking a
/// value (space or `=` form). Lists are comma-separated like the attributes.
fn parse_count_args(args: &[String]) -> Result<CountQuery, String> {
    let mut q = CountQuery {
        niches: Vec::new(),
        tags: Vec::new(),
        search: None,
        order: None,
    };
    let mut i = 0;
    while i < args.len() {
        let (flag, inline): (String, Option<String>) = match args[i].split_once('=') {
            Some((f, v)) => (f.to_string(), Some(v.to_string())),
            None => (args[i].clone(), None),
        };
        let value = match inline {
            Some(v) => {
                i += 1;
                v
            }
            None => match args.get(i + 1) {
                Some(v) => {
                    i += 2;
                    v.clone()
                }
                None => return Err(format!("{flag} needs a value")),
            },
        };
        match flag.as_str() {
            "--niche" | "--niches" => {
                q.niches = split_list(&value);
            }
            "--tags" | "--tag" => {
                q.tags = split_list(&value);
            }
            "--search" | "--query" => {
                q.search = Some(value).filter(|v| !v.trim().is_empty());
            }
            "--order" => {
                q.order = Some(value).filter(|v| !v.trim().is_empty());
            }
            other => return Err(format!("unknown flag '{other}'")),
        }
    }
    if let Some(o) = &q.order {
        if !crate::visual::KNOWN_ORDERS.contains(&o.as_str()) {
            return Err(format!(
                "unknown order '{o}'. Valid orders: {}",
                crate::visual::KNOWN_ORDERS.join(", ")
            ));
        }
    }
    Ok(q)
}

/// Comma-separated list → trimmed items, empties dropped (mirrors the
/// `<visual>` attribute lists; case is preserved — the server folds it).
fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// JSON array of strings → Vec (missing/invalid → empty).
fn string_list(v: Option<&serde_json::Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn query_args_defaults_and_positional() {
        let q = parse_query_args(&[]).unwrap();
        assert!(q.query.is_none());
        assert_eq!(q.limit, 20);
        let q = parse_query_args(&args(&["big", "boobs", "--limit", "5"])).unwrap();
        assert_eq!(q.query.as_deref(), Some("big boobs"));
        assert_eq!(q.limit, 5);
        assert!(parse_query_args(&args(&["--limit", "x"])).is_err());
        assert!(parse_query_args(&args(&["--limit"])).is_err());
        // Clamped to a sane ceiling so one lookup can't flood the sandbox.
        let q = parse_query_args(&args(&["--limit", "500"])).unwrap();
        assert_eq!(q.limit, 100);
    }

    #[test]
    fn count_args_flags_lists_and_validation() {
        let q = parse_count_args(&args(&[
            "--niche",
            "just-boobs, tik-tok",
            "--tags=hypno, spiral",
            "--search",
            "red latex",
        ]))
        .unwrap();
        assert_eq!(q.niches, vec!["just-boobs", "tik-tok"]);
        assert_eq!(q.tags, vec!["hypno", "spiral"]);
        assert_eq!(q.search.as_deref(), Some("red latex"));
        assert!(!q.is_empty());

        let q = parse_count_args(&args(&["--order", "top28"])).unwrap();
        assert_eq!(q.order.as_deref(), Some("top28"));
        assert!(q.is_empty(), "order alone is not a filter");

        let err = parse_count_args(&args(&["--order", "newest"])).unwrap_err();
        assert!(err.contains("unknown order"), "{err}");
        assert!(parse_count_args(&args(&["--niche"])).is_err());
        assert!(parse_count_args(&args(&["--nope", "x"])).is_err());
    }

    #[test]
    fn formatting_is_tsv_and_notes_caps() {
        let niches = vec![NicheHit {
            id: "just-boobs".into(),
            name: "Just Boobs".into(),
            gifs: 880_888,
            subscribers: 627_886,
            tags: (0..12).map(|i| format!("tag{i}")).collect(),
        }];
        let out = format_niches(&niches);
        assert!(out.starts_with("id\tname\tgifs\tsubscribers\ttags\n"));
        assert!(out.contains("just-boobs\tJust Boobs\t880888\t627886\t"));
        assert!(out.contains("tag7, …"), "tags column is capped: {out}");

        let out = format_tags(&[TagHit {
            name: "gooning".into(),
            count: 12_345,
        }]);
        assert_eq!(out, "name\tcount\ngooning\t12345\n");

        assert_eq!(
            format_count(0, &[]),
            "matches: 0 (nothing matches this combination — loosen a term)\n"
        );
        let capped = format_count(10_000, &["Hypno".to_string(), "Gooning".to_string()]);
        assert!(capped.contains("matches: 10000+"), "{capped}");
        assert!(capped.contains("top tags in results: Hypno, Gooning"), "{capped}");
        assert_eq!(format_count(9526, &[]), "matches: 9526\n");
    }
}
