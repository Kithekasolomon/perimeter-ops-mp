# Perimeter Ops — Multiplayer PvP

A server-authoritative top-down shooter. Squads of 2-4 per side, matchmaking,
and basic anti-cheat (server validates all movement, fire-rate, and hit
outcomes — the client only sends input, never claims results).

Tested locally with 4 simulated players: matchmaking, movement, shooting,
and elimination all confirmed working (see `server/test_local.js`).

## What's inside
- `server/index.js` — the authoritative WebSocket server (Node.js + `ws`).
- `server/test_local.js` — a local test harness that simulates 4 fake
  players to sanity-check the server without needing real clients.
- `client/index.html` — the browser client. Open it, enter your server's
  WebSocket URL, and click "Find Match".

## Run the server locally (to test before deploying)
```bash
cd server
npm install
npm start
```
Server listens on port 8080 by default (or `$PORT` if set).

To run the automated test:
```bash
cd server
npm test
```
This spins up the real server, connects 4 fake clients, and verifies
matchmaking/movement/shooting/hits all work — no browser needed.

## Deploy to Railway
1. Push the `server/` folder to a GitHub repo (this can be the whole
   `perimeter-ops-mp` folder, or just `server/` as its own repo — either
   works, just point Railway at the folder containing `package.json`).
2. On railway.app: **New Project → Deploy from GitHub repo** → select the repo.
3. Railway auto-detects Node.js, runs `npm install` and `npm start`.
4. Once deployed, Railway gives you a public URL like
   `yourapp.up.railway.app`. Your WebSocket URL is:
   `wss://yourapp.up.railway.app`
5. Every push to the connected branch auto-redeploys.

## Play
Open `client/index.html` in a browser (locally, or host it anywhere static
— even a GitHub Pages page works, since it's just HTML/JS). Paste in your
`wss://...` server URL and click **Find Match**. Open it in a few browser
tabs/devices to fill out a squad and test real PvP.

- **Desktop**: WASD to move, mouse to aim, click to fire.
- **Mobile**: on-screen joystick (left) to move, drag the right pad to aim
  — holding it down fires continuously.

## How the anti-cheat actually works
The server is the only source of truth:
- Movement: server integrates position itself from a normalized direction
  vector sent by the client. It never trusts a client-reported x/y, so
  teleporting or speed-hacking has no effect — the server just recomputes
  motion from scratch every tick, clamped to max speed.
- Fire rate: the server tracks each player's last-fire timestamp and
  silently ignores fire attempts that arrive faster than the weapon's
  cooldown allows.
- Hits/damage: the server simulates every bullet itself and applies damage
  when it detects a collision — the client never gets to say "I got a
  kill," it only finds out via the next state broadcast.
- Message flooding: each connection is rate-limited (~40 msgs/sec) to
  prevent input-spam abuse.

## Known limitations (v1)
- No persistent accounts, stats, or ranked ladder — add a database
  (Postgres on Railway is one click away) if you want this later.
- No client-side prediction/reconciliation yet, so on higher-latency
  connections movement will feel slightly delayed rather than instant.
  This is the standard next optimization once the core loop is solid.
- Anti-cheat is heuristic (speed/rate limits), not exhaustive — there's no
  replay-based or ML-based detection. Good enough to stop naive cheats,
  not a competitive-esports-grade system yet.
