//! Matching latency and throughput.
//!
//!     cargo bench -p matching-engine
//!
//! Times every single `apply` call and reports percentiles, because the average of a
//! matching engine hides exactly what matters: the slow tail. The workload is deterministic
//! (a fixed-seed generator), so runs are comparable.
//!
//! Each measurement includes the cost of reading the clock, roughly 20-40 ns on most
//! machines, so the smallest numbers are an upper bound.

use std::hint::black_box;
use std::time::{Duration, Instant};

use matching_engine::{
    CancelOrder, Command, Engine, JournaledEngine, NewOrder, OrderId, OrderType, PriceCents, Qty,
    Side, TimeInForce,
};

fn main() {
    let commands = workload(1_000_000, 0x5eed);
    let mut engine = Engine::default();
    let latencies = time_each(commands, |command| black_box(engine.apply(command)).len());
    report("engine only (in memory)", latencies);
    println!(
        "  book at the end: {} resting orders\n",
        engine.resting_order_count()
    );

    // The journal flushes on every command, so this measures the real cost of durability.
    let path = std::env::temp_dir().join(format!("me-bench-{}.journal", std::process::id()));
    let mut journaled = JournaledEngine::open(&path).expect("open journal");
    let latencies = time_each(workload(100_000, 0x5eed), |command| {
        black_box(journaled.submit(command).expect("journal write")).len()
    });
    report("engine + journal (flush per command)", latencies);
    let _ = std::fs::remove_file(&path);
}

fn time_each(commands: Vec<Command>, mut apply: impl FnMut(Command) -> usize) -> Vec<Duration> {
    let mut latencies = Vec::with_capacity(commands.len());
    for command in commands {
        let start = Instant::now();
        apply(command);
        latencies.push(start.elapsed());
    }
    latencies
}

fn report(name: &str, mut latencies: Vec<Duration>) {
    let total: Duration = latencies.iter().sum();
    latencies.sort_unstable();
    let percentile = |p: f64| latencies[((latencies.len() - 1) as f64 * p) as usize];

    println!("{name}: {} commands", latencies.len());
    println!(
        "  throughput  {:.2}M commands/s",
        latencies.len() as f64 / total.as_secs_f64() / 1e6
    );
    println!(
        "  p50 {:>9}   p99 {:>9}   p99.9 {:>9}   max {:>9}",
        fmt(percentile(0.50)),
        fmt(percentile(0.99)),
        fmt(percentile(0.999)),
        fmt(*latencies.last().expect("at least one command")),
    );
}

fn fmt(d: Duration) -> String {
    match d.as_nanos() {
        n if n < 1_000 => format!("{n} ns"),
        n if n < 1_000_000 => format!("{:.1} µs", n as f64 / 1e3),
        n => format!("{:.1} ms", n as f64 / 1e6),
    }
}

/// A market-shaped workload: prices clustered around a mid so roughly half of incoming
/// orders cross, a mix of order types, and a steady stream of cancels so the book stays a
/// realistic size instead of growing forever.
fn workload(count: usize, seed: u64) -> Vec<Command> {
    const MID: i64 = 10_000;
    let mut rng = XorShift(seed);
    let mut orders_placed: u64 = 0;
    let mut commands = Vec::with_capacity(count);

    for _ in 0..count {
        let participant = format!("p{}", rng.below(100));
        let roll = rng.below(100);

        if roll < 25 && orders_placed > 0 {
            // Cancel one of the last thousand orders. Some will already have filled, and are
            // rejected, which is realistic too.
            let window = orders_placed.min(1_000);
            let order_id = OrderId(orders_placed - rng.below(window));
            commands.push(Command::Cancel(CancelOrder {
                participant,
                order_id,
            }));
            continue;
        }

        orders_placed += 1;
        let side = if rng.below(2) == 0 {
            Side::Buy
        } else {
            Side::Sell
        };
        let (order_type, time_in_force) = match roll {
            25..=34 => (OrderType::Market, TimeInForce::Ioc),
            35..=44 => (limit(MID, &mut rng), TimeInForce::Ioc),
            45..=47 => (limit(MID, &mut rng), TimeInForce::Fok),
            _ => (limit(MID, &mut rng), TimeInForce::Gtc),
        };
        commands.push(Command::New(NewOrder {
            client_order_id: format!("c{orders_placed}"),
            participant,
            symbol: if rng.below(4) == 0 { "BLTZ" } else { "ACME" }.to_string(),
            side,
            order_type,
            time_in_force,
            qty: Qty(1 + rng.below(500) as i64),
        }));
    }
    commands
}

fn limit(mid: i64, rng: &mut XorShift) -> OrderType {
    OrderType::Limit {
        price: PriceCents(mid - 10 + rng.below(21) as i64),
    }
}

/// A tiny deterministic random number generator, so the workload is identical every run.
struct XorShift(u64);

impl XorShift {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % bound
    }
}
