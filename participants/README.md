# Market participants

Simulated third-party trading firms. They are **not** part of the broker or the exchange —
they are other businesses that happen to connect to Alpha Exchange, exactly as our own
broker does.

That distinction is the point: the simulator gets **no backdoor**. Its agents log on over
the same public FIX session a real client uses and read the same public market data feed.
That is what makes it a valid test of the whole system rather than a cheat, and it means
the exchange's FIX gateway is under continuous load from milestone 4 onward.

Built at **milestone 4**, once the exchange has a FIX gateway and a market data feed to
connect to. It will vendor Alpha's published spec the same way the broker does.

## Agents (planned)

| Agent | Behaviour |
|---|---|
| Market maker | Quotes both sides around a fair value; widens with volatility; skews quotes to offload inventory; pulls quotes on large adverse moves |
| Noise trader | Poisson arrivals, random side, small market orders |
| Momentum | Chases short-term moves — creates trends |
| Mean reversion | Fades extremes — creates the pullbacks |

Each symbol's hidden fair value follows a geometric Brownian motion with occasional
jumps ("news"), which is what makes the chart look like a real stock rather than noise
around a flat line.
