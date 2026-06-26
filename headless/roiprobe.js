// Loads the user's real save and quantifies the strangeness ROI fork.
const fs = require("fs");
const E = require("./engine.js");
const { P, player, global, Stage, U, num } = E;
const SP = require("./build/Special");

const SAVE = process.argv[2] || "/Users/spencer/Downloads/Fundamental, 24.06.2026 16-56-29, Interstellar.txt";
const raw = fs.readFileSync(SAVE, "utf8").trim();

function load() {
  const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  P.updatePlayer(obj, true);
  global.paused = false; global.offline.active = false;
  player.toggles.confirm = player.toggles.confirm.map(() => "None");
  U.stageUpdate(); SP.checkProgress();
}

function refresh() {
  // recompute the caches that feed strange0Gain
  Stage.assignResetInformation.quarksGain();
}
const q = () => { refresh(); return global.strangeInfo.strange0Gain; };

load();
console.log("LOADED stage.current=%d active=%d prog.main=%d", player.stage.current, player.stage.active, player.progress.main);
console.log("strange cur/total = %s / %s", player.strange[0].current.toFixed(3), player.strange[0].total.toFixed(3));
console.log("strangeness[4]=%j strangeness[5]=%j", player.strangeness[4], player.strangeness[5]);
console.log("strange0Gain (quarks per stage reset, NOW) = %s", q().toFixed(4));
console.log("collapse.mass=%s stars=%j highest=%d", num(player.collapse.mass).toExponential(2), player.collapse.stars, player.collapse.highest);

// --- quantify strange3Stage5 (the 1.4^lvl quark multiplier), s5 idx2 ---
const before = q();
const baseLvl = player.strangeness[5][2];
player.strangeness[5][2] = baseLvl + 1;
const after1 = q();
player.strangeness[5][2] = baseLvl + 2; // max is 2
const after2 = q();
player.strangeness[5][2] = baseLvl; // restore
console.log("\n-- strange3Stage5 multiplier (s5 idx2, max2) --");
console.log("quarks/reset: lvl%d=%s  +1=%s (x%s)  +2=%s (x%s)",
  baseLvl, before.toFixed(4), after1.toFixed(4), (after1/before).toFixed(3), after2.toFixed(4), (after2/before).toFixed(3));

// --- show the stage-4 local costs/maxes and whether any touch the quark formula ---
const s4 = global.strangenessInfo[4];
console.log("\n-- stage-4 strangeness (current owned / max @ cost) --");
for (let i = 0; i < s4.max.length; i++) {
  console.log("  s4[%d] %d/%d  cost=%s", i, player.strangeness[4][i], s4.max[i], String(s4.cost[i]));
}
console.log("target strange7Stage4 = s4 idx6: owned=%d cost=%s", player.strangeness[4][6], String(s4.cost[6]));
const s5 = global.strangenessInfo[5];
console.log("multiplier strange3Stage5 = s5 idx2: owned=%d cost=%s", player.strangeness[5][2], String(s5.cost[2]));
