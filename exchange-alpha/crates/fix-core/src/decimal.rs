//! Exact decimal text, as FIX uses for prices, quantities and amounts.
//!
//! FIX sends `44=42.10`. Parsing that through a float is the first place a no-floats rule
//! can quietly break, so values are parsed into an integer count of `10^-scale` units:
//! `parse_scaled("42.10", 2)` is `4210` cents. Nothing is rounded. If the text carries more
//! precision than the scale can hold, that is an error, not a silent truncation.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecimalError(String);

impl fmt::Display for DecimalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DecimalError {}

/// Parses `text` into units of `10^-scale`.
///
/// Accepts an optional leading `-`, digits, and an optional fraction. Extra fraction digits
/// are allowed only if they are zeros: `"42.100"` at scale 2 is fine, `"42.105"` is not.
pub fn parse_scaled(text: &str, scale: u32) -> Result<i64, DecimalError> {
    let error = |why: &str| DecimalError(format!("{text:?} {why}"));

    let (negative, unsigned) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(error("is not a decimal number"));
    }
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(error("is not a decimal number"));
    }

    let scale = scale as usize;
    let (kept, extra) = fraction.split_at(fraction.len().min(scale));
    if extra.bytes().any(|b| b != b'0') {
        return Err(error("has more decimal places than are supported"));
    }

    let digits = format!("{whole}{kept:0<scale$}");
    let magnitude: i64 = digits.parse().map_err(|_| error("is out of range"))?;
    Ok(if negative { -magnitude } else { magnitude })
}

/// Formats units of `10^-scale` as decimal text with exactly `scale` places.
pub fn format_scaled(value: i64, scale: u32) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let magnitude = value.unsigned_abs();
    if scale == 0 {
        return format!("{sign}{magnitude}");
    }
    let divisor = 10u64.pow(scale);
    let scale = scale as usize;
    format!(
        "{sign}{}.{:0scale$}",
        magnitude / divisor,
        magnitude % divisor
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prices_into_cents_exactly() {
        let cases = [
            ("42.10", 4210),
            ("42.1", 4210),
            ("42", 4200),
            ("0.01", 1),
            ("0.29", 29),
            ("1000.00", 100_000),
            ("42.100", 4210),
            ("-0.08", -8),
        ];
        for (text, cents) in cases {
            assert_eq!(parse_scaled(text, 2), Ok(cents), "{text}");
        }
    }

    #[test]
    fn refuses_to_round() {
        assert!(parse_scaled("42.105", 2).is_err());
        assert!(parse_scaled("100.5", 0).is_err());
    }

    #[test]
    fn rejects_text_that_is_not_a_number() {
        for bad in ["", ".5", "4x", "1e3", "--1", "1.2.3", " 1"] {
            assert!(parse_scaled(bad, 2).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn whole_quantities_parse_at_scale_zero() {
        assert_eq!(parse_scaled("100", 0), Ok(100));
        assert_eq!(parse_scaled("100.0", 0), Ok(100));
    }

    #[test]
    fn formats_back_to_text() {
        assert_eq!(format_scaled(4210, 2), "42.10");
        assert_eq!(format_scaled(-8, 2), "-0.08");
        assert_eq!(format_scaled(421_050, 4), "42.1050");
        assert_eq!(format_scaled(100, 0), "100");
        for (text, scale) in [("42.10", 2), ("0.01", 2), ("1000.00", 2), ("-0.08", 2)] {
            assert_eq!(
                format_scaled(parse_scaled(text, scale).unwrap(), scale),
                text
            );
        }
    }
}
