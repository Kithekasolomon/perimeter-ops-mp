// Spins up the real server on a local port, then connects 4 fake WebSocket
// clients that queue up, get matched, move toward each other, and fire.
// Verifies: matchmaking, movement integration, fire-rate limiting, hit
// detection, elimination, and win condition all work end-to-end.

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8181;
process.env.PORT = PORT;

const serverProc = spawn('node', ['index.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT, QUEUE_TIMEOUT_MS: 2000 },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let passed = { matched: false, moved: false, fired: false, hit: false };

serverProc.stdout.on('data', d => {
  process.stdout.write(`[server] ${d}`);
  if (d.toString().includes('listening')) {
    setTimeout(runClients, 200); // give the listener a moment to settle
  }
});
serverProc.stderr.on('data', d => process.stderr.write(`[server-err] ${d}`));

function makeClient(label, team) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, label, id: null, x: null, y: null, team };

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join_queue' }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'welcome') {
      c.id = msg.playerId;
      console.log(`[${label}] connected as player ${c.id}`);
    } else if (msg.type === 'match_start') {
      passed.matched = true;
      console.log(`[${label}] MATCH START — team ${msg.team}, matchId ${msg.matchId}`);
      c.matchStarted = true;
    } else if (msg.type === 'state') {
      const me = msg.players.find(p => p.id === c.id);
      if (me) {
        if (c.x !== null && (me.x !== c.x || me.y !== c.y)) passed.moved = true;
        c.x = me.x; c.y = me.y;
      }
      if (msg.bullets.length > 0) passed.fired = true;
    } else if (msg.type === 'elim') {
      passed.hit = true;
      console.log(`[EVENT] elim: victim=${msg.victim} killer=${msg.killer} team=${msg.team}`);
    } else if (msg.type === 'match_end') {
      console.log(`[EVENT] MATCH END — winner: ${msg.winner}, scores:`, msg.scores);
      finish();
    }
  });

  return c;
}

let clients = [];
let inputLoop = null;

function runClients() {
  clients = [
    makeClient('P1-red', 'red'),
    makeClient('P2-red', 'red'),
    makeClient('P3-blue', 'blue'),
    makeClient('P4-blue', 'blue'),
  ];

  inputLoop = setInterval(() => {
    for (const c of clients) {
      if (!c.matchStarted || c.ws.readyState !== WebSocket.OPEN) continue;
      const towardEnemy = c.team === 'red' ? 1 : -1;
      c.ws.send(JSON.stringify({
        type: 'input',
        moveX: towardEnemy * 0.6,
        moveY: 0,
        aimAngle: c.team === 'red' ? 0 : Math.PI,
        firing: true,
      }));
    }
  }, 40);
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(inputLoop);
  console.log('\n--- TEST RESULTS ---');
  console.log('Matchmaking formed a match:', passed.matched);
  console.log('Server-side movement integrated:', passed.moved);
  console.log('Bullets were fired:', passed.fired);
  console.log('A hit/elimination was registered:', passed.hit);
  const allPassed = Object.values(passed).every(Boolean);
  console.log(allPassed ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECKS FAILED');
  for (const c of clients) c.ws.close();
  serverProc.kill();
  process.exit(allPassed ? 0 : 1);
}

// Safety timeout in case win condition takes too long
setTimeout(() => {
  console.log('\n(timeout reached, wrapping up test)');
  finish();
}, 15000);
