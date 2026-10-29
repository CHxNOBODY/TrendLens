# TrendLens

A personal dashboard for monitoring US technology stocks, exploring live charts, and evaluating transparent trading signals.

TrendLens is designed to run locally on Windows. It combines interactive charts, trend classification, a personal watchlist, notes, and historical strategy testing in one private workspace.

## Project Status

TrendLens is currently in the planning stage. This README describes the intended architecture and MVP requirements; it does not imply that the application, scripts, or integrations have been implemented.

## Goals

- Monitor technology stocks with continuously updated market data.
- Explain upward, downward, sideways, and uncertain market trends.
- Display rule-based entry and exit signals with supporting values and reasons.
- Evaluate strategies through backtesting and simulated positions.
- Keep personal records and application data on the user's computer.

TrendLens will not place real orders. The initial version will use explicit trading rules rather than machine learning.

## Planned Features

### Charts and Watchlist

- Editable watchlist, initially containing AAPL, MSFT, NVDA, AMD, GOOGL, AMZN, and META.
- Interactive candlestick and volume charts.
- One-minute, five-minute, and daily timeframes.
- Optional MA20, MA50, MA200, and RSI14 indicators.
- Entry and exit markers with explanations.
- A dark interface with Thai UI text and English tickers and indicator names.

### Live Data

- Historical data retrieval through REST APIs.
- Continuous market data ingestion through a dedicated WebSocket worker.
- A configurable display update interval, initially two seconds.
- Explicit labels for live, delayed, and demo data, including the provider and feed.
- Connection status, market-session status, and the latest data timestamp.
- Automatic reconnection and historical gap recovery.
- Signal generation paused when required data is stale or incomplete.

The display refresh interval does not determine data freshness. Feed entitlements, exchange coverage, provider latency, and market activity determine what data is available.

### Personal Workspace

- Persistent watchlists and per-symbol notes.
- Signal history without duplicate events after refreshes or reconnects.
- Local simulated positions, separate from signal events.
- CSV import and a reproducible demo mode that requires no API credentials.

### Backtesting

- Shared strategy logic between live analysis and historical testing.
- Configurable starting capital, position allocation, fees, and slippage.
- Equity curve, total return, maximum drawdown, trade count, win rate, and profit factor.
- Buy-and-hold comparison over the same period with consistent cost assumptions.
- An inspectable trade ledger and separate reporting for open positions.
- Separate development and out-of-sample evaluation periods.

## Technology Stack

| Component | Planned technology | Responsibility |
| --- | --- | --- |
| Language | TypeScript | Shared types and application logic |
| Application | Next.js App Router and React | Pages, layouts, and HTTP endpoints |
| Charts | TradingView Lightweight Charts | Candlesticks, volume, and chart updates |
| Market data worker | Node.js | Provider connections, aggregation, and signal processing |
| Local storage | SQLite | Prices, watchlists, notes, signals, and simulated positions |
| Tests | Vitest and Playwright | Core logic and end-to-end workflows |

Exact dependency versions will be selected and pinned during implementation. Chart integration must follow the library's license and attribution requirements.

## Architecture

```text
Market Data Provider
  | REST: history and gap recovery
  | WebSocket: ongoing market events
  v
Node.js Market Data Worker
  | Normalize and validate events
  | Aggregate bars and calculate indicators
  | Evaluate closed-bar signals
  +------------------------> SQLite
  |
  | Local WebSocket updates
  v
Next.js Client Components
  | Lightweight Charts
  | Trend and signal panels
  | Watchlist and connection status

Next.js Server / Route Handlers
  | Historical queries, notes, settings, and backtest jobs
  +------------------------> SQLite
```

Next.js includes React; it provides the application framework around the chart interface. Browser-dependent chart code belongs in Client Components and must initialize after mounting, with proper cleanup.

The market data worker runs as a separate long-lived process. Provider connections must not be created during page rendering or on every HTTP request. Both local services bind to `127.0.0.1`. A future startup script should launch the application and worker together.

CPU-heavy backtests should run outside the live ingestion event loop so that testing does not interrupt market data processing. Database access should use transactions and a defined writer policy, with SQLite WAL mode and bounded retry behavior evaluated during implementation.

## Market Data

Alpaca Market Data is the initial planned provider. A provider interface should allow another service to be added without changing chart or strategy logic.

### Feed Coverage

- IEX represents activity on a single exchange.
- SIP provides consolidated coverage across US exchanges; access and latency depend on the subscription and entitlements.
- The application must verify the selected feed's current capabilities and label its coverage and delay accurately.
- Missing credentials must lead to clearly labeled demo mode, not silently substituted live-looking data.

### Data Handling

- Store timestamps in UTC; support display in `Asia/Bangkok` and `America/New_York`.
- Use an exchange calendar to account for holidays, daylight saving changes, and early closes.
- Default to regular trading hours; apply the selected session policy consistently across charts, signals, and backtests.
- Handle duplicate, out-of-order, late, and corrected events using documented policies.
- Distinguish forming bars from closed bars.
- Require complete input bars before creating confirmed signals.
- Define stock-split and dividend adjustment policies and apply them consistently. Chart and backtest results must identify the adjustment method used.
- Historical corrections may update analytical data, but previously issued signals must retain an audit trail rather than silently changing history.

### CSV Import

Required columns:

```csv
Date,Open,High,Low,Close,Volume
2026-01-05,100.00,103.00,99.00,102.00,1500000
```

The example is synthetic. Imports must validate timestamps, OHLC consistency, numeric values, and duplicate rows. Intraday imports must declare a timezone or include offsets.

## Trend Classification

Trend classification is calculated independently for each timeframe. MA50 means 50 bars of the selected timeframe, not necessarily 50 days.

The initial classifier should evaluate these conditions in order:

1. **Insufficient data:** there are not enough closed bars for the required calculations.
2. **Sideways:** both normalized MA50 slope and normalized distance from MA50 are within configured thresholds.
3. **Uptrend:** the closing price is above MA50, and MA50 is higher than it was ten bars earlier.
4. **Downtrend:** the closing price is below MA50, and MA50 is lower than it was ten bars earlier.
5. **Uncertain:** none of the preceding conditions apply.

Normalized slope is `MA50[t] / MA50[t - 10] - 1`. Normalized distance is `Close[t] / MA50[t] - 1`. Sideways thresholds must be explicit, configurable, and recorded with each strategy configuration. Initial threshold values remain an implementation decision to validate during research.

## Initial Trading Strategy

The MVP strategy is long-only and uses five-minute bars by default.

| Action | Conditions |
| --- | --- |
| Consider entry | No open position, an uptrend, and the close is strictly above the highest high of the preceding 20 bars |
| Exit long position | An open position and the close is strictly below the lowest low of the preceding 10 bars |
| Wait | Neither condition applies |

The rolling high and low exclude the current bar. Confirmed decisions use closed bars only. Any condition displayed during a forming bar must be labeled **Awaiting confirmation**.

RSI is contextual information in the MVP and does not affect these rules. Exiting a position does not open a short position.

Each signal must record its symbol, timeframe, bar timestamp, strategy version, parameters, relevant indicator values, and explanation. Arbitrary indicator scores must not be presented as probabilities of profit.

## Backtest Assumptions

- A signal generated at a bar's close can execute no earlier than the next available bar's open.
- Buys and sells apply configurable fees and adverse slippage.
- Position sizing must account for costs and available cash.
- No leverage, negative cash balances, short positions, or overlapping positions in the same symbol.
- Fractional shares are the initial simulation assumption and must be disclosed.
- Final-bar signals without an executable next bar remain unfilled.
- Open positions at the end are marked to market and reported separately from closed trades.
- Undefined metrics, including profit factor with no losing trades, must be labeled appropriately.
- Insufficient data must produce an actionable message instead of misleading results.

The implementation must prevent look-ahead bias and preserve chronological evaluation. Initial backtests are per-symbol; results must not be combined into a shared-capital portfolio without an explicit portfolio model. Tests on a handpicked watchlist do not establish performance across the broader market.

## Suggested Repository Structure

```text
trendlens/
  apps/
    web/                 # Next.js application
    market-worker/       # Ingestion and local streaming service
  packages/
    core/                # Indicators, trend rules, strategy, backtesting
    data/                # Providers, CSV import, demo data, aggregation
    storage/             # SQLite schema, migrations, repositories
    shared/              # Configuration schemas and shared types
  tests/
    integration/
    e2e/
  data/                  # Ignored local database files
  .env.example
  .gitignore
  package.json
  README.md
```

## Local Setup Plan

Prerequisites will include a supported Node.js LTS release and npm. A live feed additionally requires provider credentials and appropriate data access.

The following commands describe the intended script contract. They are **not available yet**, because application scaffolding has not been created.

```powershell
npm ci
Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

The intended local address is `http://127.0.0.1:3000`. The startup command should launch both services and stop both cleanly on exit.

Proposed environment variables:

```dotenv
DATA_MODE=demo
ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_DATA_FEED=iex
DATABASE_PATH=./data/trendlens.sqlite
DISPLAY_TIMEZONE=Asia/Bangkok
UI_UPDATE_INTERVAL_MS=2000
```

Environment-file loading must be configured explicitly for both the web application and worker. Database paths must resolve consistently from the repository root. Live mode must validate credentials and feed access before starting analysis.

## Privacy and Local Operation

- Keep API credentials in server and worker environments. Never prefix secrets with `NEXT_PUBLIC_`.
- Exclude `.env`, local database files and sidecars, logs, and personal exports from Git.
- Do not expose public tunnels or deploy automatically.
- External network access is required for market data; demo mode should work without it.
- Validate local HTTP and WebSocket origins to prevent unrelated websites from accessing local services.
- Redact secrets from logs and error messages.

## Verification Plan

Unit tests should cover indicator warm-up, trend classification, breakout windows, closed-bar confirmation, duplicate signal prevention, next-bar execution, costs, cash constraints, aggregation boundaries, and malformed market events.

Integration tests should cover persistence, provider reconnection, gap recovery, and isolation between live processing and backtests.

The primary end-to-end flow is:

1. Start in demo mode without credentials.
2. Select a symbol and timeframe.
3. Inspect chart updates and signal explanations.
4. Save a note and confirm it persists after restarting.
5. Run a backtest and inspect its trades and equity curve.

Planned verification commands:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Live-feed verification must be reported separately from demo and mocked tests. No live integration should be described as verified without valid credentials and an actual connection test.

## Roadmap

- [ ] Scaffold the TypeScript workspace and local startup scripts.
- [ ] Deliver an end-to-end demo dashboard.
- [ ] Add SQLite persistence, CSV import, watchlists, and notes.
- [ ] Implement and test shared indicator, trend, and strategy logic.
- [ ] Add historical backtesting and simulated positions.
- [ ] Integrate the live provider and resilient streaming worker.
- [ ] Verify reconnection, data freshness, and session handling.
- [ ] Complete Windows setup documentation and end-to-end checks.

## Limitations

TrendLens provides analytical signals based on chosen rules, not guaranteed forecasts or personalized investment recommendations. Real-time data does not inherently improve prediction accuracy. Historical simulations depend on data quality and execution assumptions and do not guarantee future returns.

## References

- [Next.js documentation](https://nextjs.org/docs)
- [Lightweight Charts documentation](https://tradingview.github.io/lightweight-charts/)
- [Alpaca Market Data documentation](https://docs.alpaca.markets/us/docs/about-market-data-api)
- [SQLite documentation](https://www.sqlite.org/docs.html)
