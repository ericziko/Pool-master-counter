// The scoreboard's Now Playing line: "Now playing [game] target [n] [unit]", the controls in the
// line's own big accent type, kept in step with Game Setup both ways; plain text while a Rotation runs.
// usage: node tests/probe_now_playing.js http://localhost:4235/ <screenshot dir>
const puppeteer = require("puppeteer-core");
const EXE = "/Users/lucmartin/.cache/puppeteer/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = process.argv[2], OUT = process.argv[3];
let fails = 0;
function check(label, ok, extra) { console.log((ok ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); if (!ok) fails++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "manifest.json");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("poolMasterCounter.onboardingSeen.v1", "1"); localStorage.setItem("poolMasterCounter.migratedFromRepo.v1", "1"); });
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await sleep(600);
  await page.evaluate(async () => {
    for (const n of ["Alex", "Sam"]) {
      const input = document.getElementById("new-player-name"), btn = document.getElementById("btn-add-player");
      input.value = n; input.dispatchEvent(new Event("input", { bubbles: true })); btn.disabled = false; btn.click();
      await new Promise((r) => setTimeout(r, 250));
    }
    document.querySelectorAll("#roster-list li.roster-row .btn-playing:not(.is-on)").forEach((b) => b.click());
  });
  await sleep(600);
  const line = () => page.evaluate(() => {
    const b = document.getElementById("now-playing-banner");
    const parts = [];
    b.childNodes.forEach((n) => {
      if (n.nodeType === 3) parts.push(n.textContent);
      else if (n.tagName === "SELECT") parts.push("[" + n.options[n.selectedIndex].text + " v]");
      else if (n.tagName === "INPUT") parts.push("[" + n.value + "]");
      else if (n.classList && n.classList.contains("now-playing-value")) parts.push("{" + n.textContent + "}");
    });
    return parts.join("").replace(/\s+/g, " ").trim();
  });
  const styleOf = () => page.evaluate(() => {
    const b = document.getElementById("now-playing-banner"), bs = getComputedStyle(b);
    return { banner: [bs.fontSize, bs.fontWeight, bs.color], controls: [...b.querySelectorAll(".now-playing-control")].map((c) => { const s = getComputedStyle(c); return [c.tagName, s.fontSize, s.fontWeight, s.color]; }) };
  });
  const setup = () => page.evaluate(() => ({ type: document.getElementById("game-type").value, target: document.getElementById("game-target").value, unit: document.getElementById("game-target-unit-select").value, saved: JSON.parse(localStorage.getItem("poolMasterCounter.state.v2")).currentGame }));

  let t = await line();
  console.log("line:", t);
  // a game with a target
  await page.select("#now-playing-banner select.now-playing-type-select", "straight");
  await sleep(500);
  t = await line();
  check("Straight Pool: Now playing [game] target [n] [unit]", /^🎱 Now playing \[Straight Pool v\] target \[100\] \[points v\]$/.test(t), t);
  let st = await styleOf();
  check("the controls use the line's own size, weight and colour", st.controls.length === 3 && st.controls.every((c) => c[1] === st.banner[0] && c[2] === st.banner[1] && c[3] === st.banner[2]), st);
  if (OUT) { const el = await page.$("#now-playing-banner"); await el.screenshot({ path: OUT + "/now_playing_1280.png" }); }
  // the target from the line
  await page.evaluate(() => { const i = document.querySelector("#now-playing-banner .now-playing-target-input"); i.value = "75"; i.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(400);
  let s = await setup();
  check("target typed on the line: saved, Game Setup shows it", s.saved.target === 75 && s.target === "75" && /target \[75\]/.test(await line()), { saved: s.saved.target, field: s.target, line: await line() });
  await page.select("#now-playing-banner select.now-playing-unit-select", "balls");
  await sleep(400);
  s = await setup();
  check("unit picked on the line: saved, Game Setup shows it", s.saved.unit === "balls" && s.unit === "balls" && /\[balls v\]$/.test(await line()), { saved: s.saved.unit, field: s.unit, line: await line() });
  // and the other way: Game Setup's own target field
  await page.evaluate(() => { const i = document.getElementById("game-target"); i.value = "120"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(400);
  check("Game Setup's target shows on the line", /target \[120\]/.test(await line()), await line());
  // nonsense in the line's field is put back
  await page.evaluate(() => { const i = document.querySelector("#now-playing-banner .now-playing-target-input"); i.value = "0"; i.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(300);
  check("0 isn't taken: back to 120", (await setup()).saved.target === 120 && /target \[120\]/.test(await line()), await line());
  // a one-rack game: no target
  await page.select("#now-playing-banner select.now-playing-type-select", "8ball");
  await sleep(400);
  t = await line();
  check("8 Ball: just Now playing [game]", /^🎱 Now playing \[8-Ball v\]$/.test(t), t);
  // phone width
  await page.select("#now-playing-banner select.now-playing-type-select", "straight");
  await sleep(300);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(500);
  if (OUT) { const el = await page.$("#now-playing-banner"); await el.screenshot({ path: OUT + "/now_playing_390.png" }); }
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: innerWidth }));
  check("no sideways scroll at 390", w.doc <= w.win, w);
  await page.setViewport({ width: 1280, height: 900 });
  // a Rotation running: plain text
  await page.evaluate(() => { const r = document.getElementById("rotation-enabled"); if (!r.checked) r.click(); });
  await sleep(600);
  t = await line();
  const controls = await page.evaluate(() => document.querySelectorAll("#now-playing-banner .now-playing-control").length);
  console.log("rotation line:", t);
  check("Rotation on: no controls on the line, the same words as text", controls === 0 && /^🎱 Now playing \{[^}]+\}/.test(t), { controls, t });
  await page.evaluate(() => { const r = document.getElementById("rotation-enabled"); if (r.checked) r.click(); });
  await sleep(400);
  // French
  await page.evaluate(() => { localStorage.setItem("poolMasterCounter.language", "fr"); });
  check("no page errors", errors.length === 0, errors);
  console.log(fails ? "NOW_PLAYING_FAIL (" + fails + ")" : "NOW_PLAYING_OK");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
