// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.5.1
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
 * Even hidden buttons (on inactive tabs) still fire their click listeners, so we
 * never need to switch tabs to act.
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
 *   which the browser FREEZES while the tab is hidden/backgrounded. The bot keeps
 *   clicking, but the game clock only ticks while its tab is visible. For
 *   continuous play, leave the game in its own focused window/tab. Brief switches
 *   are fine — on return the game grants "offline time" (auto-accepted here).
 */

(function () {
    'use strict';

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
        highStageResets: false, // stages 4-6 (collapse/merge/nucleation) are major prestige
                                // resets with their own optimal-timing logic. Leave false to
                                // let the GAME's auto-resets handle them; set true only if you
                                // want the bot to fire them whenever the button looks ready.
        verbose: false,         // log every action to console
    };

    // Text on a reset button that means "not ready yet".
    const NOT_READY = /requires|next goal|reach|need|self[- ]?made|locked|unlock|first|to unlock/i;

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
        return i > 0 ? i : 1;
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
        if (!box || box.offsetParent === null) return; // no dialog showing
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
        clickIf('createAllStrangeness');// all strangeness (active stage)
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

    // ---- Reset pass -----------------------------------------------------------
    // reset0 = discharge(1) / vaporization(2) / rank(3) / collapse(4) / merge(5) / nucleation(6).
    // Each stage's reset has a very different cost/benefit, so they are handled
    // individually rather than spammed uniformly.
    let prevStage = 0;
    function fastResets() {
        const s = activeStage();
        if (s !== 2 && prevStage === 2) resetVaporTracking(); // left stage 2 — start fresh on return
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
        } else if (CONFIG.highStageResets && resetReady('reset0Button')) {
            // Collapse / merge / nucleation: big prestige resets. Off by default —
            // prefer the game's own auto-resets, which time these optimally.
            clickIf('reset0Button');
            log('high-stage reset', s);
        }
    }

    function slowResets() {
        if (CONFIG.doStageReset && resetReady('reset1Button')) {
            clickIf('reset1Button'); log('stage reset');
        }
        if (CONFIG.doEndReset && resetReady('reset2Button')) {
            clickIf('reset2Button'); log('end reset');
        }
    }

    // ---- Main loop ------------------------------------------------------------
    let mainTimer = null;
    let lastSlow = 0;
    let running = false;

    function tick() {
        try {
            tickCount++;
            acceptOfflineDialog();
            applySettings();
            buyEverything();
            fastResets();
            const now = Date.now();
            if (now - lastSlow >= CONFIG.slowResetEveryMs) {
                lastSlow = now;
                slowResets();
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
        pushLog('⏸ autoplayer stopped');
        updateHud();
        log('stopped');
    }

    // ---- HUD ------------------------------------------------------------------
    let hud = null;
    const el = {}; // cached field elements

    const HUD_CSS = `
    #fbHud{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;font-family:'Inter',system-ui,sans-serif;
        color:#e8edf6;--acc:#f4a93a;overflow:hidden;user-select:none;
        background:radial-gradient(1500px 860px at 72% -12%,color-mix(in srgb,var(--acc) 11%,#0d0b16) 0%,#0a0b13 56%,#06060c 100%);}
    #fbHud.min{bottom:auto;}
    #fbHud .fb-mono{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-variant-numeric:tabular-nums;}
    #fbHead{display:flex;align-items:center;gap:14px;padding:14px 26px;flex:0 0 auto;
        background:linear-gradient(90deg,color-mix(in srgb,var(--acc) 22%,transparent),transparent 60%);border-bottom:1px solid rgba(255,255,255,.08);}
    .fb-orb{width:38px;height:38px;border-radius:50%;flex:0 0 auto;background:radial-gradient(circle at 32% 30%,#ffffffaa,var(--acc) 50%,#000a 96%);
        box-shadow:0 0 18px color-mix(in srgb,var(--acc) 55%,transparent),inset -5px -5px 10px rgba(0,0,0,.4);}
    #fbStage{font-size:19px;font-weight:700;color:#fff;line-height:1.1;}
    #fbSub{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--acc);opacity:.92;}
    .fb-res{margin-left:auto;text-align:right;}
    .fb-res .l{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#8a93a8;}
    .fb-res .v{font-size:20px;font-weight:700;color:#fff;}
    #fbBot{display:flex;align-items:center;gap:8px;padding:6px 11px;border-radius:10px;background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.22);}
    #fbBot.off{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.25);}
    #fbDot{width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80;flex:0 0 auto;animation:fbPulse 1.5s ease-in-out infinite;}
    #fbDot.off{background:#f87171;box-shadow:0 0 8px #f87171;animation:none;}
    @keyframes fbPulse{0%,100%{opacity:1;}50%{opacity:.4;}}
    .fb-bs{font-size:11px;font-weight:600;color:#dfe7f4;}
    .fb-bm{font-size:9px;color:#9aa3b8;}
    .fb-hb{cursor:pointer;color:#aab4c8;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);font-size:12px;}
    .fb-hb:hover{color:#fff;background:rgba(255,255,255,.12);}
    #fbBody{flex:1 1 auto;overflow:auto;padding:18px 26px 22px;display:flex;flex-direction:column;gap:16px;}
    #fbHud.min #fbBody{display:none;}
    #fbChips{display:flex;gap:9px;flex-wrap:wrap;}
    .fb-chip{flex:1;min-width:92px;padding:8px 11px;border-radius:11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);}
    .fb-chip .k{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#828ba0;white-space:nowrap;}
    .fb-chip .v{font-size:15px;font-weight:600;color:#fff;margin-top:2px;white-space:nowrap;}
    .fb-cols{display:grid;grid-template-columns:1fr 400px;gap:20px;align-items:start;flex:1 1 auto;}
    @media(max-width:880px){#fbHud .fb-cols{grid-template-columns:1fr;}}
    #fbRows{display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:9px;}
    .fb-t{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a93a8;margin-bottom:9px;display:flex;align-items:center;gap:8px;}
    .fb-t::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,rgba(255,255,255,.12),transparent);}
    .fb-glass{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:13px 15px;}
    .fb-brow{display:grid;grid-template-columns:34px 1fr auto 40px;gap:11px;align-items:center;padding:9px 11px;border-radius:11px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);}
    .fb-brow.lk{opacity:.4;}
    .fb-bi{width:34px;height:34px;image-rendering:pixelated;border-radius:7px;object-fit:contain;}
    .fb-bn{font-size:14px;font-weight:600;color:#fff;display:flex;align-items:center;gap:7px;}
    .fb-own{font-size:10px;font-weight:600;color:var(--acc);background:color-mix(in srgb,var(--acc) 16%,transparent);padding:1px 7px;border-radius:20px;}
    .fb-bsub{font-size:11px;color:#9aa3b8;margin-top:2px;}
    .fb-bsub .fb-pr{color:#7fdca0;}
    .fb-bcost{text-align:right;font-size:11px;color:#aeb6c8;line-height:1.35;}
    .fb-bcost b{color:#fff;font-weight:600;}
    .fb-tgl{width:38px;height:21px;border-radius:20px;background:rgba(74,222,128,.2);border:1px solid rgba(74,222,128,.4);position:relative;}
    .fb-tgl::after{content:'';position:absolute;top:2px;right:2px;width:15px;height:15px;border-radius:50%;background:#4ade80;}
    .fb-tgl.off{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);}
    .fb-tgl.off::after{left:2px;right:auto;background:#6b7280;}
    #fbEffect{margin-top:4px;padding:8px 12px;border-radius:10px;background:rgba(160,90,255,.08);border:1px solid rgba(160,90,255,.16);font-size:11px;color:#c9b8f0;}
    .fb-rcard{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:11px 14px;margin-bottom:11px;}
    .fb-rh{display:flex;align-items:center;gap:9px;margin-bottom:6px;}
    .fb-rt{font-size:12px;font-weight:700;color:#fff;}
    .fb-tag{margin-left:auto;font-size:9px;letter-spacing:.5px;text-transform:uppercase;padding:3px 9px;border-radius:20px;}
    .fb-tag.done{background:rgba(74,222,128,.15);color:#7fdca0;}
    .fb-tag.wait{background:color-mix(in srgb,var(--acc) 15%,transparent);color:var(--acc);}
    .fb-rd{font-size:10.5px;color:#97a0b4;line-height:1.45;margin-bottom:7px;}
    .fb-bar{height:7px;border-radius:5px;background:rgba(255,255,255,.07);overflow:hidden;margin:7px 0 5px;}
    .fb-bar>i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,var(--acc),#ffffff88);}
    .fb-rs{display:flex;justify-content:space-between;font-size:10.5px;color:#aeb6c8;}
    .fb-rs b{color:#fff;}
    .fb-reward{font-size:11px;color:#c9b8f0;margin-top:7px;}
    #fbSpark{display:flex;align-items:flex-end;gap:2px;height:30px;margin-top:7px;}
    #fbSpark i{flex:1;background:linear-gradient(180deg,var(--acc),#ffffff55);border-radius:2px;min-height:2px;opacity:.85;}
    #fbNav{display:flex;gap:8px;align-items:center;}
    .fb-nav{padding:7px 16px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);font-size:12px;color:#cfd6e6;cursor:pointer;}
    .fb-nav:hover{background:rgba(255,255,255,.1);color:#fff;}
    #fbLog{display:flex;flex-direction:column;gap:2px;max-height:80px;overflow-y:auto;background:rgba(0,0,0,.22);border-radius:8px;padding:6px 9px;}
    #fbLog div{font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#bcd0ec;font-family:ui-monospace,Menlo,monospace;}
    #fbLog time{color:#6f86a8;margin-right:5px;}
    #fbLog::-webkit-scrollbar{width:6px;}#fbLog::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px;}
    `;

    // ---- small HUD helpers ----
    const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
    const RESET0_NAME = ['', 'Discharge', 'Vaporization', 'Rank', 'Collapse', 'Merge', 'Nucleation'];
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const statText = (id) => { const e = $(id); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
    const splitStat = (txt) => { const i = txt.indexOf(':'); return i < 0 ? ['', txt] : [txt.slice(0, i).trim(), txt.slice(i + 1).trim()]; };
    const fmtNum = (n) => (n >= 1e6 || (n > 0 && n < 1e-3)) ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const trimDesc = (t) => { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > 96 ? t.slice(0, 95) + '…' : t; };

    function buildHud() {
        const style = document.createElement('style');
        style.textContent = HUD_CSS;
        document.head.appendChild(style);

        const rows = [];
        for (let i = 1; i <= 6; i++) {
            rows.push(`<div class="fb-brow" id="fbB${i}" style="display:none">
                <img class="fb-bi" id="fbB${i}Icon" alt="">
                <div><div class="fb-bn"><span id="fbB${i}Name"></span><span class="fb-own" id="fbB${i}Own"></span></div>
                <div class="fb-bsub fb-mono"><span id="fbB${i}Cur"></span> · <span class="fb-pr" id="fbB${i}Prod"></span></div></div>
                <div class="fb-bcost fb-mono" id="fbB${i}Cost"></div>
                <div class="fb-tgl" id="fbB${i}Tgl"></div></div>`);
        }

        hud = document.createElement('div');
        hud.id = 'fbHud';
        hud.innerHTML = `
            <div id="fbHead">
                <div class="fb-orb"></div>
                <div><div id="fbStage">—</div><div id="fbSub">—</div></div>
                <div class="fb-res"><div class="l" id="fbResLbl">—</div><div class="v fb-mono" id="fbResVal">—</div></div>
                <div id="fbBot"><span id="fbDot"></span><div><div class="fb-bs" id="fbState">—</div><div class="fb-bm fb-mono" id="fbMeta">—</div></div></div>
                <span class="fb-hb" id="fbToggle">⏸</span>
                <span class="fb-hb" id="fbMin">▁</span>
            </div>
            <div id="fbBody">
                <div id="fbChips"></div>
                <div class="fb-cols">
                    <div class="fb-glass">
                        <div class="fb-t">Structures</div>
                        <div id="fbRows">${rows.join('')}</div>
                        <div id="fbEffect" style="display:none"></div>
                    </div>
                    <div>
                        <div class="fb-t">Resets</div>
                        <div class="fb-rcard">
                            <div class="fb-rh"><span class="fb-rt" id="fbR0t">Reset</span><span class="fb-tag" id="fbR0tag"></span></div>
                            <div class="fb-rd" id="fbR0d"></div>
                            <div class="fb-rs"><span id="fbR0s" class="fb-mono"></span></div>
                        </div>
                        <div class="fb-rcard">
                            <div class="fb-rh"><span class="fb-rt">Stage reset</span><span class="fb-tag" id="fbR1tag"></span></div>
                            <div class="fb-rd" id="fbR1d"></div>
                            <div class="fb-bar" id="fbR1bar"><i id="fbR1barI" style="width:0%"></i></div>
                            <div class="fb-rs"><span id="fbR1cur" class="fb-mono"></span><span id="fbR1req" class="fb-mono"></span></div>
                            <div class="fb-reward" id="fbR1reward"></div>
                        </div>
                        <div class="fb-rcard" id="fbVap" style="margin-bottom:0">
                            <div class="fb-rh"><span class="fb-rt">Vaporization ρ</span><span class="fb-tag wait fb-mono" id="fbVtag">—</span></div>
                            <div id="fbSpark"></div>
                        </div>
                    </div>
                </div>
                <div id="fbNav">
                    <span class="fb-nav" id="fbNavStage">Stage</span>
                    <span class="fb-nav" id="fbNavUpg">Upgrade</span>
                    <span class="fb-nav" id="fbNavSet">Settings</span>
                    <span style="margin-left:auto;font-size:10px;color:#6b7280" class="fb-mono">Fundamental Bot</span>
                </div>
                <div id="fbLog"></div>
            </div>`;
        document.body.appendChild(hud);

        const ids = ['fbStage', 'fbSub', 'fbResLbl', 'fbResVal', 'fbBot', 'fbDot', 'fbState', 'fbMeta',
            'fbToggle', 'fbChips', 'fbEffect', 'fbR0t', 'fbR0tag', 'fbR0d', 'fbR0s', 'fbR1tag', 'fbR1d',
            'fbR1bar', 'fbR1barI', 'fbR1cur', 'fbR1req', 'fbR1reward', 'fbVap', 'fbVtag', 'fbSpark', 'fbLog'];
        for (let i = 1; i <= 6; i++) ids.push('fbB' + i, 'fbB' + i + 'Icon', 'fbB' + i + 'Name', 'fbB' + i + 'Own', 'fbB' + i + 'Cur', 'fbB' + i + 'Prod', 'fbB' + i + 'Cost', 'fbB' + i + 'Tgl');
        ids.forEach((id) => { el[id] = $(id); });

        el.fbToggle.onclick = () => (running ? stop() : start());
        $('fbMin').onclick = () => { hud.classList.toggle('min'); localStorage.setItem('fbHudMin', hud.classList.contains('min') ? '1' : '0'); };
        if (localStorage.getItem('fbHudMin') === '1') hud.classList.add('min');
        $('fbNavStage').onclick = () => clickIf('stageTab');
        $('fbNavUpg').onclick = () => clickIf('upgradeTab');
        $('fbNavSet').onclick = () => clickIf('settingsTab');

        updateHud();
    }

    let lastLogLen = -1;
    const lastIcon = {};
    function updateHud() {
        if (!hud) return;
        const s = activeStage();
        const sw = $('stageWord');
        hud.style.setProperty('--acc', sw ? getComputedStyle(sw).color : '#f4a93a');

        // header
        el.fbStage.textContent = sw ? sw.textContent.trim() : (STAGE_NAMES[s] || '—');
        el.fbSub.textContent = `Stage ${ROMAN[s] || s} · ${RESET0_NAME[s] || ''}`;
        const [l1, v1] = splitStat(statText('footerStat1'));
        el.fbResLbl.textContent = l1 || 'Resource';
        el.fbResVal.textContent = v1 || '—';
        el.fbBot.className = running ? '' : 'off';
        el.fbDot.className = running ? '' : 'off';
        el.fbState.textContent = running ? 'Bot running' : 'Bot paused';
        el.fbMeta.textContent = (running && startTs ? fmtDur((Date.now() - startTs) / 1000) : '—') + ' · ' + tickCount.toLocaleString() + ' ticks';
        el.fbToggle.textContent = running ? '⏸' : '▶';

        // chips: live footer resources (skip "Missing") + strange gain + stage time
        const chips = [];
        ['footerStat1', 'footerStat2', 'footerStat3'].forEach((id) => {
            const [k, v] = splitStat(statText(id));
            if (k && k !== 'Missing' && v) chips.push([k, v]);
        });
        const sg = textOf('strange0Gain'); if (sg) chips.push(['Strange ◆', '+' + sg + '/reset']);
        const stime = textOf('stageTime'); if (stime) chips.push(['Stage time', stime.replace(/stage time:?/i, '').trim() || stime]);
        el.fbChips.innerHTML = chips.slice(0, 5).map(([k, v]) =>
            `<div class="fb-chip"><div class="k">${esc(k)}</div><div class="v fb-mono">${esc(v)}</div></div>`).join('');

        // structures
        for (let i = 1; i <= 6; i++) {
            const gameRow = $('building' + i);
            const name = textOf('building' + i + 'Name');
            if (!gameRow || gameRow.offsetParent === null || !name) { el['fbB' + i].style.display = 'none'; continue; }
            el['fbB' + i].style.display = '';
            const icon = gameRow.querySelector('img');
            if (icon) { const src = icon.getAttribute('src'); if (lastIcon[i] !== src) { el['fbB' + i + 'Icon'].src = src; lastIcon[i] = src; } }
            el['fbB' + i + 'Name'].textContent = name;
            const own = textOf('building' + i + 'True');
            el['fbB' + i + 'Own'].textContent = (own && own !== '[0]') ? own.replace(/[\[\]]/g, '×') : '';
            el['fbB' + i + 'Cur'].textContent = textOf('building' + i + 'Cur') + ' held';
            el['fbB' + i + 'Prod'].textContent = '▲ ' + textOf('building' + i + 'Prod') + '/s';
            const buyX = textOf('building' + i + 'BuyX'), cost = textOf('building' + i + 'Btn');
            el['fbB' + i].classList.toggle('lk', /lock/i.test(buyX) || /unlocked with/i.test(cost));
            el['fbB' + i + 'Cost'].innerHTML = esc(cost).replace(/^(Need:?\s*)/i, 'Need<br>').replace(/(Unlocked with\s*)/i, 'Unlock via<br>');
            el['fbB' + i + 'Tgl'].className = 'fb-tgl' + (/\bON\b/.test(textOf('toggleBuilding' + i).toUpperCase()) ? '' : ' off');
        }

        // stage effect note
        const eff = textOf('stageInfo');
        el.fbEffect.style.display = eff ? '' : 'none';
        if (eff) el.fbEffect.textContent = trimDesc(eff);

        // reset0 card (discharge/vaporize/rank/collapse/merge/nucleation)
        const r0btn = textOf('reset0Button');
        el.fbR0t.textContent = RESET0_NAME[s] || 'Reset';
        el.fbR0d.textContent = trimDesc(textOf('reset0Main'));
        el.fbR0s.textContent = r0btn || '—';
        const r0done = /max|achieved/i.test(r0btn);
        el.fbR0tag.textContent = r0done ? 'Max' : (resetReady('reset0Button') ? 'Ready' : 'Waiting');
        el.fbR0tag.className = 'fb-tag ' + (r0done || resetReady('reset0Button') ? 'done' : 'wait');

        // reset1 card (stage reset) with progress bar
        const r1btn = textOf('reset1Button');
        el.fbR1d.textContent = trimDesc(textOf('reset1Main'));
        const r1ready = resetReady('reset1Button');
        el.fbR1tag.textContent = r1ready ? 'Ready' : 'Waiting';
        el.fbR1tag.className = 'fb-tag ' + (r1ready ? 'done' : 'wait');
        const m = r1btn.match(/([\d.eE+]+)\s*([A-Za-z]+)/);
        let curVal = null, unit = m ? m[2] : null;
        if (unit) ['footerStat1', 'footerStat2', 'footerStat3'].forEach((id) => {
            const [k, v] = splitStat(statText(id));
            if (k && k.toLowerCase() === unit.toLowerCase()) curVal = numFromText(v);
        });
        if (m && curVal != null && parseFloat(m[1]) > 0) {
            el.fbR1bar.style.display = '';
            el.fbR1barI.style.width = (Math.max(0, Math.min(1, curVal / parseFloat(m[1]))) * 100).toFixed(1) + '%';
            el.fbR1cur.textContent = fmtNum(curVal) + ' ' + unit;
            el.fbR1req.innerHTML = 'need <b>' + esc(m[1]) + '</b>';
        } else {
            el.fbR1bar.style.display = 'none';
            el.fbR1cur.textContent = r1btn;
            el.fbR1req.textContent = '';
        }
        const rew = textOf('reset1Main').match(/gain ([\d.eE+]+) Strange quark/i);
        el.fbR1reward.textContent = rew ? ('◆ +' + rew[1] + ' Strange quark' + (rew[1] === '1.00000' ? '' : 's')) : '';

        // vaporization card (meaningful on stage 2)
        const onS2 = s === 2;
        el.fbVap.style.opacity = onS2 ? '1' : '.45';
        if (onS2) {
            const boost = readNum('#vaporizationBoostTotal > span');
            const elapsed = vapLastTs ? (Date.now() - vapLastTs) / 1000 : 0;
            const rho = boost && boost > 1 && elapsed > 0 ? Math.log(boost) / elapsed : 0;
            el.fbVtag.textContent = (boost != null ? boost.toFixed(2) + '×' : '—') + ' · ρ ' + rho.toFixed(4);
        } else {
            el.fbVtag.textContent = cycleLog.length ? ('μρ ' + (cycleLog.reduce((a, r) => a + r.rho, 0) / cycleLog.length).toFixed(4)) : 'idle';
        }
        const recent = cycleLog.slice(-30);
        if (recent.length) {
            const mx = Math.max(...recent.map((r) => r.rho)) || 1;
            el.fbSpark.innerHTML = recent.map((r) => `<i style="height:${Math.max(2, Math.round(r.rho / mx * 28))}px"></i>`).join('');
        }

        // event log (re-render on change)
        if (eventLog.length !== lastLogLen) {
            lastLogLen = eventLog.length;
            el.fbLog.innerHTML = eventLog.slice(-8).reverse().map((e) => {
                const d = new Date(e.t);
                const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                return `<div><time>${ts}</time>${esc(e.msg)}</div>`;
            }).join('');
        }
    }

    // ---- Boot -----------------------------------------------------------------
    function boot() {
        if (!exists('makeAllFooter')) { setTimeout(boot, 500); return; } // wait for game UI
        buildHud();
        // expose manual controls for the console
        window.FundamentalBot = { start, stop, tick, CONFIG, report, cycles: cycleLog, log: eventLog };
        if (CONFIG.autoStart) start();
        console.log('[Fundamental] Autoplayer loaded. Use the on-screen HUD or window.FundamentalBot.start()/.stop()/.report().');
    }

    boot();
})();
