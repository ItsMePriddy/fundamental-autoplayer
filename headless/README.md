# Headless Fundamental harness

Runs the **real** Fundamental game logic in Node (no browser) so the autoplayer's
policies can be tuned against ground truth with timewarp — a 4-hour playthrough
simulates in well under a second.

## How it works
`build.sh` clones the game, guards only its browser "Start everything" boot block
behind a `__HEADLESS__` flag (keeping all state init + exports), and compiles the
TypeScript to CommonJS in `./build`. `_globals.js` stubs the browser globals
(`document`, `localStorage`, …) before the modules load. `engine.js` then:
1. requires the compiled `Main`/`Player`/`Stage`/`Update`,
2. runs the real new-game init (`prepareVacuum(false)` + `updatePlayer(...)`),
3. drives play via the real `timeUpdate(step, step)` + `buyBuilding`/`buyUpgrades`/
   `vaporizationResetUser`/etc., exactly as the userscript does through the DOM.

## Run
```
./build.sh           # one-time (clones + compiles game)
node sweep.js        # time-to-target sweep over vaporize thresholds
node optimize.js     # clouds-after-fixed-duration comparison
```

## Key finding (Submerged / vaporization timing)
Optimizing time-to-cloud-target across policies:
- **Fixed boost ~2.25 is optimal**, and the curve is **flat across 2–3** (<6% spread).
  High thresholds (5/10/30) are slower (too few resets); <2 is slower (too many).
- The **adaptive `ln(boost)/elapsed` rule underperforms badly** for Submerged: the
  large cloud divisor + effect softcap make boost crawl, so the ratio peaks at a
  worthless ~1.05 and it fires hundreds of tiny resets. Removed as the default.
- Time-to-target is dominated by the initial grind to ~1e10 drops (the cloud cost
  divisor), so vaporize timing is a second-order effect here.

The userscript therefore uses `vaporizeMode:'fixed'`, `vaporizeBoost:2.25`.
