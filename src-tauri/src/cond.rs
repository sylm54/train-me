//! Condition DSL for feature files — Rust mirror of `src/lib/cond.ts`.
//!
//! The executable semantics live in the TypeScript module (the session
//! runner and the manifest player evaluate conditions at runtime); this
//! module is what the validators use so a bad condition is caught at lint
//! time, before it can silently evaluate to `false` in a session.
//!
//! Grammar (same as the TS module):
//!
//! ```text
//! expr    := or
//! or      := and ("or" and)*
//! and     := not ("and" not)*
//! not     := "not" not | cmp
//! cmp     := sum (op sum | "in" list)?
//! sum     := term (("+" | "-") term)*
//! term    := unary (("*" | "/") unary)*
//! unary   := "-" unary | primary
//! primary := number | string | "true" | "false" | ident | "(" expr ")"
//! ```
//!
//! `parse` returns every identifier referenced, so callers can check
//! names against the reserved engine variables and the file's own answer
//! fields.

/// The engine-provided variable names (mirrored in `src/lib/cond.ts`).
pub const RESERVED_VARS: &[&str] = &[
    "weekday",
    "is_weekend",
    "hour",
    "date",
    "month",
    "streak",
    "best_streak",
    "done",
    "fails",
    "days_since_last",
    "points",
    "locked",
];

#[derive(Debug)]
pub struct Parsed {
    /// Every identifier referenced by the expression, in first-occurrence
    /// order, deduplicated.
    pub identifiers: Vec<String>,
}

struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
    identifiers: Vec<String>,
}

/// Parse a condition expression. `Err` carries a human-readable message.
pub fn parse(src: &str) -> Result<Parsed, String> {
    let mut p = Parser {
        src: src.as_bytes(),
        pos: 0,
        identifiers: Vec::new(),
    };
    p.or()?;
    p.skip_ws();
    if p.pos < p.src.len() {
        return Err(format!(
            "unexpected `{}` after expression",
            p.src[p.pos] as char
        ));
    }
    let mut identifiers = p.identifiers;
    // First-occurrence order with duplicates removed.
    let mut seen = std::collections::HashSet::new();
    identifiers.retain(|id| seen.insert(id.clone()));
    Ok(Parsed { identifiers })
}

impl<'a> Parser<'a> {
    fn fail(&self, msg: &str) -> String {
        format!("{msg} (at position {})", self.pos)
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() && (self.src[self.pos] as char).is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn eat(&mut self, s: &str) -> bool {
        self.skip_ws();
        if self.src[self.pos..].starts_with(s.as_bytes()) {
            self.pos += s.len();
            true
        } else {
            false
        }
    }

    /// Match a bare keyword (word boundary required so `orX` isn't `or`).
    fn word(&mut self, w: &str) -> bool {
        self.skip_ws();
        if !self.src[self.pos..].starts_with(w.as_bytes()) {
            return false;
        }
        match self.src.get(self.pos + w.len()) {
            None => {}
            Some(&after) => {
                let ident_cont = after.is_ascii_alphanumeric() || after == b'_';
                let quote = after == b'"' || after == b'\'';
                if ident_cont || quote {
                    return false;
                }
            }
        }
        self.pos += w.len();
        true
    }

    fn or(&mut self) -> Result<(), String> {
        self.and()?;
        while self.word("or") {
            self.and()?;
        }
        Ok(())
    }

    fn and(&mut self) -> Result<(), String> {
        self.not()?;
        while self.word("and") {
            self.not()?;
        }
        Ok(())
    }

    fn not(&mut self) -> Result<(), String> {
        if self.word("not") {
            return self.not();
        }
        self.cmp()
    }

    fn cmp(&mut self) -> Result<(), String> {
        self.sum()?;
        self.skip_ws();
        for op in ["==", "!=", "<=", ">="] {
            if self.eat(op) {
                return self.sum().map(|_| ());
            }
        }
        if self.eat("<") || self.eat(">") {
            return self.sum().map(|_| ());
        }
        if self.word("in") {
            return self.list();
        }
        Ok(())
    }

    fn list(&mut self) -> Result<(), String> {
        if !self.eat("[") {
            return Err(self.fail("expected `[` after `in`"));
        }
        self.skip_ws();
        if self.eat("]") {
            return Ok(());
        }
        loop {
            self.primary()?;
            self.skip_ws();
            if self.eat(",") {
                continue;
            }
            if self.eat("]") {
                return Ok(());
            }
            return Err(self.fail("expected `,` or `]` in list"));
        }
    }

    fn sum(&mut self) -> Result<(), String> {
        self.term()?;
        loop {
            self.skip_ws();
            if self.eat("+") || self.eat("-") {
                self.term()?;
            } else {
                return Ok(());
            }
        }
    }

    fn term(&mut self) -> Result<(), String> {
        self.unary()?;
        loop {
            self.skip_ws();
            if self.eat("*") || self.eat("/") {
                self.unary()?;
            } else {
                return Ok(());
            }
        }
    }

    fn unary(&mut self) -> Result<(), String> {
        self.skip_ws();
        if self.eat("-") {
            return self.unary();
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<(), String> {
        self.skip_ws();
        let Some(c) = self.peek() else {
            return Err(self.fail("unexpected end of expression"));
        };
        match c {
            b'(' => {
                self.pos += 1;
                self.or()?;
                self.skip_ws();
                if !self.eat(")") {
                    return Err(self.fail("expected `)`"));
                }
                Ok(())
            }
            b'"' | b'\'' => self.string(c),
            b'0'..=b'9' => self.number(),
            _ if c.is_ascii_alphabetic() || c == b'_' => {
                if self.word("true") || self.word("false") {
                    return Ok(());
                }
                let name = self.ident();
                if matches!(name.as_str(), "and" | "or" | "not" | "in") {
                    return Err(self.fail(&format!("unexpected keyword `{name}`")));
                }
                Ok(())
            }
            _ => Err(self.fail(&format!("unexpected character `{}`", c as char))),
        }
    }

    fn string(&mut self, quote: u8) -> Result<(), String> {
        self.pos += 1; // opening quote
        while let Some(&c) = self.src.get(self.pos) {
            if c == quote {
                self.pos += 1;
                return Ok(());
            }
            self.pos += 1;
        }
        Err(self.fail("unterminated string"))
    }

    fn number(&mut self) -> Result<(), String> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit() || c == b'.') {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.src[start..self.pos]).unwrap_or("");
        if text.parse::<f64>().is_err() {
            return Err(self.fail(&format!("invalid number `{text}`")));
        }
        Ok(())
    }

    fn ident(&mut self) -> String {
        let start = self.pos;
        self.pos += 1;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            self.pos += 1;
        }
        let name = String::from_utf8_lossy(&self.src[start..self.pos]).into_owned();
        self.identifiers.push(name.clone());
        name
    }
}

/// Identifiers referenced by `{{ var }}` placeholders in a text (for the
/// linter). Mirrors `interpolationIdents` in `src/lib/cond.ts`.
pub fn interpolation_idents(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(end) = text[i + 2..].find("}}") {
                let inner = text[i + 2..i + 2 + end].trim();
                let valid = !inner.is_empty()
                    && (inner.as_bytes()[0].is_ascii_alphabetic() || inner.as_bytes()[0] == b'_')
                    && inner
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_');
                if valid {
                    out.push(inner.to_string());
                }
                i += 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(src: &str) -> Vec<String> {
        parse(src).expect(src).identifiers
    }
    fn err(src: &str) -> String {
        parse(src).expect_err(src)
    }

    #[test]
    fn valid_expressions_parse() {
        assert_eq!(ok("weekday == \"sunday\""), vec!["weekday"]);
        assert_eq!(
            ok("streak >= 7 and energy != \"low\""),
            vec!["streak", "energy"]
        );
        assert_eq!(
            ok("done == 0 or days_since_last >= 3"),
            vec!["done", "days_since_last"]
        );
        assert_eq!(ok("not (is_weekend) and points >= 50").len(), 2);
        assert_eq!(ok("energy in [\"low\", \"ok\"]"), vec!["energy"]);
        assert_eq!(ok("hour + 2 > 10 * (1 + 1)"), vec!["hour"]);
        assert!(ok("true or false").is_empty());
        assert_eq!(ok("locked and not is_weekend"), vec!["locked", "is_weekend"]);
        assert_eq!(ok("-streak < 0"), vec!["streak"]);
        assert_eq!(ok("streak"), vec!["streak"]);
        // Keyword boundaries: `orX` is one identifier, `in["a"]` still parses.
        assert_eq!(ok("orX == 1"), vec!["orX"]);
        assert!(parse("x in[\"a\"]").is_ok());
        // Duplicate identifiers are reported once.
        assert_eq!(ok("streak > 1 and streak < 5"), vec!["streak"]);
    }

    #[test]
    fn invalid_expressions_fail() {
        assert!(err("weekday ==").contains("unexpected end"));
        assert!(err("streak >= ").contains("unexpected end"));
        assert!(err("== 5").contains("unexpected character"));
        assert!(err("x in a").contains("expected `[`"));
        assert!(err("x in [\"a\",]").contains("unexpected character"));
        assert!(err("streak > 7 )").contains("unexpected"));
        assert!(err("'unterminated").contains("unterminated"));
        assert!(err("1..2").contains("invalid number"));
        assert!(err("and").contains("unexpected keyword"));
        assert!(err("(streak").contains("expected `)`"));
    }
}
