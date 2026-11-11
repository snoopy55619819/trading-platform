//! What Alpha Exchange lists, and what it charges.
//!
//! Read from the published spec (`spec/listings.json`) at compile time, so the gateway can
//! never validate against different instruments than the ones it advertises.

use std::collections::HashMap;

use serde::Deserialize;

const PUBLISHED: &str = include_str!("../../../spec/listings.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Symbol {
    pub ticker: String,
    pub tick_size_cents: i64,
    pub lot_size: i64,
    pub currency: String,
    pub status: String,
    /// Anchors the price band (the fat-finger check). Not a live price.
    pub reference_price_cents: i64,
    pub price_band_pct: i64,
}

impl Symbol {
    pub fn is_active(&self) -> bool {
        self.status == "ACTIVE"
    }

    /// Is `price_cents` within `price_band_pct` of the reference price?
    pub fn within_band(&self, price_cents: i64) -> bool {
        (price_cents - self.reference_price_cents).abs() * 100
            <= self.reference_price_cents * self.price_band_pct
    }
}

#[derive(Deserialize)]
struct Venue {
    code: String,
    maker_fee_bps: i64,
    taker_fee_bps: i64,
}

#[derive(Deserialize)]
struct Published {
    venue: Venue,
    symbols: Vec<Symbol>,
}

#[derive(Debug, Clone)]
pub struct Listings {
    /// This venue's code, `ALPHA`. Also its FIX CompID.
    pub venue: String,
    /// Basis points of notional. Negative is a rebate: the venue pays liquidity providers.
    pub maker_fee_bps: i64,
    pub taker_fee_bps: i64,
    symbols: HashMap<String, Symbol>,
}

impl Listings {
    pub fn published() -> Listings {
        let file: Published = serde_json::from_str(PUBLISHED)
            .unwrap_or_else(|error| panic!("spec/listings.json is invalid: {error}"));
        Listings {
            venue: file.venue.code,
            maker_fee_bps: file.venue.maker_fee_bps,
            taker_fee_bps: file.venue.taker_fee_bps,
            symbols: file
                .symbols
                .into_iter()
                .map(|symbol| (symbol.ticker.clone(), symbol))
                .collect(),
        }
    }

    /// Every listed ticker.
    pub fn tickers(&self) -> impl Iterator<Item = String> + '_ {
        self.symbols.keys().cloned()
    }

    pub fn symbol(&self, ticker: &str) -> Option<&Symbol> {
        self.symbols.get(ticker)
    }

    /// The fee on one fill, in cents. Positive is charged; negative is a rebate. Rounded half
    /// away from zero, in integers.
    pub fn fee_cents(&self, notional_cents: i64, added_liquidity: bool) -> i64 {
        let bps = if added_liquidity {
            self.maker_fee_bps
        } else {
            self.taker_fee_bps
        };
        let scaled = notional_cents * bps;
        let (quotient, remainder) = (scaled / 10_000, scaled % 10_000);
        if remainder.abs() * 2 >= 10_000 {
            quotient + scaled.signum()
        } else {
            quotient
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_published_listings_load() {
        let listings = Listings::published();
        assert_eq!(listings.venue, "ALPHA");
        assert_eq!(listings.symbol("CRUX").unwrap().tick_size_cents, 5);
        assert!(listings.symbol("NOPE").is_none());
    }

    #[test]
    fn fees_round_half_away_from_zero() {
        let listings = Listings::published(); // maker -2 bps, taker 3 bps
        // 60 shares at 42.10 = $2,526.00 notional
        assert_eq!(listings.fee_cents(252_600, false), 76); // 75.78 cents charged
        assert_eq!(listings.fee_cents(252_600, true), -51); // 50.52 cents rebated
        assert_eq!(listings.fee_cents(5_000, false), 2); // 1.5 rounds up, not to even
        assert_eq!(listings.fee_cents(7_500, true), -2); // -1.5 rounds away from zero
    }

    #[test]
    fn the_price_band_is_inclusive() {
        let crux = Listings::published().symbol("CRUX").cloned().unwrap(); // 286.50, 15%
        assert!(crux.within_band(28_650 + 4_297));
        assert!(!crux.within_band(28_650 + 4_298));
        assert!(crux.within_band(28_650 - 4_297));
    }
}
