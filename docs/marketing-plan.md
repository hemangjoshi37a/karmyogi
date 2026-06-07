# karmyogi — Advertising & Marketing Plan

> Hosted at **karmyogi.hjlabs.in** by hjLabs.in. A browser-only (no install, no server) control + CAD/CAM workbench for hobby/desktop 3-axis GRBL machines, running in Chrome/Edge via the Web Serial API.
>
> **Goal:** Become the well-known go-to software in the Sainsmart/Genmitsu 3018 (3018-PRO, PROVer, MX3, 3020, 3040) and broader hobby-GRBL community (FoxAlien, TwoTrees, Comgrow, MYSWEETY), with a smooth funnel from acquisition → activation → retention → feedback/referral.
>
> *This document is the single source of truth for marketing. It is research-backed; sources are cited inline.*

---

## 0. The one-sentence thesis

**Every other GRBL tool in this niche is either a desktop app you have to download and install (Candle, UGS, gSender, OpenBuilds CONTROL, LightBurn) or a "web" app that secretly needs a Node.js server / Raspberry Pi (cncjs, grblweb).** karmyogi is the only one that is *genuinely* zero-install: open a URL, click "Connect", cut. That is the wedge. Everything in this plan hammers that wedge into the 3018 community.

Research confirming the gap:
- cncjs "runs on Node.js on Raspberry Pi OS or PC" and "requires server-side installation rather than being a pure browser-based solution." ([cncrouterinfo.com](https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/), [cncjs FAQ](https://github.com/cncjs/cncjs/wiki/FAQ))
- gSender, UGS, OpenBuilds CONTROL are all desktop installs (Electron / Java / native). ([cncrouterinfo.com](https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/))
- grblweb is web-based but is a self-hosted Node.js server you must run. ([github.com/andrewhodel/grblweb](https://github.com/andrewhodel/grblweb))
- No major incumbent advertises a true Web-Serial, no-install, mobile-capable, all-in-one (carve + laser + pen + solder + PCB) product to this audience. That whitespace is karmyogi's.

---

## 1. Positioning & messaging

### One-line hook
**"Your whole CNC workbench, in a browser tab. No install. Just plug in and cut."**

### 3-second value prop (above-the-fold on the landing page)
> **karmyogi** — Control your 3018 (and any GRBL machine) right from Chrome. CAD, CAM, 3D toolpaths, jog, and G-code streaming. Carving, laser, pen-plotting, PCB, soldering — all in one tab. Works on your phone too. Free.

### The switch story (why a 3018 owner leaves Candle/UGS/cncjs)
A typical 3018 owner today juggles **Candle** (control + basic CAM) plus a separate **CAM** tool (Easel/Estlcam/Fusion) plus **LaserGRBL/LightBurn** if they added a laser module. Pain points karmyogi removes:

| Their pain today | karmyogi answer |
|---|---|
| Download/installers, Java runtimes, version mismatches, Windows-only | Open a URL. Nothing to install. Auto-updates. |
| cncjs "web" UI needs a Raspberry Pi + Node.js to set up | Pure browser, Web Serial — no server, no Pi |
| Candle is Windows/Linux only; no Mac, no phone | Runs on any Chrome/Edge device incl. Mac + Android phone |
| Separate apps for carve / laser / pen / PCB / solder | One workbench covers all five modes |
| Candle's dated, fixed UI | Modern dockable/floatable/resizable panels + 3D viewer |
| Want to jog/monitor from the couch or phone | Mobile layout with same controls |

> **Honesty guardrail for all copy:** Web Serial is Chromium-only (Chrome/Edge/Brave/Opera — not Firefox/Safari) and needs HTTPS + a user click. Always state "Works in Chrome & Edge." Never imply iOS Safari support. This builds trust in a skeptical maker audience.

### Brand voice
Maker-to-maker, plainspoken, slightly irreverent about bloated installers. Show, don't tell — every claim backed by a 20-second screen recording.

### 3–5 ad headline / creative angles
1. **The no-install angle (primary):** "Control your 3018 from a browser tab. No download. No Raspberry Pi. Just plug in." — *demo: USB plug → Connect → jog, all in <15s.*
2. **The all-in-one angle:** "Carve, laser, pen-plot, solder, and route PCBs — one free web app." — *montage of all five modes.*
3. **The Candle-successor angle:** "Loved Candle? This is Candle, reborn in your browser — with 3D, CAM, and mobile." (Candle is the literal reference app; reach its users by name.)
4. **The mobile angle:** "Jog your CNC from your phone. Yes, really. No app to install." — *phone jogging a running 3018.*
5. **The DXF/STL angle:** "Drop in a DXF or STL → get a safe toolpath → cut. In the browser." — *file drag-drop to running G-code.*

---

## 2. Competitive study

Pricing/positioning verified via research (sources inline). The recurring finding: **none of these advertise aggressively on paid search to hobbyists; growth is organic/SEO/YouTube/community.** That means paid search on the long-tail terms is cheap and uncontested — a real opportunity.

| Product | What it is | Price | Advertises? | Positioning | Gap karmyogi exploits |
|---|---|---|---|---|---|
| **Candle (GRBLControl)** | Open-source GRBL control + basic CAM; the de-facto 3018 default | Free | No (organic only) | Simple, beginner GRBL controller, Windows/Linux ([cncsourced](https://www.cncsourced.com/rankings/best-3018-cnc-software/), [tyvok](https://tyvok.com/blogs/news/best-grbl-software-2025-ugs-candle)) | No install, Mac/phone support, 3D, real CAM, laser/PCB/solder modes |
| **Universal Gcode Sender (UGS)** | Original Java sender; rock-solid, dated UI | Free | No | "Bulletproof, 10+ years," for experienced users ([cncrouterinfo](https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/)) | Modern dockable UI, integrated CAM, mobile, zero install |
| **cncjs** | Web UI but needs Node.js / Raspberry Pi server | Free | No | "Multi-device, plugins; less active dev recently" ([cncrouterinfo](https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/), [cncjs](https://cnc.js.org/)) | **No server/Pi needed** — pure Web Serial. This is the head-to-head win. |
| **gSender (Sienci Labs)** | Best-UX free Electron sender; grbl/grblHAL | Free | Indirect (Sienci sells machines; bundles gSender) | "Best UX, probing wizards, actively maintained" ([sienci.com](https://sienci.com/gsender/), [github](https://github.com/Sienci-Labs/gsender)) | No install + built-in CAM + multi-mode; gSender is control-only |
| **OpenBuilds CONTROL** | Free light control, flashes firmware, phone-jog over LAN | Free | Indirect (OpenBuilds sells parts) | Clean UI, beginner-friendly ([alternativeto](https://alternativeto.net/software/openbuilds-control/)) | Zero install; integrated CAD/CAM; broader machine modes |
| **bCNC** | Python sender w/ powerful probing & autoleveling | Free | No | Advanced users, autoleveling | Modern UI, no Python setup, mobile |
| **Easel (Inventables)** | Browser CAD/CAM + GRBL control (uses local helper) | Free / Easel Pro ~$15/mo ([carbide3d](https://carbide3d.com/learn/free-cnc-software/)) | Some (Inventables markets X-Carve) | Beginner web CAM, tied to Inventables ecosystem | No paid tier gate on core features; full control + multi-mode; not vendor-locked |
| **Carbide Create / Motion** | Free 2D CAM (Pro $120/yr) + control, for Shapeoko/Nomad | Free / $120 yr ([carbide3d](https://carbide3d.com/learn/free-cnc-software/)) | Indirect (sells Shapeoko/Nomad) | Vendor tool for Carbide 3D machines | Vendor-neutral, browser, multi-mode |
| **LightBurn** | Premier laser CAD/CAM/control | Core ~$120, Pro ~$199 ([monportlaser](https://monportlaser.com/blogs/software/understanding-lightburn-software-features-and-pricing-guide)) | Strong YouTube + creator presence | Laser-first paid standard | We offer free laser mode + CNC carve in one; we don't beat LightBurn on lasers — position as "the free all-rounder" |
| **Estlcam** | Cheap powerful CAM + control; nagware until licensed | ~€59 one-time ([cncsourced](https://www.cncsourced.com/software/best-free-cnc-software-control-cad-cam/)) | No | Affordable hobby CAM | No nagware, browser, free, integrated |
| **Fusion 360 (Personal)** | Pro CAD/CAM, free for hobby <$1k/yr revenue | Free hobby / paid pro ([carbide3d](https://carbide3d.com/learn/free-cnc-software/)) | Autodesk brand ads | Heavyweight pro CAM | Lightweight, instant, no account/install for simple 2.5D jobs |
| **LaserGRBL** | Free beginner laser control (Windows) | Free | No | Beginner laser, Windows-only ([cncsourced](https://www.cncsourced.com/rankings/best-3018-cnc-software/)) | Cross-platform, browser, also does CNC carve |
| **grblweb** | Self-hosted Node.js web GRBL sender | Free | No | DIY web controller ([github](https://github.com/andrewhodel/grblweb)) | No self-hosting; hosted SaaS, modern UI, CAM |

**Strategic reading:** The incumbents fall into two camps — (a) **machine vendors** giving away control software to sell hardware (Sienci/gSender, Inventables/Easel, Carbide 3D), and (b) **community open-source** with no marketing budget (Candle, UGS, bCNC, cncjs). karmyogi is hardware-neutral and has a marketing intent — so a modest, well-targeted spend can win share fast on terms nobody is bidding on.

---

## 3. Keyword research

Grouped by buyer intent. Volume/competition are qualitative estimates from the research; **validate the starred ★ terms in Google Keyword Planner before funding ads.** Terms in **bold** are the priority buys/SEO targets.

### A. Problem-aware (they have a 3018, want it to do something)
| Keyword | Intent | Est. competition | Notes |
|---|---|---|---|
| **3018 cnc software** ★ | High | Med (content-heavy) | Cornerstone SEO page + ad group |
| **best software for 3018 cnc** ★ | High | Med | "best-of" intent — write the definitive listicle incl. ourselves |
| 3018 cnc software free ★ | High | Low-Med | "free" qualifier matches our price |
| grbl control software ★ | High | Med | Broad; pair w/ "no install" copy |
| how to use 3018 cnc | Med | Low | Tutorial/YouTube funnel |
| 3018 pro software download | Med | Med | Intercept download intent → "no download needed" |
| cnc gcode sender free | High | Med | Core category term |
| 3018 cnc mac software | Med | **Low** | Underserved — Candle/LaserGRBL are Windows; we win Mac |
| run cnc from phone / control cnc with phone | Med | Low | Our mobile angle |

### B. Solution-aware (they know they want a browser/web sender)
| Keyword | Intent | Est. competition | Notes |
|---|---|---|---|
| **browser cnc gcode sender** ★ | High | **Very low** | Our exact category — own it |
| **web based grbl control / web grbl sender** ★ | High | **Very low** | Direct match; cheap ads |
| web serial cnc / cnc in browser | Med | Very low | Tech-savvy makers |
| online gcode sender no install | Med | Very low | Long-tail, high-converting |
| cnc software no download | Med | Low | Matches the wedge |
| browser laser engraver software | Med | Low | Laser sub-segment |

### C. Comparison / alternative (high commercial intent)
| Keyword | Intent | Est. competition | Notes |
|---|---|---|---|
| **candle alternative / candle cnc alternative** ★ | High | Low | AlternativeTo lists Candle alternatives — get karmyogi listed there ([alternativeto](https://alternativeto.net/software/candle/)) |
| ugs alternative / cncjs alternative | High | Low | Write comparison pages for each |
| gsender vs cncjs vs ugs | High | Med | High-traffic comparison query ([cncrouterinfo](https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/)) — insert karmyogi |
| candle vs ugs | High | Med | |
| free lightburn alternative | Med | Med | Cautious — position as "free all-rounder," not laser-superior |
| cncjs without raspberry pi | Med | **Very low** | Bullseye long-tail — ranks easily, converts |

### D. Capability / job-to-be-done (CAM funnel)
| Keyword | Intent | Notes |
|---|---|---|
| dxf to gcode online ★ | High | Strong standalone tool page → upsell to full app |
| stl to gcode cnc / 3d relief carving software | Med | Our 3D STL → relief capability |
| pcb isolation routing software free | Med | PCB mode landing page |
| pen plotter gcode / signature gcode | Low-Med | Writing mode niche |
| gerber to gcode | Med | PCB funnel |

### E. Brand (defend + capture)
| Keyword | Notes |
|---|---|
| karmyogi / karmyogi cnc | Own it day one (cheap brand defense ad) |
| hjlabs cnc | Brand |

**Priority ladder for paid + SEO:** B and C first (cheapest, highest-intent, uncontested) → then A head terms for reach → D as content/tool magnets → E always-on brand defense.

---

## 4. Channels & campaigns (ranked by ROI for a bootstrapped budget)

### Rank 1 — YouTube (demo + tutorials + creator seeding) — *highest ROI*
The 3018 audience learns on YouTube; "unboxing through designs and upgrades" playlists are how owners onboard ([feedspot CNC channels](https://videos.feedspot.com/cnc_youtube_channels/)).
- **Own channel:** A flagship 60–90s "open browser → connect 3018 → cut" hero film (the ad creative). Then a tutorial series: *First cut on a 3018 in the browser*, *DXF → carve*, *Turn your 3018 into a pen plotter*, *Laser module setup*, *Jog from your phone*, *PCB isolation routing*. Each video titled for an SEO keyword from §3.
- **Creator seeding (cheap, high trust):** Send a short brief + free "pin this comment" link to mid-tier 3018/hobby-CNC YouTubers (the niche ones reviewing 3018/FoxAlien/TwoTrees machines, not TITANS/NYC CNC who are pro-machinist). Offer: featured in a "best free 3018 software 2026" segment. Start with 5–10 micro-creators (5k–100k subs) at $50–$300/integration or free-for-honest-review. Far cheaper and higher-converting than display.

### Rank 2 — SEO / content (compounding, free)
Own the comparison and category terms nobody else fights for.
- **Cornerstone pages:** `/3018-cnc-software`, `/candle-alternative`, `/cncjs-without-raspberry-pi`, `/browser-grbl-sender`, `/dxf-to-gcode-online`, one per priority keyword.
- **The honest comparison post:** "gSender vs UGS vs cncjs vs karmyogi (2026)" — mirror the format of the page already ranking ([cncrouterinfo](https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/)) and earn the click by being the only browser-native, no-install option.
- **Get listed:** Submit karmyogi to AlternativeTo under Candle, UGS, cncjs, OpenBuilds CONTROL alternative pages ([alternativeto](https://alternativeto.net/software/candle/)); to "best free CNC software" roundups (cncsourced, all3dp, tyvok, twotrees blogs) — email the authors with a one-paragraph pitch + GIF.
- **Free tool magnets:** standalone "DXF→G-code" and "Gerber→G-code" mini-tools that rank and funnel into the full app.

### Rank 3 — Reddit + Maker forums (free, where the audience lives)
Genmitsu notes "tens of thousands of active users across Facebook groups and Reddit such as r/hobbycnc" ([sainsmart](https://www.sainsmart.com/products/sainsmart-genmitsu-cnc-router-3018-pro-diy-kit)).
- **Subreddits:** r/hobbycnc, r/CNC, r/SainSmart, r/Maslowcnc, r/engraving, r/diylasers, r/PrintedCircuitBoards (for PCB mode), r/somethingimade (show-off cuts).
- **Approach:** No spam. Be a helpful regular for 2–3 weeks first, then post a genuine "I built a browser-based GRBL controller, no install — feedback wanted" Show-and-Tell with a GIF. Reddit rewards authenticity and punishes ads.
- **Forums:** OpenBuilds forum, Maker Forums (forum.makerforums.info), CNCzone, Sainsmart/Genmitsu community.

### Rank 4 — Facebook Groups (free, huge 3018 owner density)
Join and engage: "Genmitsu/Sainsmart 3018 CNC Owners", "CNC 3018", "Hobby CNC", "3018 PROVer Users", "GRBL CNC", FoxAlien/TwoTrees/Comgrow owner groups. Share helpful answers + occasional demo GIF. Pin a "free browser tool" comment when someone asks "what software should I use?" (a question asked daily).

### Rank 5 — Launch moments (spikes of free traffic + backlinks)
- **Product Hunt** launch: positioning "Control your CNC from a browser tab." Maker/dev-tool audience loves Web Serial novelty. Rally an upvote network beforehand.
- **Hacker News** "Show HN: Browser-based CNC controller using the Web Serial API (no install)." The Web Serial / no-server angle is catnip for HN. One front-page hit = thousands of qualified makers + permanent backlink.
- **Hackaday tip line** ("we built a browser CNC workbench") — Hackaday loves Web Serial maker projects and drives the exact audience.

### Rank 6 — Google Search Ads (paid, but cheap on our long-tail)
Because incumbents barely bid here, CPCs on category/comparison terms should be low. Start tight on highest-intent groups, expand on what converts.

**Ad groups + sample copy** (Responsive Search Ads; headlines ≤30 chars, descriptions ≤90):

*Ad group 1 — Browser/no-install (exact + phrase: browser cnc gcode sender, web grbl control, online gcode sender no install, cncjs without raspberry pi)*
- H: "CNC Control in Your Browser"
- H: "No Install. No Raspberry Pi."
- H: "Free Web GRBL Sender"
- D: "Plug in your GRBL CNC and cut — right from Chrome. No download, no server. Free."
- D: "DXF/STL → 3D toolpaths → G-code. Carve, laser, PCB. Works on desktop & phone."

*Ad group 2 — 3018-specific (3018 cnc software, best software for 3018 cnc, 3018 cnc software free, 3018 mac software)*
- H: "Software for Your 3018 CNC"
- H: "Runs in Chrome — No Install"
- H: "Free & Works on Mac Too"
- D: "Control, CAD & CAM for the 3018 in one browser tab. Carving, laser, pen, PCB. Free."

*Ad group 3 — Alternatives (candle alternative, ugs alternative, cncjs alternative)*
- H: "A Modern Candle Alternative"
- H: "No Download. 3D. Mobile."
- D: "Candle, reborn in your browser — with 3D toolpaths, real CAM, and phone control. Free."

*Ad group 4 — Brand defense (karmyogi)* — always-on, pennies.

**Budget tiers (Search):**
- **Low / test:** $5–$10/day (~$150–$300/mo), groups 1+3+4 only, exact/phrase match, conversion = "first Connect" event.
- **Medium / scale:** $20–$40/day (~$600–$1,200/mo), add group 2 + retargeting, broaden winners.

### Rank 7 — Retargeting (low spend, high efficiency)
Pixel visitors who didn't connect; serve a 15s "see your first cut" demo on YouTube + Google Display. Keep <$5/day; this recaptures the install-hesitant.

### Rank 8 — Chrome Web Store / PWA distribution
List the installable PWA. Capture "cnc app" store searches and gain an install surface without a real install. Cross-link from landing page ("Add to home screen / install as app").

### Rank 9 — GitHub / maker ecosystem
A public repo or prominent "built in the open" page earns dev trust + backlinks; submit to awesome-cnc / awesome-grbl lists; answer GRBL questions on Stack Overflow / forums with a link in the profile.

---

## 5. Funnel: acquisition → activation → retention → feedback/referral

```
ACQUISITION → ACTIVATION → RETENTION → FEEDBACK/REFERRAL
 (get them    (first Connect (they come    (they tell others
  to the URL)   + first cut)   back & rely)   + shape the product)
```

### Acquisition
- **Sources:** YouTube demos, SEO comparison pages, Reddit/FB posts, Search Ads, PH/HN launch.
- **Landing page job:** in 5 seconds prove "browser, no install, free, does my 3018." Above the fold: hero GIF (plug→connect→cut), a single **"Connect your machine"** CTA, a "Works in Chrome & Edge" honesty line, and a "Try the demo (no machine needed)" button using the built-in **mock serial device** so visitors without hardware still activate.
- **Metrics:** unique visitors, source attribution, landing→"Connect clicked" rate, demo-mode starts.

### Activation (the make-or-break step)
Define two activation events:
1. **A1 — First successful Connect** (real device or mock).
2. **A2 — First toolpath generated or first G-code streamed** (the "aha").
- **Onboarding:** a 3-step inline coachmark — (1) pick firmware (GRBL/FluidNC/grblHAL/Marlin…), (2) Connect, (3) jog or load a sample DXF. Ship a one-click **"Load sample 3018 project"** so a new user reaches A2 in under 2 minutes.
- **Metrics:** visitor→A1 rate (target ≥25% of non-bounce), A1→A2 rate (target ≥50%), time-to-A1, time-to-A2, top drop-off step.

### Retention
- **Hooks:** saved projects/layout persistence (already built), recent files, per-machine profiles, offline PWA so it works in a garage with flaky wifi.
- **Touchpoints:** opt-in email on first save ("we'll only ping you about new modes & tips"); changelog/"what's new" toast on return; optional push for PWA users.
- **Metrics:** D7 / D30 return rate, weekly active machines connected, sessions/user, projects saved.

### Feedback / referral
- **In-app feedback widget (core loop):** a persistent "Report bug / Request feature 💡" button → short form (auto-attaches firmware, browser, last error) → your tracker. Publicly visible roadmap/changelog so users see their requests shipped — this converts users into evangelists and is your cheapest product-research channel.
- **Referral:** "Made something cool? Share it" — one-click share of a screenshot/GIF of the 3D toolpath or finished cut, watermarked `karmyogi.hjlabs.in`, sized for Reddit/r/somethingimade and FB groups. Each share is free top-of-funnel.
- **Reviews:** prompt happy users (those who hit A2 + returned) to drop karmyogi on AlternativeTo and in "best 3018 software" comment threads.
- **Metrics:** feedback submissions/week, feature-request→ship cycle, shares generated, referral-attributed visits, review/mention count.

### Email / notification touchpoints (lean)
1. Welcome + "finish your first cut" (on first save/opt-in).
2. Re-engagement at D3 if A2 not reached ("stuck? here's a 90s video").
3. Monthly "what's new" (new firmware support, new mode).
4. PWA push (optional): job-done notifications, new-feature pings.

---

## 6. 30/60/90-day action plan

### Foundations (Week 0 — before spend)
- Instrument analytics + events: visitor, Connect-clicked, **A1 Connect**, **A2 toolpath/stream**, save, return, feedback, share. (Privacy-light, e.g. Plausible/PostHog.)
- Ship: hero GIF landing page, "Try demo (mock device)" button, 3-step onboarding, "Load sample 3018 project", in-app feedback widget + public changelog, social-share/watermark.
- Set up Google Ads account, conversion = A1; Search Console + the cornerstone SEO pages; YouTube channel; Reddit & 6–8 FB group accounts (start aging them now).

### Days 1–30 — Launch & seed (mostly free)
- **Wk1:** Publish hero demo video + 3 tutorials (first cut / DXF→carve / phone jog). Publish cornerstone pages: `/3018-cnc-software`, `/candle-alternative`, `/cncjs-without-raspberry-pi`, `/browser-grbl-sender`. Submit to AlternativeTo (Candle/UGS/cncjs).
- **Wk2:** **Show HN** + **Hackaday tip** + **Product Hunt** launch (stagger across the week). Be on-thread all day answering.
- **Wk3:** Start being genuinely helpful in r/hobbycnc, r/SainSmart, r/CNC and 3018 FB groups (answer Qs, no hard sell yet). Email 5 "best free CNC software" authors with pitch + GIF for inclusion.
- **Wk4:** First Show-and-Tell post in r/hobbycnc + 2 FB groups. Launch **Google Search Ads at $5–$10/day** (groups 1+3+4). Reach out to first 5 micro-YouTubers.
- **Targets:** 5k–15k visitors, ≥1,000 A1 connects, ≥400 A2, 1 launch front-page or roundup inclusion, baseline CPC + A1-conversion data.

### Days 31–60 — Optimize & scale what works
- Double down on the 2–3 ad groups/keywords with lowest cost-per-A1; pause losers. Raise budget toward **$20–$40/day** only on proven groups.
- Publish 4 more tutorials (laser module, PCB isolation, pen plotter, STL relief) + "gSender vs UGS vs cncjs vs karmyogi" comparison post.
- Ship 2–3 top community-requested features from the feedback widget; announce each in the groups where it was requested (closes the loop publicly).
- Land 3–5 YouTube creator integrations. Turn on retargeting ($3–$5/day).
- **Targets:** 20k–40k cumulative visitors, ≥3,000 A1, ≥1,200 A2, D7 retention ≥20%, cost-per-A1 trending down, ≥50 feedback submissions, ≥20 user shares.

### Days 61–90 — Establish category ownership
- SEO pages should start ranking for B/C terms (browser grbl sender / candle alternative / cncjs without raspberry pi) — refresh and interlink.
- Run a small "show us your cut" community contest in FB/Reddit (prize = a 3018 accessory bundle) to flood referral shares.
- Pursue inclusion in major roundups (cncsourced, all3dp, tyvok, twotrees) — by now there's social proof to cite.
- Scale paid only if cost-per-A2 is sustainable; expand to head term "3018 cnc software" (group 2).
- **Targets:** 50k–100k cumulative visitors, ≥7,500 A1, ≥3,500 A2, D30 retention ≥12%, named in ≥3 "best 3018 software" articles, organic > paid as top acquisition source.

### Lean monthly budget (bootstrapped)
| Line item | Low (~$300/mo) | Medium (~$1,000/mo) |
|---|---|---|
| Google Search Ads | $150 ($5/day) | $700 ($23/day) |
| Retargeting | $0 | $100 |
| YouTube creator seeding | $50–$100 (1 micro) | $150–$250 (2–3 micro) |
| Tools (analytics, design assets) | $0–$30 (free tiers) | $50 |
| Contest/prize (one-off, day 61–90) | — | ~$100 amortized |
| **Everything else (SEO, Reddit, FB, HN/PH, forums)** | **$0 — time only** | $0 — time only |

### North-star + KPI dashboard
- **North star:** weekly **A2 events** (first toolpath/stream) — real usage, not vanity traffic.
- **Acquisition:** visitors, source mix, CPC, cost-per-A1.
- **Activation:** visitor→A1 (≥25%), A1→A2 (≥50%), time-to-A2 (<3 min).
- **Retention:** D7 (≥20%), D30 (≥12%), weekly active connected machines.
- **Advocacy:** feedback subs/wk, features shipped from feedback, shares, referral visits, roundup/AlternativeTo mentions.
- **Success at day 90:** karmyogi appears in the "best 3018 / GRBL software" conversation organically, organic surpasses paid as #1 source, and there's a steady weekly A2 + feedback flow proving product-market fit in the 3018 niche.

---

## Sources
- gSender vs UGS vs cncjs comparison — https://cncrouterinfo.com/guides/gsender-vs-ugs-vs-cncjs/
- Best 3018 CNC software (Candle, UGS, LaserGRBL, bCNC) — https://www.cncsourced.com/rankings/best-3018-cnc-software/
- 15 best free CNC software — https://www.cncsourced.com/software/best-free-cnc-software-control-cad-cam/
- Best GRBL software 2025 (Candle/UGS) — https://tyvok.com/blogs/news/best-grbl-software-2025-ugs-candle
- Free CNC software incl. Carbide Create/Easel/Fusion pricing — https://carbide3d.com/learn/free-cnc-software/
- LightBurn pricing — https://monportlaser.com/blogs/software/understanding-lightburn-software-features-and-pricing-guide
- Candle alternatives (AlternativeTo) — https://alternativeto.net/software/candle/
- OpenBuilds CONTROL alternatives — https://alternativeto.net/software/openbuilds-control/
- gSender overview/features — https://sienci.com/gsender/ ; https://github.com/Sienci-Labs/gsender
- cncjs (web, Node.js/Pi requirement) — https://cnc.js.org/ ; https://github.com/cncjs/cncjs/wiki/FAQ
- grblweb (self-hosted Node.js) — https://github.com/andrewhodel/grblweb
- Genmitsu 3018-PRO + community (Reddit r/hobbycnc, FB groups) — https://www.sainsmart.com/products/sainsmart-genmitsu-cnc-router-3018-pro-diy-kit
- CNC YouTube channels landscape — https://videos.feedspot.com/cnc_youtube_channels/
