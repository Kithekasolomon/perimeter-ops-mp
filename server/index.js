// Perimeter Ops — Authoritative Multiplayer Server
// Server-side simulation: clients send INPUT only, server decides all outcomes.

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const TICK_RATE = 25; // server ticks/sec
const TICK_MS = 1000 / TICK_RATE;

const MAP_W = 1600, MAP_H = 900;
const PLAYER_RADIUS = 14;
const PLAYER_MAX_SPEED = 4.5; // units/tick at 25hz baseline
const FIRE_COOLDOWN_MS = 130;
const BULLET_SPEED = 14;
const BULLET_LIFE_TICKS = 45;
const MAX_HEALTH = 100;
const BULLET_DAMAGE = 12;
const TEAM_SIZE = { min: 2, max: 4 };
const MATCH_QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 20000;
const ELIMS_TO_WIN = 15;
const MAX_MSGS_PER_SEC = 40;

// ---------- HTTP + WS bootstrap ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Perimeter Ops server is running.\n');
});
const wss = new WebSocketServer({ server });

let nextPlayerId = 1;
let nextMatchId = 1;

/** @type {Map<number, {ws, id, name, rateWindowStart:number, rateCount:number}>} */
const connections = new Map();

let queue = []; // players waiting for a match: {playerId, joinedAt}
let queueTimer = null;

/** @type {Map<number, Match>} */
const matches = new Map();

// ---------- Matchmaking ----------
function enqueuePlayer(playerId) {
  queue.push({ playerId, joinedAt: Date.now() });
  send(playerId, { type: 'queued', position: queue.length });
  tryFormMatch();
  if (!queueTimer) {
    queueTimer = setTimeout(() => {
      queueTimer = null;
      tryFormMatch(true); // force-fill with whoever is waiting
    }, MATCH_QUEUE_TIMEOUT_MS);
  }
}

function tryFormMatch(force = false) {
  const wantedPerTeam = TEAM_SIZE.max;
  const needed = wantedPerTeam * 2;

  if (queue.length >= needed) {
    const chosen = queue.splice(0, needed);
    startMatch(chosen.map(q => q.playerId));
    return;
  }

  if (force && queue.length >= TEAM_SIZE.min * 2) {
    const perTeam = Math.floor(queue.length / 2);
    const usable = perTeam * 2;
    const chosen = queue.splice(0, usable);
    startMatch(chosen.map(q => q.playerId));
  }
  // else: not enough players yet, keep waiting
}

function startMatch(playerIds) {
  const matchId = nextMatchId++;
  const half = Math.ceil(playerIds.length / 2);
  const redIds = playerIds.slice(0, half);
  const blueIds = playerIds.slice(half);

  const match = new Match(matchId, redIds, blueIds);
  matches.set(matchId, match);

  for (const pid of playerIds) {
    const conn = connections.get(pid);
    if (conn) conn.matchId = matchId;
  }

  match.broadcastStart();
  match.start();
}

// ---------- Match ----------
class Match {
  constructor(id, redIds, blueIds) {
    this.id = id;
    this.players = new Map(); // playerId -> playerState
    this.bullets = [];
    this.scores = { red: 0, blue: 0 };
    this.ended = false;
    this.interval = null;

    redIds.forEach((pid, i) => this.spawnPlayer(pid, 'red', i, redIds.length));
    blueIds.forEach((pid, i) => this.spawnPlayer(pid, 'blue', i, blueIds.length));
  }

  spawnPlayer(playerId, team, index, teamSize) {
    const isRed = team === 'red';
    const x = isRed ? 120 : MAP_W - 120;
    const y = (MAP_H / (teamSize + 1)) * (index + 1);
    this.players.set(playerId, {
      id: playerId, team,
      x, y, angle: isRed ? 0 : Math.PI,
      health: MAX_HEALTH, alive: true,
      lastFireAt: 0,
      inputSeq: 0,
      lastInputAt: Date.now(),
      lastKnownGoodX: x, lastKnownGoodY: y,
      connected: true,
    });
  }

  broadcastStart() {
    for (const [pid, p] of this.players) {
      send(pid, {
        type: 'match_start',
        matchId: this.id,
        yourId: pid,
        team: p.team,
        map: { w: MAP_W, h: MAP_H },
        elimsToWin: ELIMS_TO_WIN,
      });
    }
  }

  start() {
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  // Called whenever a player's input packet arrives
  applyInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return;

    // --- anti-cheat: clamp movement vector to unit length ---
    let mx = Number(input.moveX) || 0;
    let my = Number(input.moveY) || 0;
    const mag = Math.hypot(mx, my);
    if (mag > 1.0001) { mx /= mag; my /= mag; } // reject/renormalize oversized vectors

    p.x += mx * PLAYER_MAX_SPEED;
    p.y += my * PLAYER_MAX_SPEED;
    p.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, p.y));

    // --- teleport guard: server already computed the move itself above,
    // so the client cannot claim an arbitrary position; we only ever trust
    // our own integration, never a client-reported x/y. ---

    if (typeof input.aimAngle === 'number' && isFinite(input.aimAngle)) {
      p.angle = input.aimAngle;
    }

    if (input.firing) {
      this.tryFire(p);
    }

    p.lastInputAt = Date.now();
  }

  tryFire(p) {
    const now = Date.now();
    if (now - p.lastFireAt < FIRE_COOLDOWN_MS) return; // anti-cheat: enforce fire rate server-side
    p.lastFireAt = now;
    this.bullets.push({
      ownerId: p.id, team: p.team,
      x: p.x + Math.cos(p.angle) * 20,
      y: p.y + Math.sin(p.angle) * 20,
      vx: Math.cos(p.angle) * BULLET_SPEED,
      vy: Math.sin(p.angle) * BULLET_SPEED,
      life: BULLET_LIFE_TICKS,
    });
  }

  tick() {
    if (this.ended) return;

    // bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) {
        this.bullets.splice(i, 1); continue;
      }
      let hit = false;
      for (const [pid, target] of this.players) {
        if (!target.alive || target.team === b.team) continue;
        if (Math.hypot(b.x - target.x, b.y - target.y) < PLAYER_RADIUS + 4) {
          target.health -= BULLET_DAMAGE;
          hit = true;
          if (target.health <= 0) {
            target.alive = false;
            this.scores[b.team]++;
            this.broadcastEvent({ type: 'elim', victim: pid, killer: b.ownerId, team: b.team });
            setTimeout(() => this.respawn(pid), 3000);
          }
          break;
        }
      }
      if (hit) this.bullets.splice(i, 1);
    }

    this.broadcastState();
    this.checkWinCondition();
  }

  respawn(playerId) {
    const p = this.players.get(playerId);
    if (!p || this.ended) return;
    const isRed = p.team === 'red';
    p.x = isRed ? 120 : MAP_W - 120;
    p.y = MAP_H / 2;
    p.health = MAX_HEALTH;
    p.alive = true;
  }

  checkWinCondition() {
    if (this.scores.red >= ELIMS_TO_WIN || this.scores.blue >= ELIMS_TO_WIN) {
      this.ended = true;
      const winner = this.scores.red >= ELIMS_TO_WIN ? 'red' : 'blue';
      this.broadcastEvent({ type: 'match_end', winner, scores: this.scores });
      this.stop();
      setTimeout(() => matches.delete(this.id), 5000);
    }
  }

  broadcastState() {
    const snapshot = {
      type: 'state',
      t: Date.now(),
      scores: this.scores,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id, team: p.team, x: p.x, y: p.y, angle: p.angle,
        health: p.health, alive: p.alive, connected: p.connected,
      })),
      bullets: this.bullets.map(b => ({ x: b.x, y: b.y, team: b.team })),
    };
    for (const pid of this.players.keys()) send(pid, snapshot);
  }

  broadcastEvent(evt) {
    for (const pid of this.players.keys()) send(pid, evt);
  }

  handleDisconnect(playerId) {
    const p = this.players.get(playerId);
    if (p) p.connected = false;
  }
}

// ---------- Networking plumbing ----------
function send(playerId, obj) {
  const conn = connections.get(playerId);
  if (conn && conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws) => {
  const playerId = nextPlayerId++;
  connections.set(playerId, { ws, id: playerId, matchId: null, rateWindowStart: Date.now(), rateCount: 0 });
  send(playerId, { type: 'welcome', playerId });

  ws.on('message', (raw) => {
    const conn = connections.get(playerId);
    if (!conn) return;

    // --- anti-cheat: basic message rate limiting ---
    const now = Date.now();
    if (now - conn.rateWindowStart > 1000) {
      conn.rateWindowStart = now;
      conn.rateCount = 0;
    }
    conn.rateCount++;
    if (conn.rateCount > MAX_MSGS_PER_SEC) return; // silently drop flood

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join_queue') {
      enqueuePlayer(playerId);
    } else if (msg.type === 'input') {
      const match = matches.get(conn.matchId);
      if (match) match.applyInput(playerId, msg);
    }
  });

  ws.on('close', () => {
    const conn = connections.get(playerId);
    if (conn && conn.matchId != null) {
      const match = matches.get(conn.matchId);
      if (match) match.handleDisconnect(playerId);
    }
    queue = queue.filter(q => q.playerId !== playerId);
    connections.delete(playerId);
  });
});

server.listen(PORT, () => {
  console.log(`Perimeter Ops server listening on port ${PORT}`);
});

module.exports = { Match }; // exported for local test harness
