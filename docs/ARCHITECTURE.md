# Pool Master Counter — Architecture

A reference for anyone (human or agent) picking this project up cold.

**Scope of this document.** Line references point at `js/app.js` as of commit
`9348bbd` — the version in the working tree when this was written
(branch `ez-add-agent-flywheel`, `b1177b7`, 2026-09-04). `origin/main` is
**2 commits ahead** of that (`ed5cadb`, `d1d5741`); see
[Recent drift](#recent-drift) for what those change. Everything else here was
verified against the repo, not inferred.

---

## Table of contents

- [Executive summary](#executive-summary)
- [Repository & branch topology](#repository--branch-topology)
- [Entry points and boot sequence](#entry-points-and-boot-sequence)
- [Key data structures](#key-data-structures)
- [Persistence](#persistence)
- [Core data flow](#core-data-flow)
- [Rendering model](#rendering-model)
- [Screen navigation](#screen-navigation)
- [Subsystem map](#subsystem-map)
- [Cross-cutting concerns](#cross-cutting-concerns)
- [Test infrastructure](#test-infrastructure)
- [The mobile_app branch](#the-mobile_app-branch)
- [Release pipeline](#release-pipeline)
- [Recent drift](#recent-drift)
- [Known discrepancies and risks](#known-discrepancies-and-risks)
- [How to run it](#how-to-run-it)

---

## Executive summary

A **zero-dependency, single-page, offline-first pool scorekeeper**. No
framework, no build step, no bundler, no `package.json`, no server. Three
files do essentially all the work, and every byte of user data lives in
`localStorage` on one device.

| | |
|---|---|
| `index.html` | 807 lines — markup for **all four screens** in one document |
| `css/style.css` | 3,506 lines — 10 themes as `:root[data-theme=…]` blocks |
| `js/app.js` | 8,926 lines / 343 KB — **one IIFE**, 354 top-level functions, 27 sections |
| `languages/*.json` | 4 dictionaries × **391 keys each, fully in sync** (0 missing, 0 extra) |
| Runtime deps | none — Web Audio API, inline SVG, `fetch`, History API, all native |

The app is deliberately dependency-free, and that constraint explains most of
its structure: the single IIFE, the hand-rolled SVG charting, the synthesized
audio, the manifest file that stands in for a directory listing, and the test
suite exiled to its own branch.

---

## Repository & branch topology

This checkout is a **fork**, and the interesting branches live on the upstream
remote, not on `origin`:

```
origin    git@github.com:ericziko/Pool-master-counter.git      → main only
upstream  https://github.com/lucas1313-git/Pool-master-counter → main, stable, release,
                                                                 tests, multilingual, mobile_app
```

`origin/main` and `upstream/main` are the same commit — the fork is even with
upstream.

`stable` and `release` are **content-snapshot** branches, not merge targets.
Each sync is a fresh copy commit, which is why they read as *ahead* of `main`
while being far behind it.

| Branch | vs `main` | Derived from | What it is |
|---|---|---|---|
| `stable` | +1 / −25 | `8a557b5` | Snapshot at a known-good point. Includes `languages/` |
| `release` | +8 / −40 | `8bd14cb` | Minified build — `js/app.js` 206 KB vs 343 KB |
| `tests` | +5 / −25 | `8a557b5` | Selenium/pytest suite. **No `languages/`** — predates i18n |
| `multilingual` | 0 / −22 | `cbf83e1` | Fully merged into `main`. Dead branch |
| `mobile_app` | +1 / −10 | `ff5636f` | Capacitor iOS shell + RevenueCat paywall |

**There is no build script and no CI on any branch.** No Makefile, no `.sh`, no
`.github/workflows`. The `release` minification and the `stable` sync are both
performed by hand, off-repo.

**Agent scaffolding is local-only.** `AGENTS.md` and `.beads/` exist on
`ez-add-agent-flywheel` and on no other branch or remote.

---

## Entry points and boot sequence

There are two, and the order matters.

**1. `index.html:12`** — an inline, synchronous pre-paint script. Reads
`poolMasterCounter.theme.v1` and stamps `data-theme` on `<html>` before the
stylesheet paints, so a saved theme never flashes the default look first.

**2. `js/app.js:8899`** — the real entry. Boot is gated on three parallel
fetches:

```
Promise.all([
  gameTypesPromise,             // settings/game-types.json → GAME_TYPES / GAME_TYPE_LIST
  migrateFromRepoIfNeeded(),    // one-time players/*.json → localStorage migration
  languagePromise               // manifest + English fallback + active dictionary
])
  → populateGameTypeSelects()
  → normalizeGameTypeDependentData()
  → applyDomTranslations(document)
  → boot()                      // js/app.js:8425
```

`boot()` runs the rating/date backfills, wires ~180 event listeners, then the
Init block at `js/app.js:8849` seeds form controls from state, applies any due
rotation, calls `renderAll()`, restores focus mode, and starts a 1-second
game-duration ticker.

> **Consequence:** because boot depends on `fetch`, the app will not start from
> a `file://` URL in browsers that block local-file fetches. It needs a static
> server. See [How to run it](#how-to-run-it).

---

## Key data structures

Five objects carry essentially everything.

| Structure | Defined at | Backing key | Purpose |
|---|---|---|---|
| `state` | `js/app.js:105` (`defaultState()`) | `poolMasterCounter.state.v2` | The **live session** |
| game-history entry | `js/app.js:2660` (built in `creditWin`) | inside `state` | One completed game |
| `PLAYER_STATS` | `js/app.js:3668` | `…playerStats.v1` | Career history, **name-keyed** |
| `PLAYER_RATINGS` | `js/app.js:3752` | `…ratings.v1` | Elo store, name-keyed |
| `TOURNAMENT` | `js/app.js:7311` | `…tournament.v1` | The single live bracket |

### `state`

```js
{
  players: [],            // { id, name, voice, playing, teamId, balls }
  playerWins: {},         // playerId  → wins this session
  teamWins: {},           // "A" | "B" → wins this session
  teamMvpWins: {},        // playerId  → MVP credits
  raceToWinsTarget: 5,
  currentGame: { gameType, target, unit, mode, startedAt },
  gameHistory: [],        // newest first, HARD CAPPED AT 200
  rotation: { enabled, order: [], every },
  gamesPlayedCount: 0
}
```

### Game-history entry

```js
{
  ts, gameType, gameLabel, target,
  winnerNames[], winnerIds[],
  isTeam, teamId, teamComboKey,
  opponentNames[],
  mvpId, mvpName,
  durationMs, summary,
  wonRace, raceTarget, raceCount,
  ballsLeftOnTable
}
```

This is the join point between the live session and every derived view —
career stats, the All Players graphs, head-to-head records, and the day report
are all computed from it plus `PLAYER_STATS`.

### `TOURNAMENT`

```js
{
  format: "double" | "single" | "roundrobin",
  createdAt, gameType, target, raceTo,
  players[], size,
  wb,                    // winners-bracket rounds
  lbRounds[], lbWaiting[], lbNextWbRoundToDrop,
  wbChampion, lbChampion, grandFinal[],
  champion, active
}
```

Single elimination reuses the double-elimination shape and simply starts
`lbNextWbRoundToDrop` past the final round, so the losers-bracket logic in
`advanceBracket` never fires (`js/app.js:7698`).

---

## Persistence

**13 active `localStorage` keys**, plus one legacy key read only for migration.
Every access is wrapped in `try`/`catch` — a quota-exceeded or
storage-disabled browser degrades rather than crashes.

| Key | Holds |
|---|---|
| `poolMasterCounter.state.v2` | live session (`state`) |
| `poolMasterCounter.state.v1` | **legacy, read-only** — migrated at `js/app.js:119` |
| `…theme.v1` | selected theme id |
| `…language.v1` | selected language code |
| `…focusMode` | `"1"` / `"0"` |
| `…dayNotes.v1` | date-keyed free-text notes |
| `…rosters.v1` | saved player lists |
| `…rotations.v1` | saved game-order rotations |
| `…playerStats.v1` | career sessions, name-keyed |
| `…ratings.v1` | Elo entries, name-keyed |
| `…playerAdded.v1` | first-seen dates, name-keyed |
| `…playerNameTranslations.v1` | per-language display names |
| `…tournament.v1` | the one live bracket |
| `…tournamentResults.v1` | archive of finished brackets |

The persistence section (`js/app.js:3486`–`3675`) is one `load*`/`save*` pair
per key, with no abstraction over them — deliberately flat and greppable.

`players/`, `stats/` hold legacy JSON from an era when data was committed to
the repo; they are read **once**, on a device with no existing localStorage, by
`migrateFromRepoIfNeeded()` (`js/app.js:4215`). Note that `settings/` is *not*
legacy despite the README grouping it with them — `settings/game-types.json` is
fetched on every boot as live configuration.

---

## Core data flow

The single most important path in the app:

```
tap + / −
  ↓
adjustScore(playerId, delta)                            js/app.js:3034
  ├── quickCounterMode? tally only — no target check, negatives allowed → return
  ├── clamp to 0 unless currentGame.unit !== "rack"
  └── target reached?  (teams: sumTeamBalls(teamId) >= target, else balls >= target)
        ↓
creditWin(isTeam, key, winnerVoice)                     js/app.js:2587
  ├── bump playerWins / teamWins / teamMvpWins   (MVP = most balls on the winning team)
  ├── unshift a game-history entry, truncate to 200
  ├── unless noStatsMode:
  │     applyPairwiseRatingResult(winner, opponent) per opponent   ← singles
  │     applyTeamRatingResult(winners, losers)                     ← teams
  │     saveRatingsToStorage()
  ├── saveRotationSnapshotIfNew() → applyRotationIfDue() → detect gameTypeChanged
  ├── resetGameBalls() → saveState() → playWinSound() → renderAll()
  └── showGameWinOverlay(summary, ts, onClose ⇒
         milestone celebration | on-the-hill warning | game-changed notice)
```

**The deferred-overlay chain is load-bearing.** Every credited win shows the
"nice shot" modal first; the milestone / on-hill / game-change popups fire only
from its `onClose` callback. Anything that reacts to those — including tests —
must dismiss the win modal first.

In singles, a win applies a **pairwise Elo update against every other active
player**. In a four-player free-for-all the winner gains from three
comparisons and each loser drops from one.

---

## Rendering model

`renderAll()` (`js/app.js:1308`) is the entire pipeline:

```js
renderRoster() → renderScoreboard() → renderHistory() → renderStandings()
  → renderRotation() → renderWizardIfOpen() → updateDayNotesSummary()
```

**Full DOM rebuild on every call.** No virtual DOM, no diffing, no reactivity.
"Components" are plain `build*Row` / `build*Card` functions that return real
elements. State changes call `saveState()` then `renderAll()`.

The All Players graphs (`js/app.js:6148`–`7281`) are hand-rolled inline SVG:
monotone cubic interpolation (`monotoneLinePath`, `js/app.js:6307`) chosen for
non-overshooting curves, per-point hit targets, click-to-reveal tooltips, and
a time axis whose graduations adapt to the selected period.

---

## Screen navigation

All four screens live in one document, toggled by the `.hidden` class:

| Screen | Element |
|---|---|
| Main scoreboard | `#app` |
| Player stats | `#view-player-page` |
| All Players | `#view-all-players-page` |
| Tournament | `#view-tournament-page` |

`pushScreenHistory()` (`js/app.js:5827`) **pushes** when leaving main and
**replaces** when moving sideways between subscreens, so history depth never
exceeds one. The physical browser Back button therefore always means "back to
main," matching the in-app Back buttons.

---

## Subsystem map

| Section | Lines | Notes |
|---|---|---|
| State + migrations | 22–350 | Boot-time name-capitalization self-heal (`:52`); v1→v2 migration (`:119`) |
| Sound | 353–638 | Fully synthesized. Per-player pitch (`VOICE_PITCHES`), convolution reverb from a generated impulse (`:559`), 30-note Ode to Joy fanfare (`:580`) |
| Theme | 640–681 | 10 palettes; contrast colors computed per theme, not assumed |
| i18n | 683–848 | `manifest.json` **is** the directory listing; English always loaded as fallback; switching language **reloads the page** |
| DOM refs | 850–1072 | 182 `getElementById` calls into module-scope vars |
| Modals | 1074–1288 | Own `alertModal` / `confirmModal` / `promptModal` replacing natives; keypad shortcuts; Enter/Escape handling |
| Focus mode | 1290–1304 | Hides setup/stats panels, leaves the scoreboard |
| Rendering | 1306–2439 | Roster, scoreboard, standings, rotation, history |
| Player management | 2441–2574 | Add/remove/standby, duplicate detection, inline rename |
| Scoring | 2576–3123 | `adjustScore` → `creditWin` → overlays; `undoLastWin` |
| Sharing / notes / reports | 3125–3416 | Clipboard, `mailto:`, `sms:` day synopsis |
| Export session | 3418–3484 | |
| Persistence | 3486–3675 | One load/save pair per key |
| Ratings | 3677–4594 | Elo, backfill, merge, import/export |
| Rosters | 4596–4752 | Auto-snapshot-if-new |
| Game order (rotation) | 4754–4849 | Same save/load pattern as rosters |
| Setup Wizard | 4851–5306 | 5 steps; the tournament path collapses to `[1, 5]` |
| Player stats page | 5308–5816 | Synopsis, head-to-head, graph, session history |
| Screen navigation | 5818–5944 | History API, depth capped at 1 |
| All Players (bars) | 5946–6146 | |
| All Players (graphs) | 6148–7281 | SVG charting, tooltips, rating chart, time axis |
| Tournament | 7283–8421 | Double / single elimination + round robin |
| Events + Init | 8423–8926 | |

### Ratings engine (`js/app.js:3959`)

Base-2 Elo, scaled to match FargoRate's published odds:

```
expected(A vs B) = 1 / (1 + 2^((Rb - Ra) / 100))
```

A 100-point gap is ~2:1, doubling every 100 points. Constants: `DEFAULT_RATING`
400, `RATING_PROVISIONAL_GAMES` 20, `RATING_K_PROVISIONAL` 24,
`RATING_K_ESTABLISHED` 8, `RATING_HISTORY_CAP` 500.

`backfillMissingRatingsFromHistory()` (`js/app.js:4031`) replays every game
missing from the ratings' timestamp record, in chronological order, on **every**
boot — so imported or migrated history produces exactly the rating it would
have had if rated live. Already-rated games are skipped by `ts`, making it safe
to re-run.

### Tournaments (`js/app.js:7283`)

Every rack played in a bracket is written into the shared `state.gameHistory`,
so tournament play feeds career stats, ratings, and the graphs. But bracket
state is otherwise **fully separate**: `playerWins`, rotation, teams, and the
milestone overlays are main-session-only and untouched.

Finished brackets are archived to `…tournamentResults.v1`. Race-to-N session
wins are *derived* as tournament results from existing game history, so they
apply retroactively.

---

## Cross-cutting concerns

**Two global modes** cut across nearly every code path:

- `noStatsMode` (`js/app.js:34`) — every persistence call becomes a no-op while
  the live UI keeps working normally. Never itself persisted, so it always
  starts off.
- `quickCounterMode` (`js/app.js:43`) — strips out game type, target, rotation,
  and win detection entirely; the scoreboard becomes a bare tally allowing
  negative scores. Always implies `noStatsMode`.

**Names are the join key.** `state.players` uses generated ids, but
`PLAYER_STATS`, `PLAYER_RATINGS`, `PLAYER_ADDED`, and
`PLAYER_NAME_TRANSLATIONS` are all **name-keyed**, case-insensitively via
`normalizeNameKey()` (`js/app.js:81`). This is why the `find*Key` helpers and
the two `consolidateCaseVariant*` repair passes exist, and why a boot-time
capitalization self-heal runs before any rendering.

---

## Test infrastructure

Lives on the **`tests` branch of `upstream`** — deliberately off `main` so the
shipped app stays dependency-free.

**38 test functions across 8 files, ~930 lines** — 49 collected cases once
`test_themes.py`'s parametrization over the 10 themes expands. Dependencies: `pytest>=8.0`,
`selenium>=4.20`. Selenium Manager fetches a matching chromedriver
automatically, so Chrome is the only other requirement.

### Harness

`tests/conftest.py` (88 lines), three fixtures:

- **`server`** (session-scoped) — spawns `python3 -m http.server` on port
  **8935** (`PMC_TEST_PORT`) against the repo root. Deliberately not 8934, so
  it never collides with a manual dev server.
- **`driver`** (per-test) — fresh headless Chrome with
  `goog:loggingPrefs: {browser: ALL}`, so tests can assert on **JS console
  errors**, not just visible DOM.
- **`app`** — load, `localStorage.clear()`, **reload**, then stub
  `window.confirm` / `window.alert`. The reload is what makes the clean state
  take effect, since the app has already read storage by then.

`tests/helpers.py` encodes real knowledge of this app's quirks:

- `assert_no_console_errors` filters SEVERE entries by `source != "network"` —
  because `migrateFromRepoIfNeeded()` probes for optional `players/<Name>.json`
  files, and Chrome logs those 404s as SEVERE regardless of the app handling
  them correctly. Without the filter, every test would fail on a healthy app.
- `set_number_input` types real keystrokes rather than setting `.value`, so the
  app's own `input` / `change` listeners actually fire.
- `dismiss_gamewin_overlay` encodes the deferred-overlay chain described in
  [Core data flow](#core-data-flow).

### Coverage

| File | Tests | Area |
|---|---|---|
| `test_boot.py` | 6 | Cold boot, zero console errors, empty state |
| `test_scoreboard.py` | 4 | Scoring, win detection, undo, milestone overlay |
| `test_themes.py` | 3 | All 10 themes, persistence, light-theme graph tint |
| `test_all_players.py` | 6 | List, bar/graph toggle, sort/period, overflow regression |
| `test_player_stats.py` | 5 | Synopsis rows, switcher, both graphs' dot tooltips |
| `test_players_panel.py` | 5 | Rating edit, silent removal, roster-save behavior |
| `test_tournament.py` | 6 | Single elim, round robin, ties, champion → stats |
| `test_no_stats_mode.py` | 3 | Persistence actually blocked across reload |

Several are explicit regression tests for named past bugs — the flexbox graph
overflow, the achromatic light-theme graph background.

**Intentionally uncovered:** file-based flows (Export/Import All Data, player
list export, backup round-trips). Documented as a deliberate flakiness
trade-off, and the largest real coverage hole.

### Running it against current `main` — caveats

1. The `tests` branch's own copy of the app is **25 commits stale and
   pre-i18n**. Running `pytest` there exercises a Sep-2 app, not current
   `main`. Testing today's code means grafting `tests/` onto a branch off
   `main`.
2. `tests/README.md` documents 7 files and **omits `test_players_panel.py`**,
   added in the branch's most recent commit.

```bash
cd tests
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest                                    # or: pytest test_scoreboard.py
```

### Verified result of that graft

The graft was performed and executed on 2026-09-04: `tests/` from
`upstream/tests` over a worktree at `origin/main` (`d1d5741`), with Chrome
152.0.7977.82, Selenium 4.48.0, pytest 9.1.1, Python 3.14.4.

```
49 tests collected  →  46 passed, 3 failed  (57.55s)
```

49 rather than 38, because `test_themes.py` parametrizes over all 10 themes and
the 2 light themes. **The harness itself works unmodified against an app 25
commits newer than the branch it ships on** — the fixtures, the console-error
filter, and the overlay handling all still hold.

All three failures are **stale tests, not app regressions.** Each was verified
against the current source:

| Test | Cause |
|---|---|
| `test_scoreboard.py::test_plus_button_credits_a_win_at_default_target_1` | Asserts `.stat-value == "0"` after a win. Commit `ff5636f` intentionally changed single-rack games (`unit === "rack" && target === 1`, the default) to show the **tourney win count** there instead of the ball count — see `js/app.js:2245`. Correct value is now `"1"` |
| `test_scoreboard.py::test_undo_last_win_reverses_the_credited_win` | `undoLastWin` routes through the in-app `confirmModal` (`js/app.js:2888`) since `9585ec8` replaced native dialogs. The fixture's `window.confirm` stub no longer intercepts anything, so undo never runs. Fix: click `#btn-confirm-modal-ok` |
| `test_players_panel.py::test_reset_all_players_official_rating_resets_roster_to_default` | Doubly broken. `btn-reset-all-ratings` **does not exist in the `tests` branch's own `index.html`** — this test cannot have passed on its own branch. On current `main` the button exists but sits inside `#resets-panel`, which is `collapsed` by default → `ElementNotInteractableException`. Fix: `expand_panel(app, "btn-toggle-resets-panel")` first, then handle the in-app confirm modal as above |

The third case is worth dwelling on: a test was committed to the `tests` branch
referencing an element that branch's own markup never contained. It was written
against the author's local `main` and only the test file was committed. Nothing
catches that, because there is no CI.

**Net:** the suite is in good health and worth keeping. Three tests need
updating for deliberate product changes, and the fixture's native-dialog
stubbing needs replacing with in-app modal interaction throughout.

---

## The mobile_app branch

A Capacitor 6 iOS shell wrapping the same web app, with a **one-time
non-consumable in-app purchase** brokered by RevenueCat.

```json
"@capacitor/core"                  "^6.1.2"
"@capacitor/ios"                   "^6.1.2"
"@revenuecat/purchases-capacitor"  "^9.4.0"
"@capacitor/cli"                   "^6.1.2"   // dev
```

`capacitor.config.json`: `appId: com.example.poolmastercounter`, `webDir: "www"`.
This is the **only `package.json` anywhere in the project**, and it is
npm-based, not bun.

### The structural problem

`www/` is a **hand-forked copy** of the app, not build output:

| File | root | `www/` |
|---|---|---|
| `js/app.js` | 8,503 L | **8,691 L** |
| `index.html` | 794 L | **815 L** |
| `css/style.css` | 3,264 L | **3,333 L** |

There is no step that regenerates `www/` from the root, so **every fix must be
applied twice, by hand, indefinitely**. `MOBILE_APP_SETUP.md` includes a
"Keeping this branch in sync with `main`" section — the maintenance cost is
documented rather than engineered away.

### Paywall

`requirePro()` (`www/js/app.js:1153`) gates:

| Gate | Free tier |
|---|---|
| `FREE_PLAYER_CAP = 4` | 5th player blocked |
| Stats pages (2 call sites) | blocked |
| Tournament | blocked |
| Teams mode | blocked |
| Rotation | blocked |
| Day reports (3 call sites) | blocked |

`isPro` persists to `poolMasterCounter.pro.v1` and is reconciled on native
launch against the App Store entitlement named `pro`.
`REVENUECAT_IOS_API_KEY = "appl_REPLACE_ME"` is a placeholder, correctly
annotated in-code as a public key that cannot grant entitlements or move money
on its own. Off-native there is no `window.Purchases`, so `isPro` is just
whatever `localStorage` says — the **web build's paywall is trivially
bypassable**, which is fine, since it exists only to gate the iOS binary.

---

## Release pipeline

Entirely manual. The `release` branch is rebuilt from scratch each time rather
than diffed, using `rjsmin` / `rcssmin`:

- `js/app.js` — 343 KB → **206 KB** (~40% smaller)
- Comments stripped, whitespace collapsed, **identifiers preserved** (rjsmin
  does not mangle)

The invocation that produces it is not committed anywhere. Neither is anything
that produces the `stable` snapshot.

---

## Recent drift

`origin/main` is 2 commits ahead of the state documented above.

**`ed5cadb`** — "Win-modal quick actions, retrograde-aware undo, local-day
stats, and bigger readable modals." `js/app.js` +264, `css` +183,
`index.html` +16, 4 new i18n keys (`confirm.undoTournamentWin`,
`forceReset.title` / `.gameMessage` / `.tournamentMessage`). New functions:

- `retrogradeRatingsForGame`, `revertRatingsChangedSince`, `retrogradeLastGame`,
  `undoTournamentWinFromMilestoneOverlay` — **undo now unwinds Elo.** Closes a
  real gap: previously `undoLastWin` reversed win counters but left ratings
  permanently bumped.
- `localDateStrFromTs` — day-keyed data was derived from ISO/UTC timestamps, so
  games near midnight landed on the wrong calendar day outside UTC.
- `persistBallsLeftLive`, `showForceResetNotice`, `closeForceResetNotice`.

**`d1d5741`** — sound only, +96/−20. "Themed" means *signature melodies*, not
theme-palette-linked: the win sound became a 9-note brass anthem (sawtooth plus
sub-octave triangle, routed through both the shared echo bus and a dedicated
2.4 s convolution reverb send), still pitched per-player via `VOICE_PITCHES`.
The on-hill warning got its own phrase.

---

## Known discrepancies and risks

Ordered roughly by how likely each is to bite.

1. **`js/app.js` is one 8,926-line IIFE with 354 functions in a single closure
   scope.** Every helper can see every other; there is no module boundary
   anywhere. It is well-sectioned and unusually well-commented for its size,
   but this is the dominant structural risk.

2. **That risk compounds across branches.** The same file is forked into a
   second 8,691-line copy on `mobile_app`, while the test suite is pinned to a
   third snapshot 25 commits back — and no CI exists to notice when the three
   disagree. This is not hypothetical: a test on the `tests` branch references
   `btn-reset-all-ratings`, an element that branch's own `index.html` does not
   contain, so it has never passed there. See
   [Verified result of that graft](#verified-result-of-that-graft).

3. **`AGENTS.md` prescribes a toolchain the project does not have.** It mandates
   bun, `bun.lock`, and `bun install` / `dev` / `build` / `test` / `lint`. No
   branch has a `bun.lock` or any of those scripts. The only `package.json`
   anywhere is `mobile_app`'s, and it is npm + Capacitor. `AGENTS.md` is also
   still titled `luc-test` from its `acfs newproj` generation.

4. **`AGENTS.md` never mentions the test suite** — not its existence, its
   location, nor that it lives on a different remote. The one file agents are
   told to read first omits the only automated verification the project has.

5. **The release pipeline is manual and uncommitted.** Reproducing a `release`
   build requires knowing the right rjsmin/rcssmin invocation, which is
   recorded nowhere in the repo.

6. **`applyTeamRatingResult` (`js/app.js:4007`) hardcodes
   `RATING_K_PROVISIONAL`** for both sides, while the pairwise path uses
   `ratingKFor(gamesPlayed)`. Established players' ratings therefore move 3×
   faster in team games than in singles. This reads as an oversight rather than
   a documented choice — worth confirming with the maintainer before changing.

7. **README inaccuracies.** It groups `settings/` with the legacy
   `players/` and `stats/` directories, but `settings/game-types.json` is
   fetched on every boot as live config. It also describes `stable`, `release`,
   and `tests` as branches of this repo, when they exist only on `upstream`.

8. **`state.gameHistory` is hard-capped at 200 entries.** Long-term history
   survives only via `PLAYER_STATS`, so anything derived from `gameHistory`
   alone silently loses the tail on a long-running device.

---

## How to run it

**The app** — static, no build:

```bash
python3 -m http.server 8934      # then open http://localhost:8934
```

Opening `index.html` directly over `file://` may fail, because boot depends on
three `fetch` calls (see [Entry points](#entry-points-and-boot-sequence)).

**The tests** — see [Test infrastructure](#test-infrastructure). Requires
Python 3.9+ and Chrome; Selenium Manager fetches a matching chromedriver on its
own. Because the suite lives on `upstream/tests` alongside a stale copy of the
app, testing current code means grafting it onto a worktree of `main`:

```bash
git worktree add --detach /tmp/pmc-tests origin/main
git archive upstream/tests tests/ | tar -x -C /tmp/pmc-tests
cd /tmp/pmc-tests/tests
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m pytest -v
```

This keeps the project working tree untouched. Results as of 2026-09-04 are in
[Verified result of that graft](#verified-result-of-that-graft).
