# I rebuilt my desktop CNC software in the browser. Meet karmyogi — an open-source CAD/CAM + control workbench for 3018-class GRBL machines.

## One Chrome tab now runs my whole CNC bench: 3D carving, pen-plotting, PCB isolation routing, auto-soldering, and a live 3D visualizer — no install, desktop and phone.

> [PLACE IMAGE 1 HERE — hero banner: `linkedin-images/karmyogi-hero.png`]

If you own a CNC 3018, you already know the ritual.

You bought a sub-$300 desktop router to engrave, mill PCBs, and carve wood. Then you spent your weekends fighting the *software* instead of making chips. One clunky Windows sender to stream G-code. A separate CAM tool to generate it. A third app for PCB isolation. A driver that breaks after a Windows update. None of them talk to each other, half of them haven't shipped a release since 2019, and exactly zero of them open on your phone.

I lived this for years. So I built the thing I wanted.

**karmyogi** is a browser-based control + CAD/CAM workbench for hobby and desktop 3-axis GRBL machines. It runs entirely in a Chrome tab, talks to your machine's GRBL controller over USB using the **Web Serial API**, visualizes your toolpaths and bed in **3D**, and gives you a fully dockable, floatable, resizable panel UI — on desktop *and* mobile.

It's open source. It's free. There is nothing to install.

- Live app: **https://karmyogi.hjlabs.in**
- Source on GitHub: **https://github.com/hemangjoshi37a/karmyogi**

---

## The problem: desktop CNC software is stuck in 2015

The 3018-class machine is one of the best on-ramps into real CNC work. A [CNC 3018 Pro Max](https://roboticsdna.in/product/cnc-3018-pro-max-3-axis-desktop-diy-mini-wood-router-kit-pcb-pvc-milling-engraver/) gives you a ~300 x 180 x 45 mm work area, a GRBL 1.1 controller over USB, and an ER11 collet that handles wood, acrylic, PVC, PCB copper, and soft aluminum — for the price of a decent mechanical keyboard. These things are everywhere, from classrooms to hackerspaces to my own desk.

The hardware is open and cheap. The software around it is the opposite.

Here's what the typical 3018 workflow looks like today:

- **Candle / UGS / GRBLControl** to jog the machine and stream G-code. Desktop installers, Windows-first, dated UIs.
- **A separate CAM package** (Easel, Carbide Create, or a Fusion post) to turn a drawing into toolpaths.
- **FlatCAM** for PCB isolation routing — a brilliant tool that is also a Python dependency nightmare.
- **Yet another utility** for pen-plotting or soldering, if it exists at all.

Four apps. Four mental models. Four installers. And none of it runs on the tablet sitting next to the machine.

I know this stack intimately because I wrote a desktop sender myself — a Qt/C++ app, a fork I called `hjLabs.in_Candle`. It had a complete, unit-tested CAD/CAM core and the full feature set. It worked. But Qt Widgets made a modern dockable, resizable UI genuinely painful to build, and iterating on it was slow. Every layout tweak was a fight.

So I made a bet: **the browser is now a better CNC platform than the desktop.** Web Serial talks to the GRBL board directly. Docking and resizing are solved problems on the web. 3D is one `npm install` away. And hosting is a static file drop.

karmyogi is that bet, shipped.

---

## What karmyogi actually does

It's not "a G-code sender with extra tabs." It's a full workbench where each capability is a dockable panel, and they all share one machine connection, one 3D view, and one program.

> [PLACE IMAGE 2 HERE — feature collage concept: `linkedin-images/karmyogi-features.png`]

### Control — the parts you use every session

- **Jog / DRO controller** — per-axis work and machine position, press-and-hold continuous jog, step sizes, home, unlock, soft reset, and feed/rapid/spindle override sliders. I borrowed the layout from cncjs and made every target touch-friendly.
- **Console** — a WhatsApp-style chat log of everything you send and everything GRBL says back, with an MDI input and saved macros.
- **GRBL settings manager** — every `$`-setting, grouped (steppers, limits & homing, spindle/laser, steps-per-mm, max rate, acceleration, max travel), each one described with units. It validates ranges and flags EEPROM corruption — the real failure mode where a garbage `$110` throws `error:15` on every jog. One-click factory reset (`$RST=$`/`#`/`*`) with confirms.
- **Live 3D visualizer** — your toolpath and bed rendered with three.js, rapids and cuts colored differently, with a tool marker that tracks position. Fit, iso, top, and front views.

### CAM — turn ideas into safe G-code, in the browser

- **3D carving** — import DXF (and STL), then generate **engrave / profile (on/inside/outside) / pocket** operations with multi-depth passes and a live preview before you cut.
- **Pen-plotter writing** — type text, pick a single-stroke (Hershey) vector font, and get clean pen G-code. Load your own handwriting as a custom single-stroke font JSON.
- **PCB isolation routing** — drop in a **Gerber ZIP** plus Excellon drill files and get isolation routing, drilling, and board cutout as staged programs. The FlatCAM workflow, minus the dependency hell, in a browser tab.
- **Auto-soldering** — an editable points table (X / Y / Free-Z travel / Touch-Z touch-down / feed type / feed time) that repurposes the spindle output as a **solder-wire feeder** (M3 / G4 / M5). Record positions straight from the live machine.

### And the experimental bench

I'm actively expanding the workbench into glue dispensing, pick & place, signature-to-G-code, 3D printing/slicing, and a camera/timelapse panel so you can watch and record long jobs. The architecture makes adding a new mode a new *panel* — not a new *app*.

The throughline: **every panel emits or consumes the same safe G-code and feeds the same 3D view.** One mental model, top to bottom.

---

## Safety isn't an afterthought

A pen plotter and a solder-wire feeder have very different Z semantics than a spindle. Get it wrong and you snap an endmill or drag a pen tip across finished work.

karmyogi's G-code emitter is a line-for-line port of the Qt core I've been running on my own machine for years. It always emits `G21 G90 G94 G17`, guarantees a **safe-Z retract** before any XY travel and at program end, uses conservative default feeds, and switches Z and spindle behavior by mode (Spindle / Pen / Feeder). It even refuses to emit `-0.000`. The boring safety details are exactly the ones that save your hardware.

---

## The tech, for the engineers reading this

> [PLACE IMAGE 3 HERE — "browser to machine" concept: `linkedin-images/karmyogi-browser-to-machine.png`]

karmyogi is a static single-page app. No backend, no socket server, no Node daemon between you and your machine — your browser talks to the GRBL board directly.

- **Vite + React 19 + TypeScript** (strict). One concern per file, small modules.
- **three.js via @react-three/fiber + drei** for the 3D viewport.
- **dockview** for the dockable / floatable / resizable panel layout — the exact thing that was painful in Qt is a built-in here.
- **zustand** for state (machine, program, settings, layout, theme).
- **Web Serial API** (`navigator.serial`) for GRBL comms — character-counting flow control against GRBL's 127-byte RX buffer, realtime bytes (`?` `!` `~` `0x18`), and `<...>` status parsing at ~5-10 Hz.
- A pure, UI-independent **CAD/CAM core** (`src/core/`) with no DOM or React imports — a direct TypeScript port of the Qt `cadcam` library.
- A **mock serial device**, so the whole app is fully usable — and testable — without any hardware plugged in.
- Hosted as a static SPA on **Cloudflare**. PWA / offline support included.

Two honest constraints, up front: **Web Serial is Chromium-only** (Chrome, Edge, Brave, Opera — not Firefox or Safari) and needs HTTPS or localhost plus a user click to grant the port. That's a browser limitation, not a karmyogi one, and it's a fair trade for zero-install.

And yes — the whole thing is responsive. The dockview shell drives desktop. At phone widths it falls back to a stacked, tabbed layout showing the *same* panel content, so the tablet next to your machine and the laptop on your desk are the same tool, not two divergent ones.

---

## Why I made it open source

The 3018 ecosystem handed me an affordable machine running open firmware — GRBL on an Arduino. Every layer beneath the software was already open. It felt wrong to wrap a paywall around the last one.

So the desktop Qt app stays a private reference, and the web version goes to everyone. The architecture is built for it: each capability is one self-contained panel, and the CAD/CAM core is pure TypeScript with zero UI dependencies. Want to add a machine profile, fix a Gerber aperture edge case, or wire up a new CAM mode? You change one file, not the whole app. The repo is right there. PRs welcome.

---

## Try it — it opens in the tab you already have open

If you've got a 3018 or any 3-axis GRBL machine, plug it in, open Chrome, and connect. If you don't have hardware handy, the mock device lets you drive the entire app and watch the 3D visualizer right now.

![karmyogi — run your CNC from the browser](linkedin-images/karmyogi-cta.png)
> [IMAGE 4 — closing CTA / logo lockup: `docs/linkedin-images/karmyogi-cta.png`]

- Open the live app: **https://karmyogi.hjlabs.in**
- Star / fork / contribute on GitHub: **https://github.com/hemangjoshi37a/karmyogi**
- More of what I build: **https://hjLabs.in**

If you try it on your machine, tell me what broke and what you'd want next. I'm building this in the open and I read everything.

— Hemang Joshi, hjLabs.in

---

HASHTAGS: #CNC #GRBL #CADCAM #WebSerial #OpenSource #3DPrinting #Maker #CNCRouter #3018 #PCB #DIYElectronics #React #ThreeJS #TypeScript #Manufacturing
