// Wide parameter sweep — spawns many parameterized sweep.js runs concurrently
// (process-isolated, same as sweep.js's own multi-strategy mode) and reports
// throughput ranked by quarks/sim-hour. This is Phase 1 of the stage 2/4
// re-validation: cast a wide net across a single axis before assuming a
// hand-picked handful of constants (the old STRATEGIES table) bracket the
// true optimum.
//
// Usage:
//   node grid-sweep.js --axis=collapseMult --values=1.05,1.1,1.3,2,5,20,50,100
//   node grid-sweep.js --axis=vapBoost                      # default range
//   node grid-sweep.js --axis=collapseMult --simHours=24 --concurrency=6

const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
};

const AXIS = flag("axis", null);
if (AXIS !== "collapseMult" && AXIS !== "vapBoost") {
    console.error(`--axis must be "collapseMult" or "vapBoost" (got ${AXIS})`);
    process.exit(1);
}
// Default ranges span from near the shipped value through the theoretical
// prediction (renewal-reward-analysis.md: 50-150x for collapse) and beyond,
// log-spaced so low and high regions both get resolution.
const DEFAULT_VALUES = {
    collapseMult: [1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.75, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50, 75, 100, 150],
    vapBoost: [1.5, 1.75, 2.0, 2.25, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50],
};
const SHIPPED_VALUE = { collapseMult: 1.3, vapBoost: 2.25 };
const VALUES = (flag("values", null) || DEFAULT_VALUES[AXIS].join(",")).split(",").map(Number);
const SIM_HOURS = flag("simHours", "16");
const SECONDS = flag("seconds", "120");
const CONCURRENCY = Number(flag("concurrency", "6"));
const SWEEP_JS = path.join(__dirname, "sweep.js");

function runOne(value) {
    return new Promise((resolve) => {
        const childArgs = [SWEEP_JS, `--${AXIS}=${value}`, "--json=1", `--simHours=${SIM_HOURS}`, `--seconds=${SECONDS}`];
        const child = spawn(process.execPath, childArgs, { cwd: __dirname });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        child.on("close", () => {
            const marker = "__RESULT_JSON__";
            const idx = out.indexOf(marker);
            if (idx === -1) {
                resolve({ value, error: "no result reported", raw: out.slice(-500) });
                return;
            }
            try {
                resolve({ value, ...JSON.parse(out.slice(idx + marker.length).trim().split("\n")[0]) });
            } catch (e) {
                resolve({ value, error: `parse failure: ${e.message}` });
            }
        });
    });
}

async function runPool(values, concurrency) {
    const results = new Array(values.length);
    let next = 0, done = 0;
    await new Promise((resolveAll) => {
        const startNext = () => {
            if (next >= values.length) { if (done === values.length) resolveAll(); return; }
            const i = next++;
            runOne(values[i]).then((r) => {
                results[i] = r;
                done++;
                console.log(`  [${done}/${values.length}] ${AXIS}=${values[i]} -> ${r.error ? "ERROR: " + r.error : `${r.quarksPerSimHour.toFixed(2)} qks/simH, ${r.loops} loops, stopped=${r.stoppedBy}`}`);
                if (done === values.length) resolveAll(); else startNext();
            });
        };
        for (let c = 0; c < Math.min(concurrency, values.length); c++) startNext();
    });
    return results;
}

(async () => {
    console.log(`Grid sweep: axis=${AXIS} | ${VALUES.length} values | ${SIM_HOURS}h sim-time each | concurrency=${CONCURRENCY}`);
    console.log(`values: ${VALUES.join(", ")}`);
    console.log("");

    const results = await runPool(VALUES, CONCURRENCY);

    console.log("\n" + "=".repeat(90));
    console.log(`RESULTS — ranked by quarks/sim-hour (axis: ${AXIS}, shipped default: ${SHIPPED_VALUE[AXIS]})`);
    console.log("=".repeat(90));
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    ok.sort((a, b) => b.quarksPerSimHour - a.quarksPerSimHour);
    console.log(`${"Value".padEnd(10)} ${"Qks/simH".padStart(10)} ${"Stars/s".padStart(10)} ${"Loops".padStart(7)} ${"Stopped".padEnd(10)} ${"Warnings".padStart(9)}`);
    console.log("-".repeat(60));
    for (const r of ok) {
        const marker = r.value === SHIPPED_VALUE[AXIS] ? " <- shipped" : "";
        console.log(`${String(r.value).padEnd(10)} ${r.quarksPerSimHour.toFixed(2).padStart(10)} ${r.starsPerSec.toFixed(2).padStart(10)} ${String(r.loops).padStart(7)} ${r.stoppedBy.padEnd(10)} ${String(r.warnings.length).padStart(9)}${marker}`);
    }
    if (failed.length) {
        console.log(`\n⚠ ${failed.length} value(s) failed to report a result:`);
        for (const r of failed) console.log(`  ${r.value}: ${r.error}`);
    }
    const anomalies = ok.filter((r) => r.warnings.length > 0);
    if (anomalies.length) console.log(`\n⚠ ${anomalies.length} value(s) logged anomaly warnings — check before trusting their numbers.`);
    if (ok.length) {
        const best = ok[0];
        console.log(`\nBest: ${AXIS}=${best.value} at ${best.quarksPerSimHour.toFixed(2)} qks/simH`);
    }
})();
