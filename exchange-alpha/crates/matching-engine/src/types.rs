//! Value types the engine is built from.
//!
//! Prices and quantities are integer newtypes, so the compiler refuses to mix them up and a
//! float has nowhere to sneak in. A price is a count of cents; a quantity is whole shares.

use std::fmt;
use std::ops::{Add, AddAssign, Sub, SubAssign};

use serde::{Deserialize, Serialize};

/// A price in integer cents: `PriceCents(4210)` is $42.10.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PriceCents(pub i64);

impl PriceCents {
    /// Parses a dollar amount such as `"42.10"`, `"42.1"` or `"42"` into cents.
    ///
    /// Integer arithmetic only. Going through `f64` would turn `"0.29"` into 28.999... cents,
    /// which is exactly the class of bug this type exists to rule out.
    pub fn parse_dollars(text: &str) -> Result<Self, ParsePriceError> {
        let invalid = || ParsePriceError(text.to_string());

        let (whole, fraction) = match text.split_once('.') {
            Some((_, "")) => return Err(invalid()),
            Some((whole, fraction)) => (whole, fraction),
            None => (text, ""),
        };
        let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
        if whole.is_empty() || fraction.len() > 2 || !all_digits(whole) || !all_digits(fraction) {
            return Err(invalid());
        }

        let dollars: i64 = whole.parse().map_err(|_| invalid())?;
        // "42.1" means ten cents, not one: pad the fraction out to two digits.
        let cents: i64 = format!("{fraction:0<2}").parse().map_err(|_| invalid())?;
        dollars
            .checked_mul(100)
            .and_then(|c| c.checked_add(cents))
            .map(PriceCents)
            .ok_or_else(invalid)
    }
}

impl fmt::Display for PriceCents {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sign = if self.0 < 0 { "-" } else { "" };
        let cents = self.0.unsigned_abs();
        write!(f, "{sign}{}.{:02}", cents / 100, cents % 100)
    }
}

/// Returned when text is not a valid dollar price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsePriceError(pub String);

impl fmt::Display for ParsePriceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "not a valid price: {:?} (expected dollars like 42.10)",
            self.0
        )
    }
}

impl std::error::Error for ParsePriceError {}

/// A quantity of shares.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Qty(pub i64);

impl Qty {
    pub const ZERO: Qty = Qty(0);

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }
}

impl Add for Qty {
    type Output = Qty;
    fn add(self, other: Qty) -> Qty {
        Qty(self.0 + other.0)
    }
}

impl Sub for Qty {
    type Output = Qty;
    fn sub(self, other: Qty) -> Qty {
        Qty(self.0 - other.0)
    }
}

impl AddAssign for Qty {
    fn add_assign(&mut self, other: Qty) {
        self.0 += other.0;
    }
}

impl SubAssign for Qty {
    fn sub_assign(&mut self, other: Qty) {
        self.0 -= other.0;
    }
}

impl fmt::Display for Qty {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Engine-assigned order id. Monotonic, never reused. The gateway adds the venue prefix
/// (`ALPHA-17`) when it puts the id on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OrderId(pub u64);

impl fmt::Display for OrderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Engine-assigned trade id. Monotonic, never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TradeId(pub u64);

impl fmt::Display for TradeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        })
    }
}

/// How an order is priced.
///
/// The limit price lives inside the `Limit` variant, so "a limit order with no price" and "a
/// market order with a price" cannot be constructed at all. FIX can express both, so the
/// gateway rejects them before they ever reach the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderType {
    /// Trade at this price or better; whatever does not trade may rest in the book.
    Limit { price: PriceCents },
    /// Trade at whatever prices are available. Never rests.
    Market,
}

impl OrderType {
    pub fn limit_price(self) -> Option<PriceCents> {
        match self {
            OrderType::Limit { price } => Some(price),
            OrderType::Market => None,
        }
    }
}

/// What happens to the part of an order that does not trade immediately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimeInForce {
    /// Rests until the business day closes (an `EndOfDay` command), then expires.
    Day,
    /// Good till cancelled: rests until it fills or is cancelled.
    Gtc,
    /// Immediate or cancel: trade what you can now, cancel the rest.
    Ioc,
    /// Fill or kill: trade the whole quantity now, or nothing at all.
    Fok,
}

impl fmt::Display for TimeInForce {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TimeInForce::Day => "DAY",
            TimeInForce::Gtc => "GTC",
            TimeInForce::Ioc => "IOC",
            TimeInForce::Fok => "FOK",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dollar_prices_without_floats() {
        assert_eq!(PriceCents::parse_dollars("42.10"), Ok(PriceCents(4210)));
        assert_eq!(PriceCents::parse_dollars("42.1"), Ok(PriceCents(4210)));
        assert_eq!(PriceCents::parse_dollars("42"), Ok(PriceCents(4200)));
        assert_eq!(PriceCents::parse_dollars("0.29"), Ok(PriceCents(29)));
        assert_eq!(PriceCents::parse_dollars("0.01"), Ok(PriceCents(1)));
        assert_eq!(
            PriceCents::parse_dollars("1000.00"),
            Ok(PriceCents(100_000))
        );
    }

    #[test]
    fn rejects_malformed_prices() {
        for bad in ["", ".5", "42.", "42.123", "-1.00", "4x.00", "42.1x", "1e3"] {
            assert!(
                PriceCents::parse_dollars(bad).is_err(),
                "{bad:?} should not parse"
            );
        }
    }

    #[test]
    fn prints_prices_as_dollars() {
        assert_eq!(PriceCents(4210).to_string(), "42.10");
        assert_eq!(PriceCents(5).to_string(), "0.05");
        assert_eq!(PriceCents(-150).to_string(), "-1.50");
    }
}
