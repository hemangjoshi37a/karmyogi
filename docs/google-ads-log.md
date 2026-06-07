# karmyogi — Google Ads log

> Living record of our Google Ads campaigns: structure, the research behind it,
> decisions, and a running performance log to iterate on (what works / what
> doesn't). No credentials here. Update the **Performance log** as data comes in.

## Accounts
- **Ad account:** `417-079-3536` (id `4170793536`), currency **INR**, tz Asia/Kolkata. Accessed **directly** (NOT via the MCC).
- **MCC / manager:** `5978375846` ("hjLabs.in") — manages no client accounts; do **not** set it as `login_customer_id` for this account.
- Managed via the `google-ads` MCP (server: `~/hjLabs.in-google-ads-mcp`) + direct API.
- **View in the UI:** https://ads.google.com → switch to account **417-079-3536** → Campaigns.

## Campaign: karmyogi-GRBL-WebApp-MaxUsers-2026
- **Campaign id:** `23909228388`  ·  **Budget id:** `15628622835`
- **Type:** Search  ·  **Bidding:** Maximize Clicks, **₹20 max-CPC cap**
- **Budget:** ₹300/day  ·  **Geo:** Worldwide (cheap-market focus)  ·  **Language:** all
- **Status:** **LIVE / ENABLED** (launched 2026-06-06, primary_status ELIGIBLE; ₹1000 funded). Search Partners turned OFF at launch.
- **Goal:** most users per rupee + high CTR. Landing: https://karmyogi.hjlabs.in (5-day explore-then-login grace).
- **Ad group:** "GRBL software & senders" (id `196900536403`)

### Keywords (16)
Phrase: grbl controller · grbl control software · grbl sender · grbl software · grbl cnc software · gcode sender · g code sender · universal gcode sender · candle grbl · web cnc controller · browser cnc control · online gcode sender · grbl controller android
Exact: [grbl controller] · [gcode sender] · [candle grbl]

### Responsive Search Ad → karmyogi.hjlabs.in (paths /GRBL/WebApp)
Headlines (15): GRBL Control in Your Browser · Free Web GRBL Sender · No Install, Runs in Chrome · Candle, in Your Browser · Online G-code Sender · Control GRBL Over USB · DXF & STL to G-code · Browser CNC Controller · Works on Android Chrome · Free CNC CAD/CAM Online · UGS & Candle Alternative · Carve, Laser, PCB & Plot · Stream G-code From Browser · Open karmyogi Free · 3-Axis GRBL, No Install
Descriptions (4): "Run any 3-axis GRBL machine from your browser over USB. No install, just open Chrome." · "Carving, laser, PCB routing, pen-plotting, soldering and 3D - one free web workbench." · "Visualize toolpaths in 3D and stream G-code live. Works on desktop and Android Chrome." · "A modern browser successor to Candle and UGS. Free, installable, offline-capable PWA."

### Negative keywords (15)
candle making · candle wax · soy candle · candle holder · scented candle · for sale · price · buy cnc machine · cnc machine price · jobs · salary · course · crack · free download crack · repair service

## Research behind it (2026-06-06)
**Keyword Planner — volume / competition / top-of-page bid (INR):**
- US: grbl 1300/mo · universal gcode sender 880 · grbl software 590 · grbl controller 390 (₹30–106) · gcode sender 210 (₹135–222) · grbl cnc software 170 · candle grbl 110. Mostly LOW competition; software-term CPCs ~₹30–150.
- India: grbl controller android 1000/mo · grbl 390 · universal gcode sender 320 · grbl controller 260 (₹1!). Bids ~₹0–5 — dirt cheap.
- Takeaway: niche is LOW-competition everywhere → cheap clicks + easy high CTR. Cheap markets (India/LATAM) give 10–50× more clicks/₹; clicks are relevant (GRBL owners; app runs on Android Chrome).

**Google Trends:** "grbl" relative interest strong in DE/FR/PL/CZ/HU/AT + LATAM. Related queries: laser grbl (100), grbl cnc, grbl controller, grbl software, grbl sender, **candle grbl** (Candle = the desktop app karmyogi succeeds → key ad angle).

## Decisions
- 2026-06-06: Geo = worldwide cheap-markets (owner pick) for max users/least budget. Bidding = Maximize Clicks ₹20 cap (no `set_maximize_clicks` MCP tool; set via API at creation). Built PAUSED pending (a) security hardening, (b) production redeploy of the 5-day grace gate so paid traffic explores before any login wall.

## Performance log (append as it runs)
Pull with the MCP: `get_campaign_performance` / `get_account_spend_summary` / `get_search_terms_report` / `get_keyword_performance`.

| Date | Days live | Impr | Clicks | CTR % | Avg CPC ₹ | Spend ₹ | Top geo | Conv | Notes |
|------|-----------|------|--------|-------|-----------|---------|---------|------|-------|
| _ (not launched yet)_ | | | | | | | | | campaign PAUSED |

## Iteration backlog (what to test)
- After ~1–2 weeks: mine `get_search_terms_report` → add winners as keywords, add wasteful terms as negatives.
- If volume is low: broaden match types (add BROAD on the best 2–3) / raise the ₹20 cap.
- Pause low-CTR / low-QS keywords; check `get_quality_scores` + `get_geo_performance` (cut expensive geos).
- Add a **conversion action** (sign-in / PWA install) → switch to Maximize Conversions once enough conversions.
- Measure grace-gate effect: do explore-period visitors convert to sign-ins?
