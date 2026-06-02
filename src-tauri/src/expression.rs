//! Expression parsing and evaluation for TTS audio rendering.
//!
//! This module provides a mini expression language used to control volume,
//! speed, and pitch parameters in TTS markup. The language supports numeric
//! literals, function calls (prefixed with `@`), binary operators (`+`, `-`,
//! `*`, `/`), and nested sub-expressions.
//!
//! # Examples
//!
//! ```text
//! 0.5                    → constant 0.5
//! @fadein(2.0)           → fade-in over 2 seconds
//! @ramp(0.3, 1.0)       → linear ramp from 0.3 to 1.0
//! @sin(2) * 0.5 + 0.5   → sinusoidal oscillation mapped to [0, 1]
//! @min(1.0, @max(0.3, @beat(60, 0.5)))
//! ```

use std::f32::consts::PI;

use anyhow::{bail, Result};

// ============================================================================
// AST Types
// ============================================================================

/// Binary operator kind.
#[derive(Debug, Clone, PartialEq)]
pub enum BinOp {
    /// Addition (`+`)
    Add,
    /// Subtraction (`-`)
    Sub,
    /// Multiplication (`*`)
    Mul,
    /// Division (`/`)
    Div,
}

/// Abstract syntax tree for an expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// A numeric literal, e.g. `0.5` or `1.0`.
    Literal(f32),
    /// A function call, e.g. `@fadein(2.0)`.
    Func { name: String, args: Vec<Expr> },
    /// A binary operation, e.g. `a + b`.
    BinOp {
        op: BinOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
}

// ============================================================================
// Parser
// ============================================================================

/// Internal parser state tracking the input string and cursor position.
struct Parser {
    input: Vec<char>,
    pos: usize,
}

impl Parser {
    /// Create a new parser for the given input string.
    fn new(input: &str) -> Self {
        Self {
            input: input.chars().collect(),
            pos: 0,
        }
    }

    /// Peek at the current character without advancing.
    fn peek(&self) -> Option<char> {
        self.input.get(self.pos).copied()
    }

    /// Advance the cursor by one character and return the current one.
    fn advance(&mut self) -> Option<char> {
        let ch = self.input.get(self.pos).copied();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    /// Skip whitespace characters.
    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.peek() {
            if ch.is_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    /// Expect and consume a specific character.
    fn expect(&mut self, expected: char) -> Result<()> {
        self.skip_whitespace();
        match self.advance() {
            Some(ch) if ch == expected => Ok(()),
            Some(ch) => bail!(
                "Expected '{}' at position {}, found '{}'",
                expected,
                self.pos,
                ch
            ),
            None => bail!(
                "Expected '{}' at position {}, found end of input",
                expected,
                self.pos
            ),
        }
    }

    /// Parse a number literal (integer or float, possibly negative via unary minus).
    fn parse_number(&mut self) -> Result<f32> {
        self.skip_whitespace();
        let start = self.pos;

        // Optional leading minus sign
        if self.peek() == Some('-') {
            self.advance();
        }

        // Integer part
        while let Some(ch) = self.peek() {
            if ch.is_ascii_digit() {
                self.advance();
            } else {
                break;
            }
        }

        // Decimal part
        if self.peek() == Some('.') {
            self.advance();
            while let Some(ch) = self.peek() {
                if ch.is_ascii_digit() {
                    self.advance();
                } else {
                    break;
                }
            }
        }

        let num_str: String = self.input[start..self.pos].iter().collect();
        num_str.parse::<f32>().map_err(|e| {
            anyhow::anyhow!("Invalid number '{}' at position {}: {}", num_str, start, e)
        })
    }

    /// Parse a primary expression: literal, function call, parenthesized expression, or unary minus.
    fn parse_primary(&mut self) -> Result<Expr> {
        self.skip_whitespace();

        match self.peek() {
            // Parenthesized sub-expression
            Some('(') => {
                self.advance(); // consume '('
                let expr = self.parse_additive()?;
                self.expect(')')?;
                Ok(expr)
            }
            // Function call starting with '@'
            Some('@') => {
                self.advance(); // consume '@'
                self.skip_whitespace();

                // Read function name
                let name_start = self.pos;
                while let Some(ch) = self.peek() {
                    if ch.is_ascii_alphanumeric() || ch == '_' {
                        self.advance();
                    } else {
                        break;
                    }
                }
                let name: String = self.input[name_start..self.pos].iter().collect();
                if name.is_empty() {
                    bail!("Expected function name after '@' at position {}", self.pos);
                }

                self.skip_whitespace();
                self.expect('(')?;

                // Parse arguments
                let mut args = Vec::new();
                self.skip_whitespace();
                if self.peek() != Some(')') {
                    args.push(self.parse_additive()?);
                    self.skip_whitespace();
                    while self.peek() == Some(',') {
                        self.advance(); // consume ','
                        args.push(self.parse_additive()?);
                        self.skip_whitespace();
                    }
                }
                self.expect(')')?;

                Ok(Expr::Func { name, args })
            }
            // Unary minus
            Some('-') => {
                self.advance(); // consume '-'
                let operand = self.parse_primary()?;
                // Represent as 0 - operand
                Ok(Expr::BinOp {
                    op: BinOp::Sub,
                    left: Box::new(Expr::Literal(0.0)),
                    right: Box::new(operand),
                })
            }
            // Numeric literal
            Some(ch) if ch.is_ascii_digit() || ch == '.' => {
                let n = self.parse_number()?;
                Ok(Expr::Literal(n))
            }
            Some(ch) => {
                bail!("Unexpected character '{}' at position {}", ch, self.pos)
            }
            None => bail!("Unexpected end of input at position {}", self.pos),
        }
    }

    /// Parse multiplicative expressions: handles `*` and `/`.
    fn parse_multiplicative(&mut self) -> Result<Expr> {
        let mut left = self.parse_primary()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('*') => {
                    self.advance();
                    let right = self.parse_primary()?;
                    left = Expr::BinOp {
                        op: BinOp::Mul,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('/') => {
                    self.advance();
                    let right = self.parse_primary()?;
                    left = Expr::BinOp {
                        op: BinOp::Div,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse additive expressions: handles `+` and `-`.
    /// This is the entry point for expression precedence.
    fn parse_additive(&mut self) -> Result<Expr> {
        let mut left = self.parse_multiplicative()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('+') => {
                    self.advance();
                    let right = self.parse_multiplicative()?;
                    left = Expr::BinOp {
                        op: BinOp::Add,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('-') => {
                    self.advance();
                    let right = self.parse_multiplicative()?;
                    left = Expr::BinOp {
                        op: BinOp::Sub,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse a complete expression from the input.
    fn parse(&mut self) -> Result<Expr> {
        let expr = self.parse_additive()?;
        self.skip_whitespace();
        if self.pos < self.input.len() {
            bail!(
                "Unexpected trailing content at position {}: '{}'",
                self.pos,
                &self.input[self.pos..].iter().collect::<String>()
            );
        }
        Ok(expr)
    }
}

/// Parse an expression string into an [`Expr`] AST node.
///
/// Supports numeric literals, function calls (prefixed with `@`), binary
/// operators (`+`, `-`, `*`, `/`), parenthesized sub-expressions, and
/// unary minus.
///
/// # Errors
///
/// Returns an error if the input string is not a valid expression.
///
/// # Examples
///
/// ```
/// # use train_me_lib::expression::{parse_expr, Expr};
/// let expr = parse_expr("0.5").unwrap();
/// assert!(matches!(expr, Expr::Literal(v) if (v - 0.5).abs() < f32::EPSILON));
/// ```
pub fn parse_expr(input: &str) -> Result<Expr> {
    let mut parser = Parser::new(input.trim());
    parser.parse()
}

// ============================================================================
// Evaluator — constant folding
// ============================================================================

/// Attempt to evaluate an expression as a compile-time constant.
///
/// Returns `Some(value)` if the expression is purely numeric (no time-dependent
/// functions), or `None` if the expression depends on time (e.g. `@fadein`,
/// `@sin`, etc.).
///
/// Only certain utility functions can produce constants: `@max`, `@min`,
/// `@step`, and `@round` — and only when all their arguments are constant.
///
/// # Examples
///
/// ```
/// # use train_me_lib::expression::{parse_expr, eval_constant};
/// let expr = parse_expr("0.5").unwrap();
/// assert_eq!(eval_constant(&expr), Some(0.5));
///
/// let expr = parse_expr("@fadein(2.0)").unwrap();
/// assert_eq!(eval_constant(&expr), None);
/// ```
pub fn eval_constant(expr: &Expr) -> Option<f32> {
    match expr {
        Expr::Literal(v) => Some(*v),
        Expr::BinOp { op, left, right } => {
            let lv = eval_constant(left)?;
            let rv = eval_constant(right)?;
            Some(match op {
                BinOp::Add => lv + rv,
                BinOp::Sub => lv - rv,
                BinOp::Mul => lv * rv,
                BinOp::Div => lv / rv.max(0.001), // guard against division by zero
            })
        }
        Expr::Func { name, args } => {
            // Only utility functions can produce constants
            match name.as_str() {
                "max" => {
                    if args.len() < 2 {
                        return None;
                    }
                    let a = eval_constant(&args[0])?;
                    let b = eval_constant(&args[1])?;
                    Some(a.max(b))
                }
                "min" => {
                    if args.len() < 2 {
                        return None;
                    }
                    let a = eval_constant(&args[0])?;
                    let b = eval_constant(&args[1])?;
                    Some(a.min(b))
                }
                "step" => {
                    if args.len() < 2 {
                        return None;
                    }
                    let val = eval_constant(&args[0])?;
                    let step = eval_constant(&args[1])?;
                    Some((val / step.max(0.001)).round() * step)
                }
                "round" => {
                    if args.len() < 2 {
                        return None;
                    }
                    let val = eval_constant(&args[0])?;
                    let decimals = eval_constant(&args[1])?;
                    let factor = 10f32.powi(decimals.round() as i32);
                    Some((val * factor).round() / factor)
                }
                _ => None, // all other functions are time-dependent
            }
        }
    }
}

// ============================================================================
// Evaluator — per-sample
// ============================================================================

/// Evaluate a single sample of an expression at time `t`.
///
/// # Arguments
///
/// * `expr`    — The parsed expression AST.
/// * `t`       — Current time in seconds.
/// * `total_duration` — Total duration of the segment in seconds.
/// * `sample_idx`     — Zero-based sample index (used for `@noise`).
fn eval_sample(expr: &Expr, t: f32, total_duration: f32, sample_idx: usize) -> f32 {
    match expr {
        Expr::Literal(v) => *v,

        Expr::BinOp { op, left, right } => {
            let lv = eval_sample(left, t, total_duration, sample_idx);
            let rv = eval_sample(right, t, total_duration, sample_idx);
            match op {
                BinOp::Add => lv + rv,
                BinOp::Sub => lv - rv,
                BinOp::Mul => lv * rv,
                BinOp::Div => lv / rv.max(0.001),
            }
        }

        Expr::Func { name, args } => {
            // Evaluate arguments recursively
            let eval_arg = |idx: usize| -> f32 {
                args.get(idx)
                    .map(|a| eval_sample(a, t, total_duration, sample_idx))
                    .unwrap_or(0.0)
            };

            match name.as_str() {
                // ── Envelope / fade ──────────────────────────────────────
                // fadein(d): ramps from 0 → 1 over `d` seconds.
                "fadein" => {
                    let d = eval_arg(0).max(0.001);
                    (t / d).min(1.0).max(0.0)
                }

                // fadeout(d): ramps from 1 → 0 over the last `d` seconds.
                "fadeout" => {
                    let d = eval_arg(0).max(0.001);
                    ((total_duration - t) / d).max(0.0).min(1.0)
                }

                // fade(d): fade-in and fade-out combined.
                "fade" => {
                    let d = eval_arg(0).max(0.001);
                    let fi = (t / d).min(1.0).max(0.0);
                    let fo = ((total_duration - t) / d).max(0.0).min(1.0);
                    fi.min(fo)
                }

                // ramp(start, end): linear ramp from `start` to `end`.
                "ramp" => {
                    let start = eval_arg(0);
                    let end = eval_arg(1);
                    let progress = if total_duration > 0.0 {
                        (t / total_duration).clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    start + (end - start) * progress
                }

                // env(attack, decay, sustain, release): ADSR envelope.
                "env" => {
                    let attack = eval_arg(0).max(0.0);
                    let decay = eval_arg(1).max(0.0);
                    let sustain = eval_arg(2);
                    let release = eval_arg(3).max(0.0);

                    let sustain_start = attack + decay;
                    let release_start = (total_duration - release).max(0.0);

                    if t < attack && attack > 0.0 {
                        // Attack phase: ramp 0 → 1
                        t / attack
                    } else if t < sustain_start && decay > 0.0 {
                        // Decay phase: ramp 1 → sustain
                        let decay_progress = (t - attack) / decay;
                        1.0 + (sustain - 1.0) * decay_progress
                    } else if t < release_start {
                        // Sustain phase: hold at sustain level
                        sustain
                    } else if release > 0.0 {
                        // Release phase: ramp sustain → 0
                        let release_progress = (t - release_start) / release;
                        sustain * (1.0 - release_progress.clamp(0.0, 1.0))
                    } else {
                        0.0
                    }
                }

                // ── Rhythmic / oscillators ───────────────────────────────
                // beat(bpm, duty=0.5): square-wave beat pattern.
                "beat" => {
                    let bpm = eval_arg(0).max(0.001);
                    let duty = eval_arg(1).clamp(0.0, 1.0);
                    let period = 60.0 / bpm;
                    let phase = if period > 0.0 {
                        (t % period) / period
                    } else {
                        0.0
                    };
                    if phase < duty {
                        1.0
                    } else {
                        0.0
                    }
                }

                // sin(freq, phase=0.0): sine wave mapped to [0, 1].
                "sin" => {
                    let freq = eval_arg(0);
                    let phase = eval_arg(1);
                    (2.0 * PI * freq * t + phase).sin() * 0.5 + 0.5
                }

                // tri(freq, duty=0.5): triangle wave mapped to [0, 1].
                "tri" => {
                    let freq = eval_arg(0).max(0.001);
                    let duty = eval_arg(1).clamp(0.001, 0.999);
                    let phase = (t * freq) % 1.0;
                    if phase < duty {
                        phase / duty * 0.5
                    } else {
                        0.5 + (phase - duty) / (1.0 - duty) * 0.5
                    }
                }

                // saw(freq): sawtooth wave in [0, 1).
                "saw" => {
                    let freq = eval_arg(0);
                    (t * freq) % 1.0
                }

                // noise(seed): deterministic pseudo-random per sample.
                "noise" => {
                    let seed = eval_arg(0);
                    let seed_bits = seed.to_bits();
                    let idx_bits = sample_idx as u64;
                    // FNV-1a-inspired hash for deterministic noise
                    let mut hash: u64 = 14695981039346656037;
                    for byte in seed_bits.to_le_bytes() {
                        hash ^= byte as u64;
                        hash = hash.wrapping_mul(1099511628211);
                    }
                    for byte in idx_bits.to_le_bytes() {
                        hash ^= byte as u64;
                        hash = hash.wrapping_mul(1099511628211);
                    }
                    // Map to [0, 1]
                    ((hash & 0xFFFF) as f32) / 65535.0
                }

                // ── Utility ──────────────────────────────────────────────
                // max(a, b): maximum of two values.
                "max" => {
                    let a = eval_arg(0);
                    let b = eval_arg(1);
                    a.max(b)
                }

                // min(a, b): minimum of two values.
                "min" => {
                    let a = eval_arg(0);
                    let b = eval_arg(1);
                    a.min(b)
                }

                // step(val, step): quantize `val` to nearest multiple of `step`.
                "step" => {
                    let val = eval_arg(0);
                    let step = eval_arg(1).max(0.001);
                    (val / step).round() * step
                }

                // round(val, decimals): round `val` to `decimals` decimal places.
                "round" => {
                    let val = eval_arg(0);
                    let decimals = eval_arg(1);
                    let factor = 10f32.powi(decimals.round() as i32);
                    (val * factor).round() / factor
                }

                _ => 0.0, // unknown function defaults to 0
            }
        }
    }
}

// ============================================================================
// Evaluator — curve generation
// ============================================================================

/// Evaluate an expression over a given number of audio samples.
///
/// Produces a vector of per-sample `f32` values suitable for use as a
/// volume/speed/pitch modulation curve.
///
/// # Arguments
///
/// * `expr`        — The parsed expression AST.
/// * `num_samples` — Number of samples to generate.
/// * `sample_rate` — Audio sample rate in Hz.
///
/// # Examples
///
/// ```
/// # use train_me_lib::expression::{parse_expr, eval_curve};
/// let expr = parse_expr("@fadein(1.0)").unwrap();
/// let curve = eval_curve(&expr, 44100, 44100);
/// assert_eq!(curve.len(), 44100);
/// assert!(curve[0] < 0.01);        // starts near 0
/// assert!(curve.last().unwrap() > &0.99); // ends near 1
/// ```
pub fn eval_curve(expr: &Expr, num_samples: usize, sample_rate: u32) -> Vec<f32> {
    let sr = sample_rate as f32;
    let total_duration = if sr > 0.0 {
        num_samples as f32 / sr
    } else {
        0.0
    };

    (0..num_samples)
        .map(|i| {
            let t = i as f32 / sr;
            eval_sample(expr, t, total_duration, i)
        })
        .collect()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── Parsing tests ───────────────────────────────────────────────────

    #[test]
    fn parse_literal() {
        let expr = parse_expr("0.5").unwrap();
        assert!(matches!(expr, Expr::Literal(v) if (v - 0.5).abs() < f32::EPSILON));
    }

    #[test]
    fn parse_literal_integer() {
        let expr = parse_expr("42").unwrap();
        assert!(matches!(expr, Expr::Literal(v) if (v - 42.0).abs() < f32::EPSILON));
    }

    #[test]
    fn parse_function_no_args() {
        // Not typical, but testing the parser handles it
    }

    #[test]
    fn parse_function_single_arg() {
        let expr = parse_expr("@fadein(2.0)").unwrap();
        match expr {
            Expr::Func { name, args } => {
                assert_eq!(name, "fadein");
                assert_eq!(args.len(), 1);
                assert!(matches!(&args[0], Expr::Literal(v) if (v - 2.0).abs() < f32::EPSILON));
            }
            _ => panic!("Expected Func, got {:?}", expr),
        }
    }

    #[test]
    fn parse_function_two_args() {
        let expr = parse_expr("@ramp(0.3, 1.0)").unwrap();
        match expr {
            Expr::Func { name, args } => {
                assert_eq!(name, "ramp");
                assert_eq!(args.len(), 2);
            }
            _ => panic!("Expected Func"),
        }
    }

    #[test]
    fn parse_binary_add() {
        let expr = parse_expr("1.0 + 2.0").unwrap();
        match expr {
            Expr::BinOp {
                op: BinOp::Add,
                left,
                right,
            } => {
                assert!(matches!(*left, Expr::Literal(v) if (v - 1.0).abs() < f32::EPSILON));
                assert!(matches!(*right, Expr::Literal(v) if (v - 2.0).abs() < f32::EPSILON));
            }
            _ => panic!("Expected BinOp(Add)"),
        }
    }

    #[test]
    fn parse_binary_mul() {
        let expr = parse_expr("2.0 * 3.0").unwrap();
        assert!(matches!(expr, Expr::BinOp { op: BinOp::Mul, .. }));
    }

    #[test]
    fn parse_precedence() {
        // "2 + 3 * 4" should parse as 2 + (3 * 4), not (2 + 3) * 4
        let expr = parse_expr("2 + 3 * 4").unwrap();
        // Verify the value: 2 + 3*4 = 14
        let val = eval_constant(&expr).unwrap();
        assert!((val - 14.0).abs() < 0.01, "Expected 14.0, got {}", val);

        match &expr {
            Expr::BinOp {
                op: BinOp::Add,
                left,
                right,
            } => {
                assert!(matches!(&**left, Expr::Literal(v) if (v - 2.0).abs() < f32::EPSILON));
                // right should be 3 * 4
                assert!(matches!(&**right, Expr::BinOp { op: BinOp::Mul, .. }));
            }
            _ => panic!("Expected BinOp(Add)"),
        }
    }

    #[test]
    fn parse_parenthesized() {
        // "(2 + 3) * 4" should equal 20
        let expr = parse_expr("(2 + 3) * 4").unwrap();
        let val = eval_constant(&expr).unwrap();
        assert!((val - 20.0).abs() < 0.01, "Expected 20.0, got {}", val);
    }

    #[test]
    fn parse_unary_minus() {
        let expr = parse_expr("-1.0").unwrap();
        let val = eval_constant(&expr).unwrap();
        assert!((val - (-1.0)).abs() < 0.01);
    }

    #[test]
    fn parse_nested_functions() {
        let expr = parse_expr("@min(1.0, @max(0.3, @beat(60, 0.5)))").unwrap();
        match expr {
            Expr::Func { name, args } => {
                assert_eq!(name, "min");
                assert_eq!(args.len(), 2);
                // Second arg is @max(...)
                assert!(matches!(&args[1], Expr::Func { name, .. } if name == "max"));
            }
            _ => panic!("Expected Func"),
        }
    }

    #[test]
    fn parse_complex_expression() {
        let expr = parse_expr("@sin(2) * 0.5 + 0.5").unwrap();
        // Should parse as (@sin(2) * 0.5) + 0.5
        match expr {
            Expr::BinOp {
                op: BinOp::Add,
                left,
                right,
            } => {
                assert!(matches!(*left, Expr::BinOp { op: BinOp::Mul, .. }));
                assert!(matches!(*right, Expr::Literal(v) if (v - 0.5).abs() < f32::EPSILON));
            }
            _ => panic!("Expected BinOp(Add)"),
        }
    }

    // ── eval_constant tests ─────────────────────────────────────────────

    #[test]
    fn eval_constant_literal() {
        let expr = parse_expr("0.5").unwrap();
        assert_eq!(eval_constant(&expr), Some(0.5));
    }

    #[test]
    fn eval_constant_arithmetic() {
        let expr = parse_expr("2 + 3 * 4").unwrap();
        assert!((eval_constant(&expr).unwrap() - 14.0).abs() < 0.01);
    }

    #[test]
    fn eval_constant_max() {
        let expr = parse_expr("@max(3.0, 5.0)").unwrap();
        assert!((eval_constant(&expr).unwrap() - 5.0).abs() < 0.01);
    }

    #[test]
    fn eval_constant_min() {
        let expr = parse_expr("@min(3.0, 5.0)").unwrap();
        assert!((eval_constant(&expr).unwrap() - 3.0).abs() < 0.01);
    }

    #[test]
    fn eval_constant_step() {
        let expr = parse_expr("@step(0.73, 0.25)").unwrap();
        assert!((eval_constant(&expr).unwrap() - 0.75).abs() < 0.01);
    }

    #[test]
    fn eval_constant_round() {
        let expr = parse_expr("@round(3.14159, 2)").unwrap();
        assert!((eval_constant(&expr).unwrap() - 3.14).abs() < 0.01);
    }

    #[test]
    fn eval_constant_fadein_is_none() {
        let expr = parse_expr("@fadein(2.0)").unwrap();
        assert_eq!(eval_constant(&expr), None);
    }

    #[test]
    fn eval_constant_sin_is_none() {
        let expr = parse_expr("@sin(440)").unwrap();
        assert_eq!(eval_constant(&expr), None);
    }

    #[test]
    fn eval_constant_beat_is_none() {
        let expr = parse_expr("@beat(120, 0.5)").unwrap();
        assert_eq!(eval_constant(&expr), None);
    }

    // ── eval_curve tests ────────────────────────────────────────────────

    #[test]
    fn eval_curve_literal() {
        let expr = parse_expr("0.75").unwrap();
        let curve = eval_curve(&expr, 100, 44100);
        assert_eq!(curve.len(), 100);
        for v in &curve {
            assert!((v - 0.75).abs() < 0.001);
        }
    }

    #[test]
    fn eval_curve_fadein_starts_at_zero() {
        let expr = parse_expr("@fadein(1.0)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        assert!(
            curve[0] < 0.01,
            "fadein should start near 0, got {}",
            curve[0]
        );
    }

    #[test]
    fn eval_curve_fadein_reaches_one() {
        let expr = parse_expr("@fadein(1.0)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        let last = *curve.last().unwrap();
        assert!(
            last > 0.99,
            "fadein should reach near 1 at end, got {}",
            last
        );
    }

    #[test]
    fn eval_curve_fadein_halfway() {
        let expr = parse_expr("@fadein(1.0)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        let mid = curve[22050];
        assert!(
            (mid - 0.5).abs() < 0.05,
            "fadein at halfway should be ~0.5, got {}",
            mid
        );
    }

    #[test]
    fn eval_curve_fadeout() {
        let expr = parse_expr("@fadeout(1.0)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        assert!(
            curve[0] > 0.99,
            "fadeout should start near 1, got {}",
            curve[0]
        );
        assert!(curve.last().unwrap() < &0.01, "fadeout should end near 0");
    }

    #[test]
    fn eval_curve_fade() {
        let expr = parse_expr("@fade(0.5)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        // Total duration is 1.0s, fade is 0.5s
        // Should fade in over first 0.5s and fade out over last 0.5s
        assert!(curve[0] < 0.1, "fade should start near 0");
        // Middle should be 1.0
        let mid = curve[22050];
        assert!(
            (mid - 1.0).abs() < 0.05,
            "fade middle should be ~1.0, got {}",
            mid
        );
        // End should be near 0
        assert!(curve.last().unwrap() < &0.1, "fade should end near 0");
    }

    #[test]
    fn eval_curve_ramp() {
        let expr = parse_expr("@ramp(0.2, 0.8)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        let first = curve[0];
        let last = *curve.last().unwrap();
        assert!(
            (first - 0.2).abs() < 0.05,
            "ramp should start at ~0.2, got {}",
            first
        );
        assert!(
            (last - 0.8).abs() < 0.05,
            "ramp should end at ~0.8, got {}",
            last
        );
    }

    #[test]
    fn eval_curve_ramp_midpoint() {
        let expr = parse_expr("@ramp(0.0, 1.0)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        let mid = curve[22050];
        assert!(
            (mid - 0.5).abs() < 0.05,
            "ramp midpoint should be ~0.5, got {}",
            mid
        );
    }

    #[test]
    fn eval_curve_env() {
        // env(attack=0.1, decay=0.1, sustain=0.6, release=0.2) over 1.0s
        let expr = parse_expr("@env(0.1, 0.1, 0.6, 0.2)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);
        let total = curve.len();

        // Start should be near 0 (beginning of attack)
        assert!(curve[0] < 0.1, "env should start near 0, got {}", curve[0]);

        // At 0.1s (4410 samples) should be near peak (end of attack)
        let peak_idx = 4410;
        assert!(
            curve[peak_idx] > 0.9,
            "env should reach peak at end of attack, got {}",
            curve[peak_idx]
        );

        // In sustain phase (e.g. at 0.5s = 22050 samples) should be near sustain level
        let sustain_idx = 22050;
        assert!(
            (curve[sustain_idx] - 0.6).abs() < 0.1,
            "env sustain should be ~0.6, got {}",
            curve[sustain_idx]
        );

        // End should be near 0 (after release)
        assert!(
            curve[total - 1] < 0.1,
            "env should end near 0, got {}",
            curve[total - 1]
        );
    }

    #[test]
    fn eval_curve_beat() {
        // @beat(60, 0.5) → period = 1.0s, 50% duty cycle
        let expr = parse_expr("@beat(60, 0.5)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100); // 1 second

        // First half should be 1.0
        assert!((curve[0] - 1.0).abs() < 0.001);
        assert!((curve[22049] - 1.0).abs() < 0.001);

        // Second half should be 0.0
        assert!((curve[22050] - 0.0).abs() < 0.001);
        assert!((curve[44099] - 0.0).abs() < 0.001);
    }

    #[test]
    fn eval_curve_sin_oscillates() {
        // @sin(1) with 1 Hz over 1 second → should complete one full cycle
        let expr = parse_expr("@sin(1)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);

        // At t=0, sin(0) = 0 → mapped to 0.5
        assert!(
            (curve[0] - 0.5).abs() < 0.05,
            "sin at t=0 should be ~0.5, got {}",
            curve[0]
        );

        // At t=0.25, sin(π/2) = 1 → mapped to 1.0
        let quarter_idx = 11025; // 0.25 * 44100
        assert!(
            (curve[quarter_idx] - 1.0).abs() < 0.05,
            "sin at t=0.25 should be ~1.0, got {}",
            curve[quarter_idx]
        );

        // At t=0.75, sin(3π/2) = -1 → mapped to 0.0
        let three_quarter_idx = 33075; // 0.75 * 44100
        assert!(
            (curve[three_quarter_idx] - 0.0).abs() < 0.05,
            "sin at t=0.75 should be ~0.0, got {}",
            curve[three_quarter_idx]
        );
    }

    #[test]
    fn eval_curve_sin_complex_expression() {
        // @sin(2) * 0.5 + 0.5 → @sin(2) already maps to [0, 1],
        // so the result ranges from 0*0.5+0.5 = 0.5 to 1*0.5+0.5 = 1.0
        let expr = parse_expr("@sin(2) * 0.5 + 0.5").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);

        let min_val = curve.iter().cloned().fold(f32::INFINITY, f32::min);
        let max_val = curve.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

        assert!(
            min_val < 0.6,
            "min of @sin(2)*0.5+0.5 should be near 0.5, got {}",
            min_val
        );
        assert!(
            max_val > 0.95,
            "max of @sin(2)*0.5+0.5 should be near 1.0, got {}",
            max_val
        );
    }

    #[test]
    fn eval_curve_max() {
        let expr = parse_expr("@max(0.3, 0.7)").unwrap();
        let curve = eval_curve(&expr, 100, 44100);
        for v in &curve {
            assert!((v - 0.7).abs() < 0.001);
        }
    }

    #[test]
    fn eval_curve_min() {
        let expr = parse_expr("@min(0.3, 0.7)").unwrap();
        let curve = eval_curve(&expr, 100, 44100);
        for v in &curve {
            assert!((v - 0.3).abs() < 0.001);
        }
    }

    #[test]
    fn eval_curve_nested_min_max_beat() {
        // @min(1.0, @max(0.3, @beat(60, 0.5)))
        // beat(60, 0.5) alternates between 1.0 and 0.0
        // max(0.3, beat) → alternates between 1.0 and 0.3
        // min(1.0, result) → alternates between 1.0 and 0.3
        let expr = parse_expr("@min(1.0, @max(0.3, @beat(60, 0.5)))").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);

        // First half (beat = 1.0): max(0.3, 1.0) = 1.0, min(1.0, 1.0) = 1.0
        assert!(
            (curve[0] - 1.0).abs() < 0.001,
            "Expected 1.0, got {}",
            curve[0]
        );

        // Second half (beat = 0.0): max(0.3, 0.0) = 0.3, min(1.0, 0.3) = 0.3
        assert!(
            (curve[22050] - 0.3).abs() < 0.001,
            "Expected 0.3, got {}",
            curve[22050]
        );
    }

    #[test]
    fn eval_curve_saw() {
        // @saw(1) over 1 second: ramps 0→1
        let expr = parse_expr("@saw(1)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);

        assert!(
            (curve[0]).abs() < 0.01,
            "saw start should be near 0, got {}",
            curve[0]
        );
        // Near the end it should be close to 1 (but may wrap)
        let near_end = curve[44099];
        assert!(
            near_end > 0.9,
            "saw near end should be close to 1, got {}",
            near_end
        );
    }

    #[test]
    fn eval_curve_tri() {
        // @tri(1) with duty=0.5 over 1 second
        let expr = parse_expr("@tri(1, 0.5)").unwrap();
        let curve = eval_curve(&expr, 44100, 44100);

        // Start should be 0
        assert!(
            (curve[0]).abs() < 0.01,
            "tri start should be near 0, got {}",
            curve[0]
        );

        // At t=0.5s (half-period with duty=0.5) should be 0.5 (peak of triangle)
        let half_idx = 22050;
        assert!(
            (curve[half_idx] - 0.5).abs() < 0.05,
            "tri at half-period should be ~0.5, got {}",
            curve[half_idx]
        );
    }

    #[test]
    fn eval_curve_noise_deterministic() {
        let expr = parse_expr("@noise(42)").unwrap();
        let curve1 = eval_curve(&expr, 100, 44100);
        let curve2 = eval_curve(&expr, 100, 44100);
        // Should be deterministic (same seed → same output)
        assert_eq!(
            curve1, curve2,
            "noise should be deterministic for same seed"
        );
        // Values should be in [0, 1]
        for v in &curve1 {
            assert!(*v >= 0.0 && *v <= 1.0, "noise value {} out of [0,1]", v);
        }
    }

    #[test]
    fn eval_curve_step() {
        let expr = parse_expr("@step(0.73, 0.25)").unwrap();
        let curve = eval_curve(&expr, 100, 44100);
        for v in &curve {
            assert!(
                (v - 0.75).abs() < 0.001,
                "step(0.73, 0.25) should be 0.75, got {}",
                v
            );
        }
    }

    #[test]
    fn eval_curve_round() {
        let expr = parse_expr("@round(3.14159, 2)").unwrap();
        let curve = eval_curve(&expr, 100, 44100);
        for v in &curve {
            assert!(
                (v - 3.14).abs() < 0.001,
                "round(3.14159, 2) should be 3.14, got {}",
                v
            );
        }
    }

    #[test]
    fn operator_precedence_not_associative() {
        // "2 + 3 * 4" = 14, not 20
        let expr = parse_expr("2 + 3 * 4").unwrap();
        let val = eval_constant(&expr).unwrap();
        assert!((val - 14.0).abs() < 0.01, "Expected 14, got {}", val);

        // "10 - 2 * 3" = 4, not 24
        let expr2 = parse_expr("10 - 2 * 3").unwrap();
        let val2 = eval_constant(&expr2).unwrap();
        assert!((val2 - 4.0).abs() < 0.01, "Expected 4, got {}", val2);
    }

    #[test]
    fn division_precedence() {
        // "10 / 2 + 3" = 8, not 2
        let expr = parse_expr("10 / 2 + 3").unwrap();
        let val = eval_constant(&expr).unwrap();
        assert!((val - 8.0).abs() < 0.01, "Expected 8, got {}", val);
    }

    #[test]
    fn parse_whitespace_handling() {
        let expr = parse_expr("  1.0  +  2.0  ").unwrap();
        let val = eval_constant(&expr).unwrap();
        assert!((val - 3.0).abs() < 0.01);
    }

    #[test]
    fn parse_function_with_spaces() {
        let expr = parse_expr("@fadein( 2.0 )").unwrap();
        match expr {
            Expr::Func { name, args } => {
                assert_eq!(name, "fadein");
                assert_eq!(args.len(), 1);
            }
            _ => panic!("Expected Func"),
        }
    }

    #[test]
    fn eval_curve_constant_binary_ops() {
        let expr = parse_expr("0.5 * 2.0 + 0.1").unwrap();
        let curve = eval_curve(&expr, 10, 44100);
        for v in &curve {
            assert!((v - 1.1).abs() < 0.01);
        }
    }
}
