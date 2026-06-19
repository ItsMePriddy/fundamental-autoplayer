// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.3.0
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
        vaporizeMode: 'adaptive', // stage 2 timing: 'adaptive' (recommended, speed-optimal)
                                // maximizes the realized growth rate ln(boost)/elapsed and
                                // self-tunes to the rebuild ramp + softcap; 'fixed' uses the
                                // vaporizeBoost threshold below.
        vaporizeBoost: 2,       // 'fixed' mode only: vaporize when the production boost reaches
                                // this multiple. 2 = the game's hands-off default (NOT speed-
                                // optimal — a full engine wipe per reset favors fewer/bigger
                                // resets, ~10-40x for Submerged). Adaptive avoids guessing it.
        vaporizeMinBoost: 1.5,  // adaptive: never fire a reset below this boost (skip worthless
                                // resets while the engine is still rebuilding).
        vaporizePeakDrop: 0.05, // adaptive: declare the peak passed (and vaporize) once
                                // ln(boost)/elapsed falls this fraction below its running max.
                                // Smaller = fires nearer the exact peak (higher efficiency)
                                // but more sensitive to noise; in-game production is smooth,
                                // so this can go low. Tune from window.FundamentalBot.report().
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
    #fbHud{position:fixed;z-index:2147483600;width:268px;font-family:ui-monospace,Menlo,Consolas,monospace;
        font-size:11px;color:#cfe8ff;background:linear-gradient(160deg,rgba(18,22,38,.94),rgba(12,14,26,.96));
        border:1px solid rgba(120,170,255,.28);border-radius:12px;backdrop-filter:blur(8px);
        box-shadow:0 8px 28px rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.03);overflow:hidden;user-select:none;}
    #fbHead{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:grab;
        background:linear-gradient(90deg,rgba(80,120,255,.20),rgba(160,90,255,.12));border-bottom:1px solid rgba(120,170,255,.18);}
    #fbHead:active{cursor:grabbing;}
    #fbDot{width:9px;height:9px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80;flex:0 0 auto;}
    #fbDot.off{background:#f87171;box-shadow:0 0 8px #f87171;animation:none;}
    #fbDot.on{animation:fbPulse 1.4s ease-in-out infinite;}
    @keyframes fbPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.45;transform:scale(.78);}}
    #fbTitle{font-weight:700;letter-spacing:.3px;color:#eaf2ff;flex:1;font-size:12px;}
    .fbHbtn{cursor:pointer;color:#9fb6d6;padding:1px 6px;border-radius:6px;border:1px solid rgba(120,170,255,.25);
        background:rgba(255,255,255,.04);font-size:11px;}
    .fbHbtn:hover{color:#fff;background:rgba(120,170,255,.22);}
    #fbBody{padding:8px 10px 10px;display:flex;flex-direction:column;gap:9px;}
    .fbSec{display:flex;flex-direction:column;gap:3px;}
    .fbSecT{font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#7fa8d8;opacity:.8;margin-bottom:1px;}
    .fbRow{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}
    .fbRow b{color:#fff;font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .fbK{color:#9fb6d6;flex:0 0 auto;}
    #fbStage{font-weight:700;}
    #fbSpark{display:flex;align-items:flex-end;gap:1px;height:26px;margin-top:2px;
        background:rgba(255,255,255,.03);border-radius:5px;padding:2px 3px;}
    #fbSpark i{flex:1;background:linear-gradient(180deg,#67e8f9,#6366f1);border-radius:1px;min-height:1px;opacity:.85;}
    #fbLog{display:flex;flex-direction:column;gap:2px;max-height:108px;overflow-y:auto;
        background:rgba(0,0,0,.25);border-radius:6px;padding:5px 6px;}
    #fbLog div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#bcd0ec;}
    #fbLog time{color:#6f86a8;margin-right:5px;}
    #fbHud.min #fbBody{display:none;}
    #fbLog::-webkit-scrollbar{width:6px;}#fbLog::-webkit-scrollbar-thumb{background:rgba(120,170,255,.3);border-radius:3px;}
    `;

    function row(k, id) {
        return `<div class="fbRow"><span class="fbK">${k}</span><b id="${id}">—</b></div>`;
    }

    function buildHud() {
        const style = document.createElement('style');
        style.textContent = HUD_CSS;
        document.head.appendChild(style);

        hud = document.createElement('div');
        hud.id = 'fbHud';
        hud.innerHTML = `
            <div id="fbHead">
                <span id="fbDot"></span>
                <span id="fbTitle">⚛ Fundamental Bot</span>
                <span class="fbHbtn" id="fbToggle">⏸</span>
                <span class="fbHbtn" id="fbMin">▁</span>
            </div>
            <div id="fbBody">
                <div class="fbSec">
                    <div class="fbSecT">Script</div>
                    ${row('State', 'fbState')}
                    ${row('Uptime', 'fbUptime')}
                    ${row('Ticks', 'fbTicks')}
                </div>
                <div class="fbSec">
                    <div class="fbSecT">Game</div>
                    <div class="fbRow"><span class="fbK">Stage</span><b id="fbStage">—</b></div>
                    ${row('', 'fbStat1')}
                    ${row('', 'fbStat2')}
                    ${row('', 'fbStat3')}
                    ${row('Goal', 'fbGoal')}
                </div>
                <div class="fbSec" id="fbVapSec">
                    <div class="fbSecT">Vaporization · <span id="fbVapMode">—</span></div>
                    ${row('Boost now', 'fbBoost')}
                    ${row('ρ now / peak', 'fbRho')}
                    ${row('In cycle', 'fbCyc')}
                    ${row('Mean ρ (n)', 'fbMean')}
                    <div id="fbSpark"></div>
                </div>
                <div class="fbSec">
                    <div class="fbSecT">Event log</div>
                    <div id="fbLog"></div>
                </div>
            </div>`;
        document.body.appendChild(hud);

        // cache fields
        ['fbDot','fbState','fbUptime','fbTicks','fbStage','fbStat1','fbStat2','fbStat3','fbGoal',
         'fbVapSec','fbVapMode','fbBoost','fbRho','fbCyc','fbMean','fbSpark','fbLog','fbToggle']
            .forEach((id) => { el[id] = $(id); });

        el.fbToggle.onclick = () => (running ? stop() : start());
        $('fbMin').onclick = () => {
            hud.classList.toggle('min');
            localStorage.setItem('fbHudMin', hud.classList.contains('min') ? '1' : '0');
        };
        if (localStorage.getItem('fbHudMin') === '1') hud.classList.add('min');

        // position (restore + draggable)
        const pos = localStorage.getItem('fbHudPos');
        if (pos) { try { const p = JSON.parse(pos); hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px'; } catch (e) { /* ignore */ } }
        else { hud.style.right = '10px'; hud.style.top = '64px'; }
        makeDraggable($('fbHead'));

        updateHud();
    }

    function makeDraggable(handle) {
        let sx, sy, ox, oy, dragging = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('fbHbtn')) return;
            dragging = true;
            const r = hud.getBoundingClientRect();
            ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
            hud.style.right = 'auto';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const x = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
            const y = Math.max(0, Math.min(window.innerHeight - 24, oy + e.clientY - sy));
            hud.style.left = x + 'px'; hud.style.top = y + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            const r = hud.getBoundingClientRect();
            localStorage.setItem('fbHudPos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
        });
    }

    function statText(id) { const e = $(id); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }

    let lastLogLen = -1;
    function updateHud() {
        if (!hud) return;
        // script
        el.fbDot.className = running ? 'on' : 'off';
        el.fbToggle.textContent = running ? '⏸' : '▶';
        el.fbToggle.title = running ? 'Pause autoplayer' : 'Start autoplayer';
        el.fbState.textContent = running ? 'running' : 'stopped';
        el.fbState.style.color = running ? '#4ade80' : '#f87171';
        el.fbUptime.textContent = running && startTs ? fmtDur((Date.now() - startTs) / 1000) : '—';
        el.fbTicks.textContent = tickCount.toLocaleString();

        // game
        const s = activeStage();
        const sw = $('stageWord');
        el.fbStage.textContent = sw ? sw.textContent.trim() : (STAGE_NAMES[s] || '—');
        if (sw) el.fbStage.style.color = getComputedStyle(sw).color;
        el.fbStat1.textContent = statText('footerStat1') || '—';
        el.fbStat2.textContent = statText('footerStat2') || '—';
        el.fbStat3.textContent = statText('footerStat3') || '—';
        el.fbGoal.textContent = textOf('reset0Button') || '—';

        // vaporization (only meaningful on stage 2)
        const onS2 = s === 2;
        el.fbVapSec.style.opacity = onS2 ? '1' : '0.4';
        el.fbVapMode.textContent = CONFIG.vaporizeMode;
        if (onS2) {
            const boost = readNum('#vaporizationBoostTotal > span');
            const elapsed = vapLastTs ? (Date.now() - vapLastTs) / 1000 : 0;
            const rho = boost && boost > 1 && elapsed > 0 ? Math.log(boost) / elapsed : 0;
            el.fbBoost.textContent = boost != null ? boost.toFixed(2) + '×' : '—';
            el.fbRho.textContent = `${rho.toFixed(4)} / ${vapPeakScore.toFixed(4)}`;
            el.fbCyc.textContent = fmtDur(elapsed) + ' s';
        } else {
            el.fbBoost.textContent = el.fbRho.textContent = el.fbCyc.textContent = '—';
        }
        if (cycleLog.length) {
            const m = cycleLog.reduce((a, r) => a + r.rho, 0) / cycleLog.length;
            el.fbMean.textContent = `${m.toFixed(4)} (${cycleLog.length})`;
        } else { el.fbMean.textContent = '—'; }

        // sparkline of recent ρ
        const recent = cycleLog.slice(-26);
        if (recent.length) {
            const max = Math.max(...recent.map((r) => r.rho)) || 1;
            el.fbSpark.innerHTML = recent.map((r) =>
                `<i style="height:${Math.max(2, Math.round((r.rho / max) * 24))}px"></i>`).join('');
        }

        // event log (only re-render on change)
        if (eventLog.length !== lastLogLen) {
            lastLogLen = eventLog.length;
            el.fbLog.innerHTML = eventLog.slice(-12).reverse().map((e) => {
                const d = new Date(e.t);
                const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                return `<div><time>${ts}</time>${e.msg}</div>`;
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
