# Jamaica Economic Pulse

An Android app that scrapes Jamaica's economic indicators straight from the publishers, on your phone, and explains how each internal and external signal could affect the economy. It has no backend server and no AI dependency. Every number comes live from the sources below.

## What it pulls

| Source | What | Refresh |
|---|---|---|
| Bank of Jamaica (homepage + FX feed) | 12-month inflation, policy rate and next decision date, official USD/CAD/GBP/EUR rates | 6 h |
| STATIN (homepage) | CPI (monthly, YTD, point-to-point), unemployment, youth unemployment, LU4, participation, GDP growth, PPI, exports/imports | 12 h |
| IMF DataMapper API | Growth, inflation, unemployment, debt, current account, fiscal balance for Jamaica (plus US/Canada/UK growth), history and projections | 3 days |
| World Bank API | Structural exposure: remittances % GDP, tourism % exports, reserves in months of imports, fuel and food shares of imports, FDI, debt | 7 days |
| BOJ interest-rate tables (Excel) | Average commercial-bank loan rates (instalment/vehicle, personal, mortgage, overall), deposit rates, T-bill yields | 24 h |
| BOJ Remittance Bulletin (PDF) | Monthly net remittances, year-on-year change, US share | 24 h |
| Tourism Analytics (JTB & airport data) | Stopover arrivals and Montego Bay / Kingston airport passengers, year-on-year | 24 h |
| Jamaica Stock Exchange | Daily Main, Junior, Combined, Select and USD index closes (the app builds its own trend history) | 6 h |
| PropertyAdsJa & Gleaner Classifieds | Houses and land for sale (KSA, St. Thomas, St. Catherine) | 12 h |
| CaribbeanJobs | Openings with “analyst” in the title | 8 h |
| OpenStreetMap Nominatim + OSRM | Listing locations and drive times from your work address (cached on the phone) | on demand |
| Petrojam | Weekly ex-refinery prices for gasolene 87/90, diesel, ULSD, LPG | 12 h |
| FRED (St. Louis Fed) | Brent, Henry Hub gas, Fed funds, US 10-yr, US unemployment, US CPI, consumer sentiment, broad USD, IMF food index, wheat, maize, aluminium, deep-sea freight, VIX, EM high-yield spread, Canada unemployment | 12 h |
| open.er-api.com + fawazahmed0 currency-api | USD/JMD and JPY/JMD now and 1, 3, 6 and 12 months ago | 6 h |
| NOAA National Hurricane Center | Active Atlantic storms, mentions of Jamaica, 7-day formation odds | 1 h |
| Gleaner & Observer RSS | Business headlines, auto-tagged by economic theme | 2 h |

## Decide tab
Glanceable verdicts for personal decisions, each with its reasons shown:
- **Spend** — trim / careful / normal, from inflation, real savings rates, growth, fuel & food trends, jobs and remittances.
- **Borrow** — loan-rate outlook, live loan/deposit/T-bill rates, car-loan calculator, car import-cost signals.
- **Home** — buy-now reading from average bank mortgage rates, rate outlook, inflation, building-cost pressure and income security, plus an affordability calculator. (Jamaica has no public house-price index, so prices themselves are not tracked.)
- **Invest** — example asset-class mixes for Conservative / Balanced / Growth, tilted by real JMD yields, JMD pressure, rate outlook, global risk mood and inflation; compares JMD/USD safe yields.
- **Work** — whether it’s a good time to look or negotiate, with sector temperatures from tourism, mining, remittance and news data.
- **Home → Your buying power** — compares Bank only vs NHT (you) + bank vs NHT + co-applicant + bank for any price: NHT loan (rate from average weekly income band, term from the youngest applicant’s age, July 2025 loan limits), bank top-up at the live BOJ mortgage average, deposit, closing costs, monthly payment, total interest and the maximum price you can afford. All limits and rates are editable.
- **Listings** — houses and land for sale scraped from PropertyAdsJa and Gleaner Classifieds, located via OpenStreetMap and timed by car (OSRM) from your work address; filtered to your commute window, starred for St. Thomas / Bull Bay, and sorted by whether you can afford them.
- **Jobs** — openings with “analyst” in the title from CaribbeanJobs (Jamaica only by default).
These are general rule-based readings, not personalised financial advice.

## Borrow section
A loan-rates outlook for the next 3–6 months (inflation vs target, real policy rate, T-bill trend, vehicle-loan rate trend, JMD, oil, US Fed), current loan/deposit/T-bill rates, what saving earns after inflation, a car-loan calculator (payment, total interest, rate sensitivity, fuel cost) and car import-cost signals (yen, US dollar, freight, pump prices).

## How the readings work
`www/js/analysis.js` holds about 25 transparent rules plus the borrowing outlook. Each one takes a live number, decides whether it signals **pressure**, **watch**, **relief** or **steady**, and states the transmission channel into Jamaica (for example: oil → import bill → current account → JMD → electricity and transport costs → CPI). The signals add up into four gauges: inflation pressure, growth momentum, external pressure and shock risk. To change a threshold, edit that file and push.

## Stock picks: the Edge score
The Trade section ranks JSE stocks with one score, **Edge**. It drives the buy list, the 3-month keep-or-sell review, the odds bands, "chance up" and the phone alerts. `.github/workflows/forecast.yml` makes it nightly and saves it in `data/forecasts.json`.

`scripts/edge_v2.py` builds the score. It groups the tested signals into themes and refits their signs and weights every quarter from data whose outcome was already known. It measures pullbacks on the bid/ask midpoint and adds the Timestral forecast and company announcements. Each stock is then ranked by its expected 3-month excess return minus its quoted spread and fees. Only stocks that trade on at least half of days get a rank. The original equal-weight score in `scripts/factor_study.py` is kept only as a baseline in the back-tests.

### The trading rule
`RULES` in `scripts/edge_v2.py` lists every way of trading the ranking that was tried. `SHIP` names the one the app tells you to follow:

1. Buy the Edge top 5 in equal amounts.
2. Place each buy as a limit order at the quote midpoint, good for 5 trading days. If it hasn't filled by then, buy at the ask.
3. Every 3 months, keep each holding that still ranks in the top 20. Sell the rest with a limit at the midpoint, and buy whatever is new in the top 5.

The back-test counts a limit order as filled only on a day the stock traded strictly through the limit, using the JSE's daily high and low. Waiting in a queue at the limit price never counts. The rule was picked on buys made before 2026, and 2026 is reported on its own. `data/edge_v2.json` holds the model, every rule's back-test and the shipped rule's checks: the same rule without its three biggest winners, and the old score traded the same way. Most of the rule's gain comes from a few stocks held a long time, so expect lumpy results.

### Files
- `data/edge_hist.json` holds the walk-forward score and rank for each 21-day test date. `scripts/chance_model.py` and `scripts/asymmetry.py` use it, so "chance up" and the odds bands describe this score.
- `data/alerts.json` is what the phone's background check reads. It holds the buy list (with limit prices), the keep band, ranks, weak results, dividends and announcements. Only the Edge rank says buy or sell.
- `data/picks_log_v2.json` logs each night's top 10 and scores it as it plays out. `data/picks_log.json` is the old score's log, which stopped on 2026-11-19.

### Recovery watch
`scripts/recovery.py` lists the stocks trading 40% or more below their 2-year high. For each one it saves the drop, the profit path, dividends, insider trades since the peak and the announcements to read. `idea_tests.py` back-tests the next 6 months for stocks in each situation: loss-making, losses shrinking, insiders buying, no dividend, and each Edge-rank band. The app shows the matching history on the stock's page. Its "Why did it fall? Can it come back?" AI button has to explain the cause, name what to wait for, quote that history, and pick one of three verdicts: avoid, watch, or a small speculative position. The phone logs each verdict with the price, so the AI's calls can be judged after 6 months. On the JSE most of these stocks kept falling, so none of this touches the Edge score or the buy list.

### Pop watch
`scripts/pops.py` finds every sudden big rise: a stock beating the average JSE stock by 25+ points within 21 trading days, confirmed on the bid/ask midpoint. It tags the news around each rise and measures the 3 months after. It also fits a model of the chance of a rise in the next month on the first half of history and judges it on the second. The record is sobering:
- Half the rises had no announcement nearby.
- Buying after a rise trailed the market over the next 3 months (a proven trap).
- The stocks with the highest rise odds rose more often but also crashed more often, and lost money after their wide spreads.

The Trade page shows all of this as lottery tickets, outside the Edge rule. A stock that just rose gets a "Why did it jump? Will it hold?" AI button.

### What the AI reads
`scripts/read_notices.py` runs nightly. It summarises up to 15 PDFs behind key announcements (reviews, delays, take-overs and results first) for the stocks on the recovery and pop watches, using the same low-cost Gemini model as the report reader. Scanned letters go to it as files. Summaries are kept in `data/notices.json`. They appear under each announcement and in the facts the AI gets.

`scripts/ai_backtest.py` is a blind test of the recovery AI. For past big fallers it rebuilds the facts the AI would have had that day, with the company's name and years removed and history taken only from earlier cases. It asks the app's own prompt and scores each verdict on the next 6 months. Run it from Actions → "Read financial reports (AI)" → job `ai_backtest`. The `notices` job reads chosen stocks' announcements on demand.

`scripts/test_registry.py` keeps every test ever run, including every trading rule, in `data/test_registry.json`. It judges each one by a stricter bar: overlap-adjusted |t| of at least 3, the same sign in both halves, and at least 30 cases.

## Building
Every push to `main` runs `.github/workflows/build.yml`:
1. **Check data sources** runs every scraper against the live sites and posts a pass/fail table in the run summary. It also runs every Monday, so if a site changes its layout you'll see a red row.
2. **Build signed APK** produces `JA-Econ-Pulse-1.0.N.apk` and attaches it to a GitHub Release.

By default the APK is signed with the fixed debug key in `android/app/debug.keystore`. That key isn't secret, but because every build uses it, new APKs install over old ones and your cached data is kept. If you later add the repo secrets `KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`, the build switches to a signed release build. You'd have to uninstall once when you switch.

Local preview: `cd www && python3 -m http.server`, then open it in a browser. Some sources block browser requests (CORS), so they will only load inside the app.
