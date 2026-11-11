//! Command-line driver for the matching engine.
//!
//! Reads one instruction per line, from a scenario file or interactively, and prints what the
//! engine did. With `--journal FILE`, every order is journaled before it is applied and an
//! existing journal is replayed on start-up: quit, run again, and the book is exactly as you
//! left it.

use std::fs::File;
use std::io::{self, BufRead, BufReader, IsTerminal, Write};
use std::process::ExitCode;

use matching_engine::{
    CancelOrder, Command, Engine, Event, JournaledEngine, NewOrder, OrderBook, OrderId, OrderType,
    PriceCents, Qty, Side, TimeInForce, Trade,
};

const USAGE: &str = "\
usage: matching-engine [--journal FILE] [--verbose] [SCENARIO]

Reads instructions from SCENARIO, or from stdin if none is given.

  <who> buy|sell <qty> <SYMBOL> @ <price> [day|gtc|ioc|fok]   limit order (default gtc)
  <who> buy|sell <qty> <SYMBOL> market [ioc|fok]               market order (default ioc)
  <who> cancel <order-id>
  book <SYMBOL> [depth]                                        show the book
  tape [SYMBOL]                                                trades so far
  help | quit

  # starts a comment. Prices are dollars (42.10); quantities are shares.

  --journal FILE   journal every order to FILE, replaying it first if it exists
  --verbose        also print the book deltas the market data feed would publish";

fn main() -> ExitCode {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    let venue = match &args.journal {
        Some(path) => match JournaledEngine::open(path) {
            Ok(engine) => {
                println!("recovered {} commands from {path}\n", engine.recovered());
                Venue::Journaled(engine)
            }
            Err(error) => {
                eprintln!("cannot open journal: {error}");
                return ExitCode::FAILURE;
            }
        },
        None => Venue::InMemory(Engine::default()),
    };
    let mut session = Session::new(venue, args.verbose);

    let result = match &args.scenario {
        Some(path) => match File::open(path) {
            Ok(file) => session.run(BufReader::new(file), Mode::Scenario),
            Err(error) => {
                eprintln!("cannot read {path}: {error}");
                return ExitCode::FAILURE;
            }
        },
        None => {
            let stdin = io::stdin();
            let mode = if stdin.is_terminal() {
                Mode::Interactive
            } else {
                Mode::Scenario
            };
            session.run(stdin.lock(), mode)
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("stopping: {error}");
            ExitCode::FAILURE
        }
    }
}

struct Args {
    journal: Option<String>,
    verbose: bool,
    scenario: Option<String>,
}

impl Args {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
        let mut parsed = Args {
            journal: None,
            verbose: false,
            scenario: None,
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--journal" => {
                    parsed.journal = Some(args.next().ok_or("--journal needs a file")?);
                }
                "--verbose" | "-v" => parsed.verbose = true,
                "--help" | "-h" => return Err("matching engine CLI".to_string()),
                flag if flag.starts_with('-') => return Err(format!("unknown option {flag}")),
                _ if parsed.scenario.is_some() => return Err("only one scenario file".into()),
                _ => parsed.scenario = Some(arg),
            }
        }
        Ok(parsed)
    }
}

/// The engine, with or without a journal behind it.
enum Venue {
    InMemory(Engine),
    Journaled(JournaledEngine),
}

impl Venue {
    fn submit(&mut self, command: Command) -> io::Result<Vec<Event>> {
        match self {
            Venue::InMemory(engine) => Ok(engine.apply(command)),
            Venue::Journaled(engine) => engine.submit(command),
        }
    }

    fn engine(&self) -> &Engine {
        match self {
            Venue::InMemory(engine) => engine,
            Venue::Journaled(engine) => engine.engine(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Prompt for each line.
    Interactive,
    /// Echo each line, so the output reads as a transcript.
    Scenario,
}

enum Instruction {
    Submit(Command),
    Book { symbol: String, depth: usize },
    Tape { symbol: Option<String> },
    Help,
    Quit,
}

struct Session {
    venue: Venue,
    verbose: bool,
    /// Trades seen this session, for `tape`.
    tape: Vec<Trade>,
    /// The CLI makes up client order ids (`cli-1`, `cli-2`, ...) since nobody types them.
    last_client_id: u64,
}

impl Session {
    fn new(venue: Venue, verbose: bool) -> Self {
        // After recovery, continue numbering past every command already journaled, so a
        // made-up client order id is never reused across sessions.
        let last_client_id = match &venue {
            Venue::Journaled(engine) => engine.recovered() as u64,
            Venue::InMemory(_) => 0,
        };
        Self {
            venue,
            verbose,
            tape: Vec::new(),
            last_client_id,
        }
    }

    fn run(&mut self, mut input: impl BufRead, mode: Mode) -> io::Result<()> {
        let mut line = String::new();
        loop {
            if mode == Mode::Interactive {
                print!("> ");
                io::stdout().flush()?;
            }
            line.clear();
            if input.read_line(&mut line)? == 0 {
                return Ok(());
            }
            let line = line.trim_end();

            if mode == Mode::Scenario {
                match line.trim_start() {
                    "" => println!(),
                    comment if comment.starts_with('#') => println!("{comment}"),
                    instruction => println!("> {instruction}"),
                }
            }

            match self.parse(line) {
                Ok(None) => {}
                Ok(Some(Instruction::Quit)) => return Ok(()),
                Ok(Some(instruction)) => self.execute(instruction)?,
                Err(message) => println!("  ! {message}"),
            }
        }
    }

    /// Carries out one instruction. A journal write failure is returned as an error and ends
    /// the session: the command was not applied, and carrying on would hide that.
    fn execute(&mut self, instruction: Instruction) -> io::Result<()> {
        match instruction {
            Instruction::Submit(command) => {
                for event in self.venue.submit(command)? {
                    if let Event::Trade(trade) = &event {
                        self.tape.push(trade.clone());
                    }
                    if let Some(line) = describe(&event, self.verbose) {
                        println!("  {line}");
                    }
                }
            }
            Instruction::Book { symbol, depth } => {
                print_book(&symbol, self.venue.engine().book(&symbol), depth);
            }
            Instruction::Tape { symbol } => self.print_tape(symbol.as_deref()),
            Instruction::Help => println!("{USAGE}"),
            Instruction::Quit => {}
        }
        Ok(())
    }

    fn parse(&mut self, line: &str) -> Result<Option<Instruction>, String> {
        let without_comment = line.split('#').next().unwrap_or("");
        let words: Vec<&str> = without_comment.split_whitespace().collect();

        let instruction = match words.as_slice() {
            [] => return Ok(None),
            ["help"] => Instruction::Help,
            ["quit" | "exit"] => Instruction::Quit,
            ["book", symbol] => Instruction::Book {
                symbol: symbol.to_uppercase(),
                depth: 5,
            },
            ["book", symbol, depth] => Instruction::Book {
                symbol: symbol.to_uppercase(),
                depth: depth.parse().map_err(|_| format!("not a depth: {depth}"))?,
            },
            ["tape"] => Instruction::Tape { symbol: None },
            ["tape", symbol] => Instruction::Tape {
                symbol: Some(symbol.to_uppercase()),
            },
            [who, "cancel", id] => Instruction::Submit(Command::Cancel(CancelOrder {
                participant: who.to_string(),
                order_id: OrderId(id.parse().map_err(|_| format!("not an order id: {id}"))?),
            })),
            [who, "buy", rest @ ..] => {
                Instruction::Submit(self.parse_order(who, Side::Buy, rest)?)
            }
            [who, "sell", rest @ ..] => {
                Instruction::Submit(self.parse_order(who, Side::Sell, rest)?)
            }
            _ => return Err("not understood; type `help` for the syntax".to_string()),
        };
        Ok(Some(instruction))
    }

    /// `<qty> <SYMBOL> @ <price> [tif]` or `<qty> <SYMBOL> market [tif]`
    fn parse_order(&mut self, who: &str, side: Side, words: &[&str]) -> Result<Command, String> {
        let [qty, symbol, kind, tail @ ..] = words else {
            return Err("expected <qty> <SYMBOL> @ <price>, or <qty> <SYMBOL> market".into());
        };
        let qty = Qty(qty.parse().map_err(|_| format!("not a quantity: {qty}"))?);

        let (order_type, tail) = match *kind {
            "@" => {
                let [price, tail @ ..] = tail else {
                    return Err("missing a price after @".into());
                };
                let price = PriceCents::parse_dollars(price).map_err(|e| e.to_string())?;
                (OrderType::Limit { price }, tail)
            }
            "market" => (OrderType::Market, tail),
            other => return Err(format!("expected @ <price> or market, found {other}")),
        };

        let time_in_force = match (tail, order_type) {
            ([], OrderType::Market) => TimeInForce::Ioc,
            ([], OrderType::Limit { .. }) => TimeInForce::Gtc,
            ([tif], _) => parse_time_in_force(tif)?,
            _ => return Err("too many words".into()),
        };

        self.last_client_id += 1;
        Ok(Command::New(NewOrder {
            client_order_id: format!("cli-{}", self.last_client_id),
            participant: who.to_string(),
            symbol: symbol.to_uppercase(),
            side,
            order_type,
            time_in_force,
            qty,
        }))
    }

    fn print_tape(&self, symbol: Option<&str>) {
        let trades: Vec<&Trade> = self
            .tape
            .iter()
            .filter(|trade| symbol.is_none_or(|s| trade.symbol == s))
            .collect();
        if trades.is_empty() {
            println!("  (no trades this session)");
        }
        for trade in trades {
            println!("  {}", describe_trade(trade));
        }
    }
}

fn parse_time_in_force(word: &str) -> Result<TimeInForce, String> {
    match word.to_lowercase().as_str() {
        "day" => Ok(TimeInForce::Day),
        "gtc" => Ok(TimeInForce::Gtc),
        "ioc" => Ok(TimeInForce::Ioc),
        "fok" => Ok(TimeInForce::Fok),
        _ => Err(format!(
            "not a time in force: {word} (day, gtc, ioc or fok)"
        )),
    }
}

/// One line per event. Book deltas are what the public feed would carry; they are noisy, so
/// they only show with --verbose.
fn describe(event: &Event, verbose: bool) -> Option<String> {
    Some(match event {
        Event::Accepted {
            order_id,
            participant,
            symbol,
            side,
            order_type,
            time_in_force,
            qty,
            ..
        } => {
            let price = match order_type {
                OrderType::Limit { price } => format!("@ {price}"),
                OrderType::Market => "market".to_string(),
            };
            format!(
                "accepted   #{order_id} {participant} {side} {qty} {symbol} {price} {time_in_force}"
            )
        }
        Event::Rejected {
            client_order_id,
            participant,
            reason,
        } => format!("rejected   {participant} {client_order_id}: {reason}"),
        Event::Trade(trade) => format!("trade      {}", describe_trade(trade)),
        Event::Canceled {
            order_id,
            remaining,
            reason,
            ..
        } => format!("canceled   #{order_id} {remaining} unfilled: {reason}"),
        Event::CancelRejected {
            order_id,
            participant,
            reason,
        } => format!("cancel rejected   #{order_id} for {participant}: {reason}"),
        Event::BookDelta(delta) if verbose => format!(
            "book delta {} {} {} -> {} ({} orders)",
            delta.symbol, delta.side, delta.price, delta.qty, delta.order_count
        ),
        Event::BookDelta(_) => return None,
    })
}

fn describe_trade(trade: &Trade) -> String {
    let (buyer, buy_order) = trade.buyer();
    let (seller, sell_order) = trade.seller();
    format!(
        "T{} {} {} @ {}   buyer {buyer} #{buy_order}, seller {seller} #{sell_order}, {} aggressor",
        trade.trade_id, trade.symbol, trade.qty, trade.price, trade.aggressor_side
    )
}

/// Asks above, bids below, best prices nearest the middle, like a trading screen.
fn print_book(symbol: &str, book: Option<&OrderBook>, depth: usize) {
    let book = match book {
        Some(book) if !book.is_empty() => book,
        _ => {
            println!("  {symbol}: empty book");
            return;
        }
    };
    let row = |label: &str, price: PriceCents, qty: Qty, orders: usize| {
        let plural = if orders == 1 { "" } else { "s" };
        println!("    {label}  {price:>9}  {qty:>7}   ({orders} order{plural})");
    };

    println!("  {symbol}");
    let asks: Vec<_> = book.depth(Side::Sell).take(depth).collect();
    for level in asks.iter().rev() {
        row("ASK", level.price, level.qty, level.order_count);
    }
    match book.spread() {
        Some(spread) => println!("    --------- spread {spread} ---------"),
        None => println!("    ---------------------------------"),
    }
    for level in book.depth(Side::Buy).take(depth) {
        row("BID", level.price, level.qty, level.order_count);
    }
}
