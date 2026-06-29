// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.12.11
// @description  Automatically plays awWhy's "Fundamental" idle game by driving its DOM controls: buys all structures/upgrades/strangeness, performs resets when ready, and enables the game's own automation + auto-stage switching.
// @author       ItsMePriddy
// @match        https://awwhy.github.io/Fundamental/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js
// @downloadURL  https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js
// ==/UserScript==

/*
 * HOW IT WORKS
 * ------------
 * The game (Fundamental v0.2.9) is shipped as a single non-module IIFE bundle
 * (Code.js), so none of its internals (player state, buyBuilding, timeUpdate...)
 * are reachable from the page's global scope. Everything here is therefore done
 * by clicking the game's real DOM buttons, whose IDs are stable across the UI.
 *
 * The game clock freezes in hidden/background tabs, so the bot marks the HUD as
 * paused and skips game actions until the tab is visible again.
 *
 * Strategy:
 *   1. One-time-ish setup (re-checked cheaply every tick, only acts when needed):
 *        - set every confirmation toggle (toggleConfirm0..7) to "None" so resets
 *          never pop a blocking dialog,
 *        - turn ON the game's own automation (toggleAll, toggleAuto0..11,
 *          toggleVerse0) and auto-stage-switch (toggleNormal0). These do nothing
 *          until the matching "strangeness" upgrades are bought, at which point the
 *          game auto-runs that part for us optimally.
 *   2. Every tick:
 *        - buy all structures        -> #makeAllFooter
 *        - buy all upgrades/research -> #createAllFooter
 *        - buy all strangeness       -> #createAllStrangeness
 *        - discharge / vaporize / .. -> #reset0Button (when ready)
 *   3. On a slower cadence: attempt stage reset (#reset1Button) and end reset
 *      (#reset2Button) when their button text says they're ready.
 *   4. Auto-accept the "offline time" dialog that pops up whenever the tab
 *      regains focus, so it never blocks unattended play.
 *
 * Readiness is read from button text because these reset buttons are never marked
 * .disabled — when not ready they read "Next goal is ...", "Requires ...", etc.
 *
 * IMPORTANT — keep the tab in the FOREGROUND:
 *   Like most idle games, Fundamental advances production on requestAnimationFrame,
 *   which the browser FREEZES while the tab is hidden/backgrounded. The bot now
 *   pauses its actions and shows "paused - tab hidden" in the HUD until visible.
 *   For continuous play, leave the game in its own focused window/tab. Brief
 *   switches are fine — on return the game grants "offline time" (auto-accepted here).
 */

(function () {
    'use strict';

    // Extract the bot version from the @version userscript header at runtime
    // so bumping the header tag automatically updates the HUD, console log,
    // and cache-busted install URL. With @grant none, Tampermonkey injects this
    // userscript as a <script> element whose textContent is the full source.
    const BOT_VERSION = (function extractVersion() {
        try {
            var cs = document.currentScript;
            if (cs && cs.textContent) {
                var m = cs.textContent.match(/@version\s+([\d.]+)/);
                if (m) return m[1];
            }
        } catch (e) { /* fall through to hardcoded fallback */ }
        // Fallback — keep in sync with @version; used only when extraction fails.
        return '1.12.11';
    })();
    const UPDATE_URL = 'https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js';

    // ---- Config ---------------------------------------------------------------
    const CONFIG = {
        tickMs: 250,            // main loop interval
        slowResetEveryMs: 8000, // how often to attempt stage/end resets
        autoStart: true,        // start playing on load
        enableGameAutomation: true, // flip the game's own auto toggles ON
        setConfirmNone: true,   // set confirmation prompts to "None"
        doStageReset: true,     // attempt #reset1Button (stage reset) when ready
        doEndReset: true,       // attempt #reset2Button (end reset) when ready
        vaporizeMode: 'fixed',  // stage 2 timing. 'fixed' is recommended: a headless full-game
                                // simulation of Submerged shows fixed boost ~2.25 is optimal and
                                // the curve is flat across 2-3 (time-to-target varies <6%).
                                // 'adaptive' is NOT recommended for Submerged — validated to
                                // underperform badly there (the cloud divisor + effect softcap
                                // make ln(boost)/elapsed peak at a worthless ~1.05, causing
                                // hundreds of tiny resets). Kept only for experimentation.
        vaporizeBoost: 2.25,    // 'fixed' mode: vaporize when the production boost reaches this
                                // multiple. ~2.25 was the empirical optimum for Submerged; the
                                // game's default of 2 is essentially as good. Higher (5+) is
                                // slower (too few resets).
        vaporizeMinBoost: 1.5,  // adaptive only: never fire below this boost.
        vaporizePeakDrop: 0.05, // adaptive only: fire once ln(boost)/elapsed drops this fraction
                                // below its running max.
        logCycles: true,        // record each vaporization cycle for tuning/validation.
                                // Inspect via window.FundamentalBot.report().
        logCollapses: true,     // record every observed Stage 4 collapse for diagnosis.
                                // Inspect via window.FundamentalBot.collapseReport().
        highStageResets: false, // stage 6 (nucleation) is a major prestige reset. Leave false to
                                // let the GAME's auto-resets handle it. (Stages 4/5 — collapse and
                                // merge — have their own dedicated boost-gated logic below.)
        mergeBoost: 2,          // stage 5 (Intergalactic): merge when #mergeBoostTotal reaches this
                                // multiple. The boost is the multiplicative gain of merging now
                                // ((galaxies/(merged+1)+1)·rewardRatio). The game HARD-CAPS merges
                                // (mergeMaxResets ≈ 2 early) and requires ≥22 galaxies — both
                                // enforced on reset0Button (resetReady() gates them) — so a boost
                                // gate can't over-merge; it just times the few merges available.
                                // Self-disables once strangeness[5][9]≥2: the game then auto-merges
                                // and hides #mergeBoostTotal, so the bot defers to it.
        mergeMaxWaitMs: 120000, // anti-hang: also merge after this long once actionable, in case
                                // the boost reads modest but galaxies are capped on available mass.
        mergeMinBoost: 1.2,     // floor for the anti-hang merge — don't fire a worthless one.
        holdStage5WhenActionable: true, // don't stage-reset out of Intergalactic while Galaxy/Merge
                                // work is visible. Early Stage 5 can be mostly locked; in that case
                                // resetting to farm quarks is still correct. Once Galaxies/Merges
                                // are real, holding preserves compounding Stage 5 progress.
        stage5HoldMaxMs: 1200000, // absolute safety net: release hold after 20 min no matter what.
                                // Only reached when the merge gate and grace period somehow don't
                                // apply — a last-resort escape hatch.
        stage5HoldGraceMs: 60000, // when merge boost is below the anti-hang floor (1.2×), hold
                                // this long for initial building buy-up after entering the stage,
                                // then release to farm quarks. Quark gain cannot grow meaningfully
                                // without merges (the only significant growth source is
                                // mergeInfo.galaxies+1, which only increments on merge).
        collapseBoost: 2.0,     // stage 4: collapse when the production boost
                                // (#collapseBoostTotal) reaches this multiple — headless
                                // simulations from a real Interstellar save (v1.12 tuning pass)
                                // show the optimum is 1.8-2.0 (was 2.5). The star-gain trigger
                                // below handles most collapses; this boost gate catches the
                                // high-value ones the star trigger might miss during rapid growth.
        collapseMaxWaitMs: 120000, // anti-hang timer: 2 minutes (was 45s). Headless data shows
                                // the anti-hang should be a safety net, not the primary driver.
                                // At 45s it dominated all sweeps, producing 0.055 stars/s;
                                // at 120s with a 1.1× floor, it only catches what the primary
                                // 1.3× ROI trigger missed.
        collapseMinBoost: 1.0,  // floor for the anti-hang collapse — lowered from 1.3 to 1.0 so
                                // the anti-hang can fire even when boost is flatlined (no buildings
                                // purchasable → boost stays 1.0). The game's own collapseResetCheck
                                // still prevents worthless collapses (it rejects when starCheck=0
                                // AND newMass≤currentMass AND no pending elements).
        collapseHardStallMs: 300000, // hard-stall breaker: fire an unconditional collapse after
                                // 5 minutes without ANY collapse, regardless of boost. This breaks
                                // deadlocks where boost is 1.0 and the anti-hang keeps getting
                                // rejected by the game (mass hasn't increased, no stars available).
                                // Even a rejected click keeps the timer running so the breaker
                                // eventually forces a state change through sheer elapsed time.
        collapseOnElement: true, // collapse ASAP when a new element is pending (awaiting activation)
                                // — elements only activate on collapse and their boost isn't in
                                // #collapseBoostTotal, so grabbing them fast is high-ROI.
        collapseElementGapMs: 3000, // min gap between element-triggered collapses (avoids a double
                                // fire during the render lag before the element flips to "created").
        collapseMinGapMs: 2000,  // min gap between star-driven collapses (prevents rapid-fire when
                                // star gains appear in quick succession after a rebuild).
        collapseMassMultiplier: 1.3,
                                // #footerStat2Span is player.collapse.mass: the real banked raw
                                // mass. Collapse at projected/banked >= 1.3×, the headless optimum.
        collapseAntihangMassMin: 1.3,
                                // Anti-hang uses the same raw-mass ratio floor as primary ROI,
                                // so elapsed time can never undercut the intended mass gain.
        autoExport: true,       // stage 5+: periodically click #export to claim Strange-quark
                                // rewards. The save-file download it triggers is suppressed
                                // (no files saved) — only the in-game reward is kept.
        exportEveryMs: 10000,   // 10s. The reward scales with elapsed time (conversion =
                                // min(time/12h, 1)), so total quarks/hour is the SAME at any
                                // cadence below 12h — exporting often just claims them in small
                                // continuous amounts that get reinvested into strangeness right
                                // away instead of sitting idle. (12h only maxes a SINGLE export.)
        smartStrangeness: true, // route the shared strange-quark pool to the CURRENT stage first,
                                // then highest->lowest, instead of the game's stage-1-first dump.
        strangenessTargets: ['strange3Stage5', 'strange4Stage5'],
                                // Critical stage 5 unlocks. Both are also bought
                                // unconditionally before the target loop — listed
                                // here as double insurance.
                                // strange3Stage5 (s5 idx2) = 1.4× quark multiplier
                                //   (max lvl 2, costs 4+16=20 quarks). Compounds ALL
                                //   future quark income — highest ROI in the game.
                                // strange4Stage5 (s5 idx3) = Intergalactic collapse
                                //   immunity (cost 24 quarks). Enables auto-upgrade
                                //   in stage 5. Without it, Collapse resets wipe
                                //   Intergalactic progress — it's a gating unlock.
                                // After these two are owned (44 quarks total), the
                                // bot falls through to normal current-stage-first
                                // buying. Do NOT add strange5Stage5 here — it costs
                                // 15,600 quarks and would just timeout-hold uselessly.
                                // Previous targets (strange6Stage4, strange7Stage4)
                                // are both maxed and no longer purchasable.
        strangenessTarget: null, // legacy single-target override; use strangenessTargets above.
        strangenessTargetTimeoutMs: 600000, // stop holding after 10 min if it can't be bought
                                // because it appears locked. Expensive-but-unlocked targets are held
                                // indefinitely; spending around them was slower in seeded tests.
        verbose: false,         // log every action to console
    };

    // Text on a reset button that means "not ready yet".
    const NOT_READY = /requires|next goal|reach|need|self[- ]?made|locked|unlock|to unlock/i;

    // ---- Helpers --------------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    const exists = (id) => $(id) != null;

    const clickIf = (id) => {
        const el = $(id);
        if (el && !el.disabled) { el.click(); return true; }
        return false;
    };

    const textOf = (id) => {
        const el = $(id);
        return el ? (el.textContent || '').trim() : '';
    };

    // Extract the first number from arbitrary text (handles "2.00", "1.50e3",
    // thousands separators, and surrounding words like "Reset for 1.2e4 Clouds").
    const numFromText = (t) => {
        if (!t) return null;
        const m = t.replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
        return m ? parseFloat(m[0]) : null;
    };
    // Parse a number out of a stat element's text. Returns null if absent.
    const readNum = (selector) => {
        const el = document.querySelector(selector);
        return el ? numFromText(el.textContent) : null;
    };

    // Active stage, read from the on-screen stage name (no globals are exposed).
    // Index matches the game's word list in Player.ts.
    const STAGE_WORDS = ['', 'microworld', 'submerged', 'accretion', 'interstellar', 'intergalactic', 'abyss'];
    const activeStage = () => {
        const w = textOf('stageWord').toLowerCase();
        const i = STAGE_WORDS.findIndex((s) => s && w.startsWith(s));
        return i > 0 ? i : 0;
    };

    // A reset/action button is "ready" if it exists, isn't disabled, and its label
    // doesn't read like a requirement message.
    const resetReady = (id) => {
        const el = $(id);
        if (!el || el.disabled) return false;
        const t = (el.textContent || '').trim();
        if (!t) return false;
        return !NOT_READY.test(t);
    };

    // Two-state ON/OFF toggles (text contains "ON" or "OFF"): click to reach ON.
    const setToggleOn = (id) => {
        const el = $(id);
        if (!el) return;
        const t = (el.textContent || '').toUpperCase();
        // Already on if it ends with ON but not OFF.
        if (/\bON\b/.test(t) && !/\bOFF\b/.test(t)) return;
        el.click();
    };

    // Confirmation toggles cycle Safe -> None -> All. Click until it reads "None".
    const setConfirmNone = (id) => {
        const el = $(id);
        if (!el) return;
        for (let i = 0; i < 3; i++) {
            if ((el.textContent || '').trim() === 'None') return;
            el.click();
        }
    };

    const log = (...a) => { if (CONFIG.verbose) console.log('[Fundamental]', ...a); };

    // Rolling event log for the on-screen HUD.
    const eventLog = [];
    const pushLog = (msg) => {
        eventLog.push({ t: Date.now(), msg });
        if (eventLog.length > 60) eventLog.shift();
    };
    const STAGE_NAMES = ['', 'Microworld', 'Submerged', 'Accretion', 'Interstellar', 'Intergalactic', 'Abyss'];
    const fmtDur = (s) => {
        s = Math.max(0, Math.floor(s));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`
                 : `${m}:${String(x).padStart(2, '0')}`;
    };

    // ---- Offline-time dialog --------------------------------------------------
    // On (re)focus the game shows an alert: "Accept and use N seconds worth of
    // Offline time?". It blocks everything until answered. Auto-accept it, but
    // only when it's really the offline prompt (don't blindly confirm other alerts).
    function acceptOfflineDialog() {
        const box = $('alertMain');
        if (!box || getComputedStyle(box).display === 'none') return; // no dialog showing
        const msg = textOf('alertText');
        if (/offline time/i.test(msg)) clickIf('alertConfirm');
    }

    // ---- Setup pass (cheap, idempotent) --------------------------------------
    function applySettings() {
        if (CONFIG.setConfirmNone) {
            for (let i = 0; i <= 7; i++) setConfirmNone('toggleConfirm' + i);
        }
        if (CONFIG.enableGameAutomation) {
            setToggleOn('toggleAll');                 // master building automation
            setToggleOn('toggleVerse0');              // universe automation
            for (let i = 0; i <= 11; i++) setToggleOn('toggleAuto' + i); // discharge/stage/upgrade autos
            setToggleOn('toggleNormal0');             // auto-switch active stage
        }
    }

    // ---- Buying pass ----------------------------------------------------------
    function buyEverything() {
        clickIf('makeAllFooter');       // all structures (active stage)
        clickIf('createAllFooter');     // all upgrades + researches
        if (CONFIG.smartStrangeness) buyStrangenessSmart();
        else clickIf('createAllStrangeness');
    }

    // Strange quarks are a SHARED pool, but the game's "create all strangeness" buys stages
    // 1->6 ASCENDING — draining quarks into low-stage upgrades you're long past before the
    // stage you're actually progressing. Route them by priority instead: current stage first,
    // then highest->lowest (lower stages still get the leftovers). Each click buys max of that
    // upgrade; missing/maxed/locked/unaffordable buttons are harmless no-ops.
    // Per-upgrade ROI: the ONE globally-compounding strangeness is the quark-gain multiplier
    // (stage 5 index 2 -> strange3Stage5: "Gain 1.4x more Strange quarks from any Stage reset"),
    // which multiplies ALL future quark income — buy it before anything else. strange4Stage5
    // (Intergalactic collapse-immunity + enables Upgrade automatization there) is the next key
    // unlock. Everything else is local/automation and is well-served by current-stage-first below.
    // strangenessTargets: upgrades to buy NEXT — the bot HOLDS other strangeness so quarks
    // accumulate for the first unowned target. Default route buys Interstellar Auto Structures
    // before "Elements no longer require Collapse"; seeded tests from a real Submerged save showed
    // that getting stage-4 structures automated first speeds repeated Interstellar pushes. Resumes
    // normal buying once targets are owned. A timeout only releases a target if it appears locked;
    // expensive-but-unlocked route targets are worth saving for. The quark-gain multiplier is always
    // pursued.
    let strangeTargetStart = 0;
    function strangeUnowned(id) {
        const m = textOf(id).match(/(\d[\d.eE+]*)\s*\/\s*(\d[\d.eE+]*)/);
        return m ? parseFloat(m[1]) < parseFloat(m[2]) : false; // unparseable/maxed -> treat as owned
    }
    function currentStrangenessTarget() {
        const targets = Array.isArray(CONFIG.strangenessTargets) && CONFIG.strangenessTargets.length
            ? CONFIG.strangenessTargets
            : (CONFIG.strangenessTarget ? [CONFIG.strangenessTarget] : []);
        return targets.find((id) => $(id) && strangeUnowned(id)) || null;
    }
    function buyStrangenessSmart() {
        clickIf('strange3Stage5'); // highest-ROI quark-gain multiplier — always pursue (compounds income)
        const target = currentStrangenessTarget();
        if (target) {
            if (!strangeTargetStart) strangeTargetStart = Date.now();
            clickIf(target); // buy it the instant quarks allow
            const targetText = textOf(target);
            const looksLocked = /locked|unlock|requires|reach|need/i.test(targetText);
            if (!looksLocked || Date.now() - strangeTargetStart <= CONFIG.strangenessTargetTimeoutMs) return; // hold the rest
        } else { strangeTargetStart = 0; }
        clickIf('strange4Stage5'); // Intergalactic collapse-immunity / enables auto-upgrade there
        const cur = activeStage();
        const order = [cur];
        for (let s = 6; s >= 1; s--) if (s !== cur) order.push(s);
        for (const s of order) for (let i = 1; i <= 10; i++) clickIf('strange' + i + 'Stage' + s);
    }

    // ---- Vaporization timing (stage 2) ---------------------------------------
    // Vaporizing wipes the whole stage-2 engine, so each reset has a real rebuild
    // cost. Fastest stage completion = maximize the growth rate of the production
    // multiplier, i.e. maximize ln(boost)/T_cycle (a renewal-reward problem). The
    // optimum is the stopping rule: fire when ln(boost)/elapsed peaks. This self-
    // tunes to the actual ramp and the 1e4 cloud softcap with no magic constant.
    let vapLastTs = 0;       // timestamp of last vaporization (ms)
    let vapPeakScore = 0;    // running max of ln(boost)/elapsed this cycle
    const cycleLog = [];     // per-cycle records (capped)
    let vapCycleN = 0;

    const resetVaporTracking = () => { vapLastTs = Date.now(); vapPeakScore = 0; };

    // Record + perform a vaporization. `boost` is the production multiplier the
    // reset would grant right now (from #vaporizationBoostTotal).
    const doVaporize = (boost) => {
        const elapsed = vapLastTs ? (Date.now() - vapLastTs) / 1000 : 0;
        if (CONFIG.logCycles && elapsed > 0 && boost && boost > 1) {
            const rho = Math.log(boost) / elapsed; // realized growth rate (1/s) — the objective
            const rec = {
                n: ++vapCycleN,
                elapsed: +elapsed.toFixed(2),
                boost: +boost.toFixed(3),
                rho: +rho.toFixed(5),                       // ln(boost)/elapsed = what we maximize
                peakRho: +vapPeakScore.toFixed(5),          // best ρ seen this cycle (adaptive only)
                eff: vapPeakScore > 0 ? +(rho / vapPeakScore).toFixed(3) : null, // ρ_fire / ρ_peak
                clouds: readNum('#footerStat3Span'),        // clouds before this reset
                cloudsGain: numFromText(textOf('reset0Button')), // "Reset for X Clouds"
            };
            cycleLog.push(rec);
            if (cycleLog.length > 500) cycleLog.shift();
            console.log(`[Fundamental] vap #${rec.n}: ${rec.boost}x in ${rec.elapsed}s | ρ=${rec.rho}/s peak=${rec.peakRho} eff=${rec.eff} | +${rec.cloudsGain} clouds`);
        }
        pushLog(`💨 vaporize ${boost ? boost.toFixed(2) : '?'}× · ${elapsed.toFixed(1)}s`);
        clickIf('reset0Button');
        resetVaporTracking();
    };

    function vaporizeStep() {
        if (!vapLastTs) vapLastTs = Date.now();
        const boost = readNum('#vaporizationBoostTotal > span');
        if (boost === null) return;

        if (CONFIG.vaporizeMode === 'fixed') {
            if (boost >= CONFIG.vaporizeBoost) doVaporize(boost);
            return;
        }

        // Adaptive: maximize ln(boost)/elapsed (renewal-reward optimum).
        const elapsed = (Date.now() - vapLastTs) / 1000;
        if (boost < CONFIG.vaporizeMinBoost || elapsed < 0.5) return; // too early / worthless

        const score = Math.log(boost) / elapsed;
        if (score > vapPeakScore) {
            vapPeakScore = score; // still climbing — keep accumulating
        } else if (score <= vapPeakScore * (1 - CONFIG.vaporizePeakDrop)) {
            doVaporize(boost); // peak passed — cashing out now maximizes growth rate
        }
    }

    // Summarize logged cycles. The adaptive rule is optimal when meanRho is at its
    // max: if raising vaporizePeakDrop (firing later, higher boost) increases
    // meanRho, we were firing too early, and vice-versa. meanBoost is the multiplier
    // the rule naturally settles on.
    const report = () => {
        if (!cycleLog.length) { console.log('[Fundamental] no vaporization cycles logged yet'); return null; }
        const mean = (k) => cycleLog.reduce((s, r) => s + (r[k] || 0), 0) / cycleLog.length;
        const summary = {
            mode: CONFIG.vaporizeMode,
            cycles: cycleLog.length,
            meanElapsedSec: +mean('elapsed').toFixed(2),
            meanBoost: +mean('boost').toFixed(2),
            meanRho_perSec: +mean('rho').toFixed(5), // higher = faster; the number to maximize
            meanEff: +mean('eff').toFixed(3),
        };
        console.log('[Fundamental] vaporization summary:', summary);
        console.table(cycleLog.slice(-50));
        return { summary, cycles: cycleLog.slice() };
    };

    // ---- Collapse timing (stage 4) -------------------------------------------
    // Collapse banks stars and raw mass by resetting stage-4 buildings. The raw
    // projected mass is visible in the button ("Collapse is at X Mass"), but the
    // current raw banked mass is #footerStat2Span (player.collapse.mass).
    // #solarMassStat is a different value: the projected/current mass-effect ratio.
    //
    // Triggers (checked in priority order, first match wins):
    //   1. Stars are pending (the game accepts these without a mass increase)
    //   2. Element-pending after collapseElementGapMs
    //   3. Raw projected/banked mass ROI reaches collapseMassMultiplier
    //   4. Total collapse boost reaches collapseBoost
    //   5. Hard-stall breaker after collapseHardStallMs
    //   6. Anti-hang after collapseMaxWaitMs, still gated by the raw-mass ROI floor
    //
    // #collapseBoostTotal disappears once the game's own auto-collapse takes over
    // (strangeness[4][4] ≥ 3) — then we leave timing to the game entirely.
    let collapseLastTs = 0;
    let collapseLastAttemptTs = 0;
    let collapseObservedMass = null;
    let collapseLastProjectedMass = null;
    let collapseN = 0;
    const collapseLog = [];
    function readStarGains() {
        return {
            s0: readNum('#special1Get'),
            s1: readNum('#special2Get'),
            s2: readNum('#special3Get'),
        };
    }
    const fmtMass = (value) => value == null
        ? '?'
        : Number(value).toLocaleString('en-US', { maximumSignificantDigits: 8 });
    function recordCollapse(data) {
        if (!CONFIG.logCollapses) return;
        const rec = {
            n: ++collapseN,
            time: new Date().toISOString(),
            source: data.source,
            accepted: data.accepted,
            reason: data.reason,
            bankedMassBefore: data.bankedMassBefore,
            projectedMass: data.projectedMass,
            projectedRatio: data.projectedRatio,
            bankedMassAfter: data.bankedMassAfter,
            totalBoost: data.totalBoost,
            elapsedSec: data.elapsedSec == null ? null : +data.elapsedSec.toFixed(2),
            starGain0: data.starGains?.[0] ?? null,
            starGain1: data.starGains?.[1] ?? null,
            starGain2: data.starGains?.[2] ?? null,
            pendingElements: data.pendingElements ?? null,
        };
        collapseLog.push(rec);
        if (collapseLog.length > 500) collapseLog.shift();
        const ratioText = rec.projectedRatio == null ? '?' : rec.projectedRatio.toFixed(4) + '×';
        const status = rec.accepted ? 'accepted' : 'rejected';
        console.log(
            `[Fundamental] collapse #${rec.n} ${status} (${rec.source}/${rec.reason}): ` +
            `banked ${fmtMass(rec.bankedMassBefore)} M☉ → projected ${fmtMass(rec.projectedMass)} M☉ ` +
            `(${ratioText}) → banked ${fmtMass(rec.bankedMassAfter)} M☉`,
            rec
        );
    }
    const collapseReport = () => {
        if (!collapseLog.length) {
            console.log('[Fundamental] no Stage 4 collapses logged yet');
            return null;
        }
        const accepted = collapseLog.filter((r) => r.accepted);
        const ratios = accepted.map((r) => r.projectedRatio).filter((v) => Number.isFinite(v));
        const summary = {
            records: collapseLog.length,
            accepted: accepted.length,
            rejected: collapseLog.length - accepted.length,
            scriptRecords: collapseLog.filter((r) => r.source === 'script').length,
            gameAutoRecords: collapseLog.filter((r) => r.source === 'game-auto').length,
            minProjectedRatio: ratios.length ? Math.min(...ratios) : null,
            meanProjectedRatio: ratios.length ? ratios.reduce((sum, v) => sum + v, 0) / ratios.length : null,
            maxProjectedRatio: ratios.length ? Math.max(...ratios) : null,
        };
        console.log('[Fundamental] collapse summary:', summary);
        console.table(collapseLog);
        return { summary, collapses: collapseLog.slice() };
    };
    function collapseStep() {
        if (!collapseLastTs) collapseLastTs = Date.now();
        if (!/collapse/i.test(textOf('reset0Button'))) return; // not the collapse reset / not actionable
        const bankedMassBefore = readNum('#footerStat2Span');
        const totalBoost = readNum('#collapseBoostTotal > span'); // null when the game auto-handles it
        if (collapseObservedMass == null) {
            collapseObservedMass = bankedMassBefore;
        } else if (totalBoost == null && bankedMassBefore != null && bankedMassBefore !== collapseObservedMass) {
            recordCollapse({
                source: 'game-auto',
                accepted: true,
                reason: 'observed mass change',
                bankedMassBefore: collapseObservedMass,
                projectedMass: collapseLastProjectedMass,
                projectedRatio: collapseLastProjectedMass != null && collapseObservedMass > 0
                    ? collapseLastProjectedMass / collapseObservedMass
                    : null,
                bankedMassAfter: bankedMassBefore,
                totalBoost: null,
                elapsedSec: null,
                starGains: null,
                pendingElements: document.querySelectorAll('[id^="element"].awaiting').length,
            });
            collapseObservedMass = bankedMassBefore;
        }
        // Keep the latest raw projected mass even when game automation owns collapse.
        const newMass = numFromText(textOf('reset0Button'));
        const massRatio = newMass != null && bankedMassBefore != null && bankedMassBefore > 0
            ? newMass / bankedMassBefore
            : null;
        collapseLastProjectedMass = newMass;
        if (totalBoost == null || massRatio == null) return;
        const elapsed = (Date.now() - collapseLastTs) / 1000;
        const sinceAttempt = (Date.now() - collapseLastAttemptTs) / 1000;
        if (collapseLastAttemptTs && sinceAttempt < CONFIG.collapseMinGapMs / 1000) return;

        const sg = readStarGains();
        const hasStarGain = (sg.s0 !== null && sg.s0 > 0) ||
                            (sg.s1 !== null && sg.s1 > 0) ||
                            (sg.s2 !== null && sg.s2 > 0);

        // Element pending (self-disabling when strangeness[4][6] ≥ 1)
        const elementPending = CONFIG.collapseOnElement && !!document.querySelector('[id^="element"].awaiting');

        let fire = false;
        let reason = '';

        if (hasStarGain && elapsed >= CONFIG.collapseMinGapMs / 1000) {
            fire = true; reason = 'stars';                                   // 1. bank ready stars immediately
        } else if (elementPending && elapsed >= CONFIG.collapseElementGapMs / 1000) {
            fire = true; reason = 'element';                                 // 2. element pending
        } else if (massRatio >= CONFIG.collapseMassMultiplier &&
            elapsed >= CONFIG.collapseMinGapMs / 1000) {
            fire = true; reason = 'mass-roi';                                // 3. raw-mass ROI
        } else if (totalBoost >= CONFIG.collapseBoost) {
            fire = true; reason = 'boost';                                   // 4. strong total boost
        } else if (elapsed >= CONFIG.collapseHardStallMs / 1000) {
            fire = true; reason = 'hardstall';                               // 5. unconditional
        } else if (elapsed >= CONFIG.collapseMaxWaitMs / 1000 &&
                   totalBoost >= CONFIG.collapseMinBoost &&
                   massRatio >= CONFIG.collapseAntihangMassMin) {
            fire = true; reason = 'antihang';                                // 6. anti-hang (mass-gated)
        }

        if (fire) {
            const preStars = [sg.s0, sg.s1, sg.s2];
            const prePending = document.querySelectorAll('[id^="element"].awaiting').length;
            const clicked = clickIf('reset0Button');
            collapseLastAttemptTs = Date.now();

            // Confirm one of the three game-side rewards changed. The button contains
            // projected mass, so comparing its text alone can miss star-only collapses.
            const postBankedMass = readNum('#footerStat2Span');
            const postStars = readStarGains();
            const postPending = document.querySelectorAll('[id^="element"].awaiting').length;
            const starsChanged = [postStars.s0, postStars.s1, postStars.s2]
                .some((value, i) => value !== preStars[i]);
            const accepted = clicked && (
                (bankedMassBefore != null && postBankedMass != null && postBankedMass > bankedMassBefore) ||
                starsChanged ||
                postPending < prePending
            );
            if (accepted) {
                collapseLastTs = Date.now();
            }
            // If rejected, keep collapseLastTs so timers continue accumulating.
            recordCollapse({
                source: 'script',
                accepted,
                reason,
                bankedMassBefore,
                projectedMass: newMass,
                projectedRatio: massRatio,
                bankedMassAfter: postBankedMass,
                totalBoost,
                elapsedSec: elapsed,
                starGains: preStars,
                pendingElements: prePending,
            });
            if (postBankedMass != null) collapseObservedMass = postBankedMass;

            const gainDetail = hasStarGain ? ` +${[sg.s0,sg.s1,sg.s2].filter(v => v != null && v > 0).join('/')}★` : '';
            const massDetail = newMass ? ' ' + newMass.toFixed(2) + 'M☉' : '';
            pushLog('💥 collapse (' + reason + ')' + gainDetail + massDetail + ' ' + massRatio.toFixed(3) + '× mass');
        }
    }

    // ---- Merge timing (stage 5) ----------------------------------------------
    // Merge mirrors collapse's boost-gate but with two game-enforced guards that make it
    // safe to spam-gate: merging needs ≥22 galaxies AND is hard-capped (mergeMaxResets ≈ 2
    // early). Both are enforced on reset0Button — when unmet it reads "Requires…", so
    // resetReady() returns false and we don't fire. #mergeBoostTotal is the multiplicative
    // gain of merging now; it's hidden (→ null) once strangeness[5][9]≥2 hands merging to the
    // game's own auto-merge, at which point we stop and defer to the game (matching collapse).
    let mergeLastTs = 0;
    let stage5HoldStart = 0;
    function mergeStep() {
        if (!resetReady('reset0Button') || !/merge/i.test(textOf('reset0Button'))) {
            if (!mergeLastTs) mergeLastTs = Date.now();
            return; // keep existing timer — don't reset on DOM flicker (v1.12 fix)
        }
        if (!mergeLastTs) mergeLastTs = Date.now();
        const boost = readNum('#mergeBoostTotal > span');
        if (boost == null) return; // game auto-merges (strangeness[5][9]≥2) — leave timing to it
        const elapsed = (Date.now() - mergeLastTs) / 1000;
        const fire = boost >= CONFIG.mergeBoost ||
            (elapsed >= CONFIG.mergeMaxWaitMs / 1000 && boost >= CONFIG.mergeMinBoost);
        if (fire) {
            clickIf('reset0Button');
            mergeLastTs = Date.now();
            pushLog('🌀 merge ' + boost.toFixed(2) + '×');
        }
    }

    function stage5HasUnlockedWork() {
        const mergeBoost = readNum('#mergeBoostTotal > span');
        // Merge is actionable when ready, or when boost is high enough that
        // waiting for the 2.0× trigger is realistic. At 1.00× (all galaxies
        // merged, no rebuild underway) the bot can never reach the merge
        // threshold without a quark-farming loop — don't pretend there's work.
        if (/merge/i.test(textOf('reset0Button')) &&
            (resetReady('reset0Button') || (mergeBoost != null && mergeBoost >= CONFIG.mergeMinBoost))) return true;
        for (let i = 1; i <= 4; i++) {
            const name = textOf('building' + i + 'Name');
            const btn = textOf('building' + i + 'Btn');
            if (!name || !btn) continue;
            if (!/nebula|star|galax/i.test(name)) continue;
            if (!/locked|unlock/i.test(btn)) return true;
        }
        return false;
    }

    function shouldHoldStage5Reset() {
        if (!CONFIG.holdStage5WhenActionable || activeStage() !== 5) {
            stage5HoldStart = 0;
            return false;
        }
        if (!stage5HasUnlockedWork()) {
            stage5HoldStart = 0;
            return false;
        }
        if (!stage5HoldStart) stage5HoldStart = Date.now();
        const mergeBoost = readNum('#mergeBoostTotal > span');
        // Hold indefinitely if merge is actually ready or approaching
        if (/merge/i.test(textOf('reset0Button')) &&
            (resetReady('reset0Button') || (mergeBoost != null && mergeBoost >= CONFIG.mergeMinBoost))) return true;
        // Merge boost is below the anti-hang floor: quark gain can only grow
        // via element26, which is negligible.  Hold for a short grace period
        // for initial building buy-up, then release to farm quarks via stage
        // reset.  The absolute safety net (stage5HoldMaxMs) still applies.
        return Date.now() - stage5HoldStart <= CONFIG.stage5HoldGraceMs;
    }

    // ---- Reset pass -----------------------------------------------------------
    // reset0 = discharge(1) / vaporization(2) / rank(3) / collapse(4) / merge(5) / nucleation(6).
    // Each stage's reset has a very different cost/benefit, so they are handled
    // individually rather than spammed uniformly.
    let prevStage = 0;
    function fastResets() {
        const s = activeStage();
        if (s === 0) {
            if (prevStage !== 0) pushLog('stage unknown - waiting');
            prevStage = 0;
            return;
        }
        if (s !== 2 && prevStage === 2) resetVaporTracking(); // left stage 2 — start fresh on return
        if (s !== 4 && prevStage === 4) {
            collapseLastTs = 0;
            collapseLastAttemptTs = 0;
            collapseObservedMass = null;
            collapseLastProjectedMass = null;
        } // left stage 4 — reset collapse cadence
        if (s !== 5 && prevStage === 5) mergeLastTs = 0;      // left stage 5 — reset merge cadence
        if (s !== 5 && prevStage === 5) stage5HoldStart = 0;   // left stage 5 — reset stage-reset hold
        if (s !== prevStage && prevStage !== 0) pushLog(`🪐 stage → ${STAGE_NAMES[s] || s}`);
        prevStage = s;

        if (s === 1) {
            // Discharge: cheap and the regain is always beneficial — the standard
            // early strategy is to discharge constantly. (Don't gate on the label:
            // it can read "Next goal is X Energy" even when a discharge is available.)
            clickIf('reset0Button');
        } else if (s === 2) {
            vaporizeStep();
        } else if (s === 3) {
            // Rank: hard-gated internally by a mass requirement and capped at maxRank,
            // so this advances milestones rather than looping. Safe to attempt.
            clickIf('reset0Button');
        } else if (s === 4) {
            collapseStep();
        } else if (s === 5) {
            mergeStep();
        } else if (CONFIG.highStageResets && resetReady('reset0Button')) {
            // Nucleation (stage 6): big prestige reset. Off by default — prefer the
            // game's own auto-resets, which time it optimally.
            clickIf('reset0Button');
            log('high-stage reset', s);
        }
    }

    function slowResets() {
        if (CONFIG.doStageReset && resetReady('reset1Button')) {
            if (shouldHoldStage5Reset()) {
                if (!eventLog.length || eventLog[eventLog.length - 1].msg !== '⏳ holding Stage 5 reset') {
                    pushLog('⏳ holding Stage 5 reset');
                }
                return;
            }
            clickIf('reset1Button'); log('stage reset');
        }
        if (CONFIG.doEndReset && resetReady('reset2Button')) {
            clickIf('reset2Button'); log('end reset');
        }
    }

    // ---- Main loop ------------------------------------------------------------
    let mainTimer = null;
    let lastSlow = 0;
    let lastExport = 0;
    let running = false;

    // The in-game Export grants Strange-quark rewards (exportReward) and THEN downloads the save
    // via a data: anchor. Suppress that download ONLY for the bot's auto-exports (flag-gated), so a
    // manual "Export save" still produces a real backup file.
    let suppressNextDownload = false;
    let suppressDownloadTimer = null;
    let restoreCreateElement = null;
    function restoreExportDownloadSuppressor() {
        if (!restoreCreateElement) return;
        restoreCreateElement();
        restoreCreateElement = null;
    }
    function suppressExportDownloads() {
        if (restoreCreateElement) return;
        const origCreateElement = document.createElement;
        const wrappedCreateElement = function (tagName) {
            const el = origCreateElement.apply(this, arguments);
            if (suppressNextDownload && String(tagName).toLowerCase() === 'a') {
                const origClick = el.click;
                el.click = function () {
                    const href = this.getAttribute('href') || this.href || '';
                    const isDownload = this.hasAttribute('download') || !!this.download;
                    if (suppressNextDownload && isDownload && /^data:text\/plain/i.test(href)) {
                        suppressNextDownload = false;
                        if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                        suppressDownloadTimer = null;
                        restoreExportDownloadSuppressor();
                        return;
                    }
                    return origClick.apply(this, arguments);
                };
            }
            return el;
        };
        document.createElement = wrappedCreateElement;
        restoreCreateElement = () => {
            if (document.createElement === wrappedCreateElement) document.createElement = origCreateElement;
        };
    }
    // Manual save export — clicks the game's Export with the download allowed (real file).
    function exportSaveFile() {
        suppressNextDownload = false;
        restoreExportDownloadSuppressor();
        if (clickIf('export')) pushLog('💾 manual save export');
    }

    function openUpdateUrl() {
        const cacheBustedUrl = `${UPDATE_URL}?v=${encodeURIComponent(BOT_VERSION)}&t=${Date.now()}`;
        window.open(cacheBustedUrl, '_blank', 'noopener,noreferrer');
        pushLog('Opened latest script installer');
    }

    async function copyCollapseLog() {
        const payload = {
            version: BOT_VERSION,
            copiedAt: new Date().toISOString(),
            collapses: collapseLog.slice(),
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            pushLog('📋 collapse log copied');
            const button = $('fbCopyBtn');
            if (button) {
                const oldText = button.querySelector('span')?.textContent;
                const label = button.querySelector('span');
                if (label) label.textContent = 'Copied';
                setTimeout(() => { if (label) label.textContent = oldText || 'Copy log'; }, 1200);
            }
        } catch (error) {
            console.error('[Fundamental] could not copy collapse log', error);
            pushLog('Could not copy collapse log');
        }
    }

    function tick() {
        try {
            tickCount++;
            if (document.hidden) {
                updateHud();
                return;
            }
            acceptOfflineDialog();
            applySettings();
            buyEverything();
            fastResets();
            const now = Date.now();
            if (now - lastSlow >= CONFIG.slowResetEveryMs) {
                lastSlow = now;
                slowResets();
            }
            if (CONFIG.autoExport && activeStage() >= 5 && now - lastExport >= CONFIG.exportEveryMs) {
                lastExport = now;
                suppressNextDownload = true; // suppress only the auto-export's file download (keep reward)
                if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                suppressExportDownloads();
                suppressDownloadTimer = setTimeout(() => {
                    suppressNextDownload = false;
                    suppressDownloadTimer = null;
                    restoreExportDownloadSuppressor();
                }, 1500);
                if (clickIf('export')) {
                    pushLog('📤 export · claimed strange quarks');
                } else {
                    suppressNextDownload = false;
                    if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                    suppressDownloadTimer = null;
                    restoreExportDownloadSuppressor();
                }
            }
            updateHud();
        } catch (e) {
            console.error('[Fundamental] tick error', e);
        }
    }

    let startTs = 0;
    let tickCount = 0;

    function start() {
        if (running) return;
        running = true;
        lastSlow = 0;
        startTs = Date.now();
        pushLog('▶ autoplayer started');
        tick();
        mainTimer = setInterval(tick, CONFIG.tickMs);
        updateHud();
        log('started');
    }

    function stop() {
        running = false;
        if (mainTimer) clearInterval(mainTimer);
        mainTimer = null;
        suppressNextDownload = false;
        if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
        suppressDownloadTimer = null;
        restoreExportDownloadSuppressor();
        pushLog('⏸ autoplayer stopped');
        updateHud();
        log('stopped');
    }

    // ---- HUD (side panel) -----------------------------------------------------
    let hud = null;
    const el = {}; // cached field elements

    const HUD_CSS = `
    #fbHud{--fb-cyan:#58d9ee;--fb-blue:#2c8ae8;--fb-amber:#f5b642;--fb-green:#4ade80;--fb-red:#fb7185;
        position:fixed;top:16px;right:16px;z-index:2147483600;width:310px;max-height:calc(100vh - 32px);
        font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        font-size:12px;line-height:1.4;color:#edf5ff;user-select:none;border-radius:16px;overflow:hidden;
        background:#07111f;border:1px solid rgba(88,217,238,.55);
        box-shadow:0 18px 48px rgba(0,0,0,.58),0 0 0 1px rgba(44,138,232,.08);}
    #fbHud.min #fbBody{display:none;}
    #fbHead{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:9px;padding:11px 12px;
        cursor:grab;background:#091626;border-bottom:1px solid rgba(88,217,238,.2);}
    #fbHead:active{cursor:grabbing;}
    .fb-logo{width:28px;height:28px;color:var(--fb-cyan);filter:drop-shadow(0 0 5px rgba(88,217,238,.28));}
    .fb-brand{min-width:0;}
    .fb-brand-line{display:flex;align-items:center;gap:7px;min-width:0;}
    .fb-brand b{font-size:13.5px;line-height:1.15;letter-spacing:.1px;color:#f7fbff;white-space:nowrap;}
    .fb-head-state{display:inline-flex;align-items:center;gap:5px;color:#7ee5a1;font-size:10px;font-weight:700;white-space:nowrap;}
    .fb-head-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--fb-green);
        box-shadow:0 0 7px rgba(74,222,128,.7);animation:fbP 1.6s ease-in-out infinite;}
    #fbHud.off .fb-head-state{color:#fda4af;}
    #fbHud.off .fb-head-state::before{background:var(--fb-red);box-shadow:none;animation:none;}
    #fbHud.hidden-tab{border-color:rgba(245,182,66,.72);}
    #fbHud.hidden-tab .fb-head-state{color:#f8cb72;}
    #fbHud.hidden-tab .fb-head-state::before{background:var(--fb-amber);box-shadow:0 0 7px rgba(245,182,66,.65);}
    @keyframes fbP{0%,100%{opacity:1;}50%{opacity:.35;}}
    .fb-head-meta{margin-top:2px;color:#7690aa;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #fbMin{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;color:#a9c1d8;
        background:transparent;cursor:pointer;}
    #fbMin:hover{color:#fff;background:rgba(88,217,238,.1);}
    #fbMin svg{width:15px;height:15px;transition:transform .18s ease;}
    #fbHud.min #fbMin svg{transform:rotate(180deg);}
    #fbBody{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:11px;}
    .fb-section{padding-bottom:11px;border-bottom:1px solid rgba(88,217,238,.16);}
    .fb-eyebrow{margin-bottom:5px;font-size:9px;line-height:1.2;font-weight:800;letter-spacing:1.35px;
        text-transform:uppercase;color:#5dcbe3;}
    .fb-stage{font-size:11px;font-weight:750;letter-spacing:1.2px;color:#b9cce0;text-transform:uppercase;}
    .fb-decision{margin-top:1px;font-size:22px;line-height:1.1;font-weight:760;letter-spacing:-.35px;color:var(--fb-cyan);}
    .fb-decision.ready{color:var(--fb-green);}
    .fb-decision.paused{color:var(--fb-amber);}
    .fb-detail{margin-top:5px;color:#9db1c7;font-size:11px;line-height:1.35;}
    .fb-metrics{display:grid;gap:5px;}
    .fb-metric{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}
    .fb-metric-label{color:#9db1c7;}
    .fb-metric-value{min-width:0;color:#f5f9ff;font-weight:680;text-align:right;font-variant-numeric:tabular-nums;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #fbProgressWrap[hidden]{display:none;}
    .fb-progress-head{display:flex;justify-content:space-between;gap:8px;margin-top:9px;color:#8399b0;font-size:9.5px;}
    .fb-progress-head strong{color:var(--fb-amber);font-weight:720;font-variant-numeric:tabular-nums;}
    .fb-progress{height:5px;margin-top:5px;border-radius:999px;overflow:hidden;background:#162538;border:1px solid #2b4058;}
    .fb-progress>span{display:block;width:0;height:100%;border-radius:inherit;background:var(--fb-cyan);transition:width .25s ease;}
    .fb-progress-values{display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:9px;color:#70879e;
        font-variant-numeric:tabular-nums;}
    .fb-progress-values span:nth-child(2){color:#84e6f1;}
    .fb-progress-values span:last-child{color:#f5bd58;text-align:right;}
    .fb-target-value{font-size:20px;line-height:1.2;font-weight:760;color:var(--fb-amber);font-variant-numeric:tabular-nums;}
    .fb-target-value.ready{color:var(--fb-green);}
    .fb-signal{margin-top:8px;padding-top:8px;border-top:1px solid rgba(88,217,238,.12);color:#94a9bf;font-size:10px;}
    .fb-last-value{color:#c8d7e8;font-size:11px;line-height:1.35;white-space:normal;}
    .fb-actions{display:grid;gap:8px;}
    .fb-primary,.fb-utility{font:inherit;border:0;cursor:pointer;}
    .fb-primary{width:100%;padding:9px 12px;border-radius:9px;color:#fff;font-size:11.5px;font-weight:760;
        background:#1767b6;border:1px solid #3399ed;box-shadow:inset 0 1px 0 rgba(255,255,255,.12);}
    .fb-primary:hover{background:#2177cc;}
    #fbHud.off .fb-primary{background:#17653d;border-color:#39b86d;}
    #fbHud.off .fb-primary:hover{background:#1c7a49;}
    .fb-utility-row{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
    .fb-utility{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;padding:7px 5px;border-radius:8px;
        color:#77d9ea;background:transparent;font-size:10px;}
    .fb-utility:hover{color:#fff;background:rgba(88,217,238,.09);}
    .fb-utility svg{width:14px;height:14px;flex:0 0 auto;}
    #fbUpdateBtn{justify-self:center;padding:4px 7px;color:#7894ad;text-decoration:underline;text-underline-offset:3px;}
    #fbUpdateBtn:hover{color:#9fe8f4;background:transparent;}
    @media(max-width:600px){#fbHud{top:8px;right:8px;width:min(310px,calc(100vw - 16px));max-height:calc(100vh - 16px);}}
    @media(prefers-reduced-motion:reduce){#fbHud *{animation:none!important;transition:none!important;}}
    `;

    function buildHud() {
        const style = document.createElement('style');
        style.textContent = HUD_CSS;
        document.head.appendChild(style);
        hud = document.createElement('div');
        hud.id = 'fbHud';
        hud.innerHTML = `
            <div id="fbHead">
                <svg class="fb-logo" viewBox="0 0 32 32" aria-hidden="true">
                    <circle cx="16" cy="16" r="2.5" fill="currentColor"/>
                    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
                    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(60 16 16)"/>
                    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(120 16 16)"/>
                </svg>
                <div class="fb-brand">
                    <div class="fb-brand-line"><b>Fundamental Pilot</b><span class="fb-head-state" id="fbHeadState">\u2014</span></div>
                    <div class="fb-head-meta" id="fbHeadMeta">\u2014</div>
                </div>
                <button id="fbMin" type="button" title="Collapse panel" aria-label="Collapse panel" aria-expanded="true">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5 8 5.5l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>
            <div id="fbBody">
                <section class="fb-section">
                    <div class="fb-eyebrow">Current decision</div>
                    <div class="fb-stage" id="fbStage">\u2014</div>
                    <div class="fb-decision" id="fbDecision">\u2014</div>
                    <div class="fb-detail" id="fbDecisionDetail">\u2014</div>
                </section>
                <section class="fb-section">
                    <div class="fb-eyebrow" id="fbMetricHeading">Status</div>
                    <div class="fb-metrics">
                        <div class="fb-metric"><span class="fb-metric-label" id="fbMetricLabel1">\u2014</span><span class="fb-metric-value" id="fbMetricValue1">\u2014</span></div>
                        <div class="fb-metric"><span class="fb-metric-label" id="fbMetricLabel2">\u2014</span><span class="fb-metric-value" id="fbMetricValue2">\u2014</span></div>
                        <div class="fb-metric"><span class="fb-metric-label" id="fbMetricLabel3">\u2014</span><span class="fb-metric-value" id="fbMetricValue3">\u2014</span></div>
                    </div>
                    <div id="fbProgressWrap" hidden>
                        <div class="fb-progress-head"><span id="fbProgressLabel">\u2014</span><strong id="fbProgressPct">\u2014</strong></div>
                        <div class="fb-progress"><span id="fbProgressBar"></span></div>
                        <div class="fb-progress-values"><span id="fbProgressLeft">0</span><span id="fbProgressCurrent">\u2014</span><span id="fbProgressTarget">\u2014</span></div>
                    </div>
                </section>
                <section class="fb-section">
                    <div class="fb-eyebrow" id="fbTargetLabel">Next action</div>
                    <div class="fb-target-value" id="fbTargetValue">\u2014</div>
                    <div class="fb-detail" id="fbTargetDetail">\u2014</div>
                    <div class="fb-signal" id="fbSignal">\u2014</div>
                </section>
                <section class="fb-section">
                    <div class="fb-eyebrow" id="fbLastLabel">Last action</div>
                    <div class="fb-last-value" id="fbLastValue">\u2014</div>
                </section>
                <div class="fb-actions">
                    <button class="fb-primary" id="fbRunBtn" type="button">Pause script</button>
                    <div class="fb-utility-row">
                        <button class="fb-utility" id="fbExportBtn" type="button">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 12v2h10v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            <span>Export save</span>
                        </button>
                        <button class="fb-utility" id="fbCopyBtn" type="button">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="4" width="8" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h6A1.5 1.5 0 0 1 10 2.5V3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
                            <span>Copy log</span>
                        </button>
                    </div>
                    <button class="fb-utility" id="fbUpdateBtn" type="button">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        <span>Install latest</span>
                    </button>
                </div>
            </div>`;
        document.body.appendChild(hud);
        [
            'fbHeadState', 'fbHeadMeta', 'fbStage', 'fbDecision', 'fbDecisionDetail', 'fbMetricHeading',
            'fbMetricLabel1', 'fbMetricValue1', 'fbMetricLabel2', 'fbMetricValue2', 'fbMetricLabel3',
            'fbMetricValue3', 'fbProgressWrap', 'fbProgressLabel', 'fbProgressPct', 'fbProgressBar',
            'fbProgressLeft', 'fbProgressCurrent', 'fbProgressTarget', 'fbTargetLabel', 'fbTargetValue',
            'fbTargetDetail', 'fbSignal', 'fbLastLabel', 'fbLastValue', 'fbRunBtn',
        ].forEach((id) => { el[id] = $(id); });
        $('fbMin').onclick = (e) => {
            e.stopPropagation();
            hud.classList.toggle('min');
            const minimized = hud.classList.contains('min');
            $('fbMin').setAttribute('aria-expanded', minimized ? 'false' : 'true');
            $('fbMin').setAttribute('aria-label', minimized ? 'Expand panel' : 'Collapse panel');
            localStorage.setItem('fbHudMin', minimized ? '1' : '0');
        };
        if (localStorage.getItem('fbHudMin') === '1') hud.classList.add('min');
        $('fbMin').setAttribute('aria-expanded', hud.classList.contains('min') ? 'false' : 'true');
        $('fbRunBtn').onclick = () => (running ? stop() : start());
        $('fbExportBtn').onclick = exportSaveFile;
        $('fbCopyBtn').onclick = copyCollapseLog;
        $('fbUpdateBtn').onclick = openUpdateUrl;
        const pos = localStorage.getItem('fbHudPos');
        if (pos) { try { const p = JSON.parse(pos); hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px'; hud.style.right = 'auto'; } catch (e) { /* ignore */ } }
        makeDraggable($('fbHead'));
        updateHud();
    }

    function makeDraggable(handle) {
        let sx, sy, ox, oy, drag = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button,a')) return;
            drag = true; const r = hud.getBoundingClientRect();
            ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; hud.style.right = 'auto'; e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!drag) return;
            hud.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx)) + 'px';
            hud.style.top = Math.max(0, Math.min(window.innerHeight - 24, oy + e.clientY - sy)) + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!drag) return; drag = false;
            const r = hud.getBoundingClientRect();
            localStorage.setItem('fbHudPos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
        });
    }

    const fmtHudNumber = (value, digits = 4) => {
        if (value == null || !Number.isFinite(value)) return '\u2014';
        const abs = Math.abs(value);
        if ((abs >= 1e6 || (abs > 0 && abs < 0.001))) return value.toExponential(Math.max(1, digits - 1));
        return value.toLocaleString('en-US', { maximumSignificantDigits: digits });
    };
    const fmtHudMass = (value) => value == null ? '\u2014' : `${fmtHudNumber(value, 6)} M\u2609`;
    const footerResource = () => {
        const text = textOf('footerStat1');
        const colon = text.indexOf(':');
        return colon >= 0
            ? { label: text.slice(0, colon).trim() || 'Resource', value: text.slice(colon + 1).trim() || '\u2014' }
            : { label: 'Resource', value: text || '\u2014' };
    };
    const latestEventText = (pattern = null) => {
        const records = pattern ? eventLog.filter((record) => pattern.test(record.msg)) : eventLog;
        return records.length ? records[records.length - 1].msg : 'No action recorded this run';
    };
    function collapseHudModel() {
        const resetText = textOf('reset0Button');
        const projectedMass = /collapse/i.test(resetText) ? numFromText(resetText) : null;
        const bankedMass = readNum('#footerStat2Span');
        const massRatio = projectedMass != null && bankedMass != null && bankedMass > 0
            ? projectedMass / bankedMass
            : null;
        const totalBoost = readNum('#collapseBoostTotal > span');
        const stars = readStarGains();
        const starValues = [stars.s0, stars.s1, stars.s2].map((value) => value || 0);
        const hasStars = starValues.some((value) => value > 0);
        const pendingElements = document.querySelectorAll('[id^="element"].awaiting').length;
        const massTarget = CONFIG.collapseMassMultiplier;
        const massReady = massRatio != null && massRatio >= massTarget;
        const starReady = hasStars;
        const boostReady = totalBoost != null && totalBoost >= CONFIG.collapseBoost;
        const ready = massReady || starReady || pendingElements > 0 || boostReady;
        let decision = 'Building collapse ROI';
        let decisionDetail = 'Waiting for a worthwhile mass-effect increase.';
        if (totalBoost == null) {
            decision = 'Game auto-collapse';
            decisionDetail = 'The script is observing results; the game owns collapse timing.';
        } else if (ready) {
            decision = starReady ? 'Stars ready to bank' : 'Collapse trigger ready';
            if (starReady) decisionDetail = `Collapse will bank +${starValues.join(' / ')} stars; no mass increase is required.`;
            else if (pendingElements > 0) decisionDetail = `${pendingElements} element${pendingElements === 1 ? '' : 's'} awaiting activation.`;
            else if (massReady) decisionDetail = `Projected mass reached the ${massTarget.toFixed(2)}\u00d7 ROI target.`;
            else decisionDetail = `Total collapse boost reached ${totalBoost.toFixed(2)}\u00d7.`;
        }
        const progress = massRatio == null
            ? null
            : Math.max(0, Math.min(1, (massRatio - 1) / (massTarget - 1)));
        const needed = massRatio == null ? null : Math.max(0, massTarget - massRatio);
        const last = [...collapseLog].reverse().find((record) => record.accepted);
        const lastText = last
            ? `#${last.n} \u00b7 ${fmtHudMass(last.bankedMassBefore)} \u2192 ${fmtHudMass(last.bankedMassAfter)} \u00b7 ${last.projectedRatio == null ? 'auto' : `${last.projectedRatio.toFixed(3)}\u00d7`} \u00b7 ${last.reason}`
            : 'Not observed this run';
        const signal = pendingElements > 0
            ? `${pendingElements} element${pendingElements === 1 ? '' : 's'} awaiting activation`
            : hasStars
                ? `Star gain pending: +${starValues.join(' / ')}`
                : 'No star or element trigger pending';
        return {
            decision,
            decisionDetail,
            ready,
            heading: 'Collapse value',
            metrics: [
                ['Banked mass', fmtHudMass(bankedMass)],
                ['Projected mass', fmtHudMass(projectedMass)],
                ['Mass-only ROI', massRatio == null ? 'Game controlled' : `${massRatio.toFixed(3)}\u00d7 / ${massTarget.toFixed(2)}\u00d7`],
            ],
            progress: progress == null ? null : {
                label: 'Mass-only ROI progress',
                pct: `${(progress * 100).toFixed(1)}% of ROI`,
                width: progress * 100,
                left: '1.000\u00d7',
                current: `${massRatio.toFixed(3)}\u00d7`,
                target: `${massTarget.toFixed(2)}\u00d7`,
            },
            targetLabel: totalBoost == null ? 'Collapse owner' : hasStars ? 'Star remnants ready' : 'Next mass-only collapse',
            targetValue: totalBoost == null ? 'Game controlled' : hasStars ? `+${starValues.join(' / ')}` : `${massTarget.toFixed(2)}\u00d7 mass gain`,
            targetDetail: totalBoost == null
                ? 'The game has unlocked its own collapse automation.'
                : hasStars
                    ? `Collapse is actionable now at ${fmtHudMass(projectedMass)}; no minimum mass gain is required.`
                : needed == null
                    ? 'Waiting for collapse data.'
                    : needed > 0
                        ? `+${needed.toFixed(3)}\u00d7 mass gain needed${projectedMass == null ? '' : `; projected mass is ${fmtHudMass(projectedMass)}`}`
                        : 'Mass-only ROI condition is met',
            signal: hasStars ? 'Star trigger bypasses the mass-only ROI floor' : signal,
            lastLabel: 'Last collapse',
            lastValue: lastText,
        };
    }
    function stageHudModel(stage) {
        const resource = footerResource();
        if (stage === 4) return collapseHudModel();
        if (stage === 2) {
            const boost = readNum('#vaporizationBoostTotal > span');
            const target = CONFIG.vaporizeMode === 'fixed' ? CONFIG.vaporizeBoost : CONFIG.vaporizeMinBoost;
            const progress = boost == null ? null : Math.max(0, Math.min(1, boost / target));
            return {
                decision: boost != null && boost >= target ? 'Vaporizing now' : 'Building vapor boost',
                decisionDetail: CONFIG.vaporizeMode === 'fixed' ? 'Waiting for the fixed high-ROI reset point.' : 'Following the adaptive growth-rate peak.',
                ready: boost != null && boost >= target,
                heading: 'Vaporization',
                metrics: [[resource.label, resource.value], ['Current boost', boost == null ? '\u2014' : `${boost.toFixed(2)}\u00d7`], ['Mode', CONFIG.vaporizeMode]],
                progress: progress == null ? null : { label: 'Boost vs. reset target', pct: `${(progress * 100).toFixed(1)}%`, width: progress * 100, left: '1.00\u00d7', current: `${boost.toFixed(2)}\u00d7`, target: `${target.toFixed(2)}\u00d7` },
                targetLabel: 'Next vaporization',
                targetValue: `${target.toFixed(2)}\u00d7 boost`,
                targetDetail: boost == null ? 'Waiting for the boost stat.' : `+${Math.max(0, target - boost).toFixed(2)}\u00d7 boost needed`,
                signal: `Cycle time ${vapLastTs ? fmtDur((Date.now() - vapLastTs) / 1000) : '\u2014'}`,
                lastLabel: 'Last vaporization',
                lastValue: latestEventText(/vaporize/i),
            };
        }
        if (stage === 5) {
            const boost = readNum('#mergeBoostTotal > span');
            const target = CONFIG.mergeBoost;
            const progress = boost == null ? null : Math.max(0, Math.min(1, boost / target));
            const needMerge = boost != null && boost >= CONFIG.mergeMinBoost;
            const inGrace = stage5HoldStart ? ((Date.now() - stage5HoldStart) / 1000) : 0;
            const graceRemaining = Math.max(0, (CONFIG.stage5HoldGraceMs / 1000) - inGrace);
            const decision = boost != null && boost >= target
                ? 'Merge trigger ready'
                : needMerge
                    ? 'Merge approaching'
                    : graceRemaining > 0
                        ? 'Building galaxies'
                        : 'Farming strange quarks';
            const decisionDetail = boost != null && boost >= target
                ? 'Merging now for a production multiplier.'
                : needMerge
                    ? 'Holding Intergalactic while merge boost builds toward 2.0\u00d7.'
                    : graceRemaining > 0
                        ? `Grace period for initial building (${graceRemaining.toFixed(0)}s remaining).`
                        : 'Merge boost is below the anti-hang floor; resetting to farm quarks.';
            return {
                decision,
                decisionDetail,
                ready: boost != null && boost >= target,
                heading: 'Intergalactic',
                metrics: [
                    [resource.label, resource.value],
                    ['Merge boost', boost == null ? 'Game controlled' : `${boost.toFixed(2)}\u00d7`],
                    ['Stage policy', boost == null ? 'Game auto' : needMerge ? 'Hold' : 'Loop'],
                ],
                progress: progress == null ? null : { label: 'Boost vs. merge target', pct: `${(progress * 100).toFixed(1)}%`, width: progress * 100, left: '1.00\u00d7', current: `${boost.toFixed(2)}\u00d7`, target: `${target.toFixed(2)}\u00d7` },
                targetLabel: 'Next merge',
                targetValue: boost == null ? 'Game controlled' : `${target.toFixed(2)}\u00d7 boost`,
                targetDetail: boost == null ? 'The game has unlocked its own merge automation.' : `+${Math.max(0, target - boost).toFixed(2)}\u00d7 boost needed`,
                signal: boost == null
                    ? 'Game owns merge timing'
                    : needMerge
                        ? 'Merge boost is above the anti-hang floor — holding'
                        : graceRemaining > 0
                            ? `Grace period: ${graceRemaining.toFixed(0)}s until quark loop`
                            : 'Stage reset loops remain enabled',
                lastLabel: 'Last action',
                lastValue: latestEventText(/merge|stage|export/i),
            };
        }
        const resetText = textOf('reset0Button');
        const ready = resetReady('reset0Button');
        const labels = {
            1: ['Buying and discharging', 'Keeping the Microworld production loop moving.', 'Discharge check'],
            3: ['Climbing accretion ranks', 'Buying structures and taking each available rank.', 'Rank requirement'],
            6: ['Game automation active', 'High-stage resets remain under game control.', 'Reset status'],
        };
        const fallback = labels[stage] || ['Reading game state', 'Waiting for a recognized stage.', 'Reset status'];
        return {
            decision: fallback[0],
            decisionDetail: fallback[1],
            ready,
            heading: 'Stage status',
            metrics: [[resource.label, resource.value], ['Reset', ready ? 'Ready' : 'Waiting'], ['Bot uptime', running && startTs ? fmtDur((Date.now() - startTs) / 1000) : '\u2014']],
            progress: null,
            targetLabel: fallback[2],
            targetValue: ready ? 'Ready now' : 'Waiting',
            targetDetail: resetText || 'No reset information available.',
            signal: CONFIG.enableGameAutomation ? 'Game automation is enabled' : 'Game automation is disabled',
            lastLabel: 'Last action',
            lastValue: latestEventText(),
        };
    }
    function updateHud() {
        if (!hud) return;
        const s = activeStage();
        const tabHidden = running && document.hidden;
        const stageName = STAGE_NAMES[s] || 'Unknown stage';
        const model = stageHudModel(s);
        hud.classList.toggle('off', !running);
        hud.classList.toggle('hidden-tab', tabHidden);
        el.fbHeadState.textContent = tabHidden ? 'Tab hidden' : running ? 'Running' : 'Paused';
        el.fbHeadMeta.textContent = `v${BOT_VERSION} \u00b7 ${stageName}`;
        el.fbStage.textContent = stageName;
        el.fbDecision.textContent = tabHidden ? 'Tab is paused' : !running ? 'Script paused' : model.decision;
        el.fbDecision.className = `fb-decision${tabHidden || !running ? ' paused' : model.ready ? ' ready' : ''}`;
        el.fbDecisionDetail.textContent = tabHidden
            ? 'Return this tab to the foreground so the game clock can resume.'
            : !running
                ? 'No purchases or resets will be attempted until resumed.'
                : model.decisionDetail;
        el.fbMetricHeading.textContent = model.heading;
        model.metrics.forEach(([label, value], index) => {
            el['fbMetricLabel' + (index + 1)].textContent = label;
            el['fbMetricValue' + (index + 1)].textContent = value;
        });
        el.fbProgressWrap.hidden = !model.progress;
        if (model.progress) {
            el.fbProgressLabel.textContent = model.progress.label;
            el.fbProgressPct.textContent = model.progress.pct;
            el.fbProgressBar.style.width = `${model.progress.width}%`;
            el.fbProgressLeft.textContent = model.progress.left;
            el.fbProgressCurrent.textContent = model.progress.current;
            el.fbProgressTarget.textContent = model.progress.target;
        }
        el.fbTargetLabel.textContent = model.targetLabel;
        el.fbTargetValue.textContent = model.targetValue;
        el.fbTargetValue.className = `fb-target-value${model.ready ? ' ready' : ''}`;
        el.fbTargetDetail.textContent = model.targetDetail;
        el.fbSignal.textContent = model.signal;
        el.fbLastLabel.textContent = model.lastLabel;
        el.fbLastValue.textContent = model.lastValue;
        el.fbRunBtn.textContent = running ? 'Pause script' : 'Resume script';
    }

    // ---- Boot -----------------------------------------------------------------
    function boot() {
        if (!exists('makeAllFooter')) { setTimeout(boot, 500); return; } // wait for game UI
        buildHud();
        // expose manual controls for the console
        window.FundamentalBot = {
            version: BOT_VERSION,
            start,
            stop,
            tick,
            CONFIG,
            report,
            collapseReport,
            cycles: cycleLog,
            collapses: collapseLog,
            log: eventLog,
            exportSave: exportSaveFile,
            copyCollapseLog,
            installLatest: openUpdateUrl,
        };
        if (CONFIG.autoStart) start();
        console.log(`[Fundamental] Autoplayer v${BOT_VERSION} loaded. Collapse telemetry: window.FundamentalBot.collapseReport().`);
    }

    boot();
})();
