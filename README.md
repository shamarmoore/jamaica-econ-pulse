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
| Petrojam | Weekly ex-refinery prices for gasolene 87/90, diesel, ULSD, LPG | 12 h |
| FRED (St. Louis Fed) | Brent, Henry Hub gas, Fed funds, US 10-yr, US unemployment, US CPI, consumer sentiment, broad USD, IMF food index, wheat, maize, aluminium, deep-sea freight, VIX, EM high-yield spread, Canada unemployment | 12 h |
| open.er-api.com + fawazahmed0 currency-api | USD/JMD and JPY/JMD now and 1, 3, 6 and 12 months ago | 6 h |
| NOAA National Hurricane Center | Active Atlantic storms, mentions of Jamaica, 7-day formation odds | 1 h |
| Gleaner & Observer RSS | Business headlines, auto-tagged by economic theme | 2 h |

## Decide tab
Glanceable verdicts for personal decisions, each with its reasons shown:
- **Spend** — trim / careful / normal, from inflation, real savings rates, growth, fuel & food trends, jobs and remittances.
- **Borrow** — loan-rate outlook, live loan/deposit/T-bill rates, car-loan calculator, car import-cost signals.
- **Home** — buy-now reading from mortgage rates (banks & building societies), rate outlook, inflation, building-cost pressure and income security, plus an affordability calculator. (Jamaica has no public house-price index, so prices themselves are not tracked.)
- **Invest** — example asset-class mixes for Conservative / Balanced / Growth, tilted by real JMD yields, JMD pressure, rate outlook, global risk mood and inflation; compares JMD/USD safe yields.
- **Work** — whether it’s a good time to look or negotiate, with sector temperatures from tourism, mining, remittance and news data.
These are general rule-based readings, not personalised financial advice.

## Borrow section
A loan-rates outlook for the next 3–6 months (inflation vs target, real policy rate, T-bill trend, vehicle-loan rate trend, JMD, oil, US Fed), current loan/deposit/T-bill rates, what saving earns after inflation, a car-loan calculator (payment, total interest, rate sensitivity, fuel cost) and car import-cost signals (yen, US dollar, freight, pump prices).

## How the readings work
`www/js/analysis.js` holds about 25 transparent rules plus the borrowing outlook. Each one takes a live number, decides whether it signals **pressure**, **watch**, **relief** or **steady**, and states the transmission channel into Jamaica (for example: oil → import bill → current account → JMD → electricity and transport costs → CPI). The signals add up into four gauges: inflation pressure, growth momentum, external pressure and shock risk. To change a threshold, edit that file and push.

## Building
Every push to `main` runs `.github/workflows/build.yml`:
1. **Check data sources** runs every scraper against the live sites and posts a pass/fail table in the run summary. It also runs every Monday, so if a site changes its layout you'll see a red row.
2. **Build signed APK** produces `JA-Econ-Pulse-1.0.N.apk` and attaches it to a GitHub Release.

By default the APK is signed with the fixed debug key in `android/app/debug.keystore`. That key isn't secret, but because every build uses it, new APKs install over old ones and your cached data is kept. If you later add the repo secrets `KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`, the build switches to a signed release build. You'd have to uninstall once when you switch.

Local preview: `cd www && python3 -m http.server`, then open it in a browser. Some sources block browser requests (CORS), so they will only load inside the app.
