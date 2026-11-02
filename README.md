# Jamaica Economic Pulse

An Android app that scrapes Jamaica's economic indicators straight from the publishers, on your phone, and explains how each internal and external signal could affect the economy. It has no backend server and no AI dependency. Every number comes live from the sources below.

## What it pulls

| Source | What | Refresh |
|---|---|---|
| Bank of Jamaica (homepage + FX feed) | 12-month inflation, policy rate and next decision date, official USD/CAD/GBP/EUR rates | 6 h |
| STATIN (homepage) | CPI (monthly, YTD, point-to-point), unemployment, youth unemployment, LU4, participation, GDP growth, PPI, exports/imports | 12 h |
| IMF DataMapper API | Growth, inflation, unemployment, debt, current account, fiscal balance for Jamaica (plus US/Canada/UK growth), history and projections | 3 days |
| World Bank API | Structural exposure: remittances % GDP, tourism % exports, reserves in months of imports, fuel and food shares of imports, FDI, debt | 7 days |
| FRED (St. Louis Fed) | Brent, Henry Hub gas, Fed funds, US 10-yr, US unemployment, US CPI, consumer sentiment, broad USD, IMF food index, wheat, maize | 12 h |
| open.er-api.com + fawazahmed0 currency-api | USD/JMD now and 1, 3, 6 and 12 months ago | 6 h |
| NOAA National Hurricane Center | Active Atlantic storms, mentions of Jamaica, 7-day formation odds | 1 h |
| Gleaner & Observer RSS | Business headlines, auto-tagged by economic theme | 2 h |

## How the readings work
`www/js/analysis.js` holds about 18 transparent rules. Each one takes a live number, decides whether it signals **pressure**, **watch**, **relief** or **steady**, and states the transmission channel into Jamaica (for example: oil → import bill → current account → JMD → electricity and transport costs → CPI). The signals add up into four gauges: inflation pressure, growth momentum, external pressure and shock risk. To change a threshold, edit that file and push.

## Building
Every push to `main` runs `.github/workflows/build.yml`:
1. **Check data sources** runs every scraper against the live sites and posts a pass/fail table in the run summary. It also runs every Monday, so if a site changes its layout you'll see a red row.
2. **Build signed APK** produces `JA-Econ-Pulse-1.0.N.apk` and attaches it to a GitHub Release.

The signing key comes from the repo secrets `KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`. Every build uses the same key, so new APKs install over old ones and your cached data is kept.

Local preview: `cd www && python3 -m http.server`, then open it in a browser. Some sources block browser requests (CORS), so they will only load inside the app.
