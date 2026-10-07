const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const players = new Map();
let match = { start: Date.now(), sx: 0, sz: 0 };
const MATCH_MS = 300000; let active = false;
const scores = new Map();
const scoreList = () => [...scores.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map(({ id, name, kills, deaths }) => ({ id, name, kills, deaths }));
const taken = new Set();      // ids de loot ya recogido en la partida actual
const pieces = new Map();     // piezas construidas: key -> { o, hp }

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const vec3 = a => Array.isArray(a) && a.length === 3 && a.every(v => num(v) !== null);
const rnd = (a, b) => a + Math.random() * (b - a);
const pieceKey = o => o.t === 'w' ? `w${o.cx + o.dx * 2},${o.cz + o.dz * 2},${o.y0}`
  : o.t === 'r' ? `r${o.cx},${o.cz},${o.y0},${o.dx},${o.dz}` : `${o.t}${o.cx},${o.cz},${o.y0}`;

function applyState(player, data) {
  if (!data) return;
  for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'hp', 'sh']) {
    const v = num(data[k]);
    if (v !== null) player[k] = v;
  }
  if (typeof data.weapon === 'string') player.weapon = data.weapon.slice(0, 12);
}

const publicPlayer = p => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
  hp: p.hp, sh: p.sh, alive: p.alive, playing: p.playing, weapon: p.weapon });

function broadcastCount() { io.emit('playerCount', players.size); }

io.on('connection', socket => {
  const p = { id: socket.id, name: 'Jugador', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, sh: 50,
    alive: 1, playing: 0, weapon: 'pistol', lastHitBy: null };
  players.set(socket.id, p);
  socket.emit('welcome', { id: p.id, name: p.name, host: players.size === 1, count: players.size });
  socket.emit('players', [...players.values()].filter(x => x.id !== socket.id).map(publicPlayer));
  socket.broadcast.emit('playerJoined', publicPlayer(p));
  broadcastCount();

  socket.on('setName', name => {
    const player = players.get(socket.id);
    if (!player) return;
    player.name = String(name || 'Jugador').trim().slice(0, 16) || 'Jugador';
    if (scores.has(socket.id)) scores.get(socket.id).name = player.name;
    io.emit('nameChanged', { id: socket.id, name: player.name });
  });

  // El jugador pulsa JUGAR: entra en la partida con la misma tormenta/reloj que los demás
  socket.on('startPlaying', data => {
    const me = players.get(socket.id);
    if (!me) return;
    const anyPlaying = [...players.values()].some(q => q.id !== me.id && q.playing);
    if (!active || !anyPlaying) {
      match = { start: Date.now(), sx: rnd(-20, 20), sz: rnd(-20, 20) };
      active = true; taken.clear(); pieces.clear(); scores.clear();
    }
    applyState(me, data);
    me.playing = 1; me.alive = 1; me.hp = 100; me.sh = 50; me.lastHitBy = null;
    if (!scores.has(me.id)) scores.set(me.id, { id: me.id, name: me.name, kills: 0, deaths: 0 });
    socket.emit('matchInfo', {
      el: (Date.now() - match.start) / 1000, sx: match.sx, sz: match.sz, scores: scoreList(),
      taken: [...taken], pieces: [...pieces.values()].map(v => ({ ...v.o, hp: v.hp }))
    });
    socket.broadcast.emit('playerState', publicPlayer(me));
  });

  socket.on('respawn', data => {
    const me = players.get(socket.id);
    if (!me || !me.playing || me.alive) return;
    applyState(me, data);
    me.alive = 1; me.hp = 100; me.sh = 50; me.lastHitBy = null;
    socket.broadcast.emit('playerState', publicPlayer(me));
  });

  socket.on('playerState', data => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !me.alive) return;
    applyState(me, data);
    socket.broadcast.emit('playerState', publicPlayer(me));
  });

  // Daño a otro jugador (el cliente que dispara decide el impacto; el servidor valida lo básico)
  socket.on('hitPlayer', data => {
    const shooter = players.get(socket.id);
    const target = data && typeof data.target === 'string' ? players.get(data.target) : null;
    if (!shooter || !target || target === shooter) return;
    if (!shooter.playing || !shooter.alive || !target.playing || !target.alive) return;
    if (Math.hypot(shooter.x - target.x, shooter.z - target.z) > 450) return;
    const damage = Math.max(0, Math.min(200, Number(data.damage) || 0));
    target.lastHitBy = shooter.id;
    io.to(target.id).emit('hitPlayer', { target: target.id, damage, from: shooter.name, fromId: shooter.id });
  });

  // Trazadoras para que los demás vean/oigan los disparos
  socket.on('shot', data => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !me.alive || !data || !vec3(data.a) || !vec3(data.b)) return;
    socket.broadcast.emit('shot', { id: socket.id, a: data.a, b: data.b });
  });

  socket.on('died', data => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !me.alive) return;
    me.alive = 0;
    const sc = scores.get(me.id); if (sc) sc.deaths++;
    const by = data && typeof data.by === 'string' && data.by === me.lastHitBy ? players.get(data.by) : null;
    const killer = by && by.id !== me.id ? by : null;
    if (killer && scores.has(killer.id)) scores.get(killer.id).kills++;
    io.emit('playerDied', { id: me.id, name: me.name, killerId: killer ? killer.id : null,
      killerName: killer ? killer.name : null, scores: scoreList() });
  });

  socket.on('lootTaken', id => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !Number.isInteger(id) || taken.has(id)) return;
    taken.add(id);
    socket.broadcast.emit('lootTaken', id);
  });

  socket.on('build', o => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !o || !['w', 'f', 'r', 'c'].includes(o.t)) return;
    const piece = { t: o.t, cx: num(o.cx), cz: num(o.cz), y0: num(o.y0), dx: num(o.dx), dz: num(o.dz) };
    if (Object.values(piece).some(v => v === null) || pieces.size > 800) return;
    const k = pieceKey(piece);
    if (pieces.has(k)) return;
    pieces.set(k, { o: piece, hp: 150 });
    socket.broadcast.emit('build', piece);
  });

  socket.on('pieceHit', data => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !data || typeof data.k !== 'string') return;
    const pc = pieces.get(data.k);
    if (!pc) return;
    const d = Math.max(0, Math.min(200, Number(data.d) || 0));
    pc.hp -= d;
    if (pc.hp <= 0) pieces.delete(data.k);
    socket.broadcast.emit('pieceHit', { k: data.k, d });
  });

  socket.on('edit', data => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !data || typeof data.k !== 'string') return;
    const pc = pieces.get(data.k), mask = data.mask | 0;
    if (!pc || pc.o.t === 'c' || mask < 1 || mask > 511) return;
    pc.o.mask = mask;
    socket.broadcast.emit('edit', { k: data.k, mask });
  });

  socket.on('grenade', d => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !me.alive || !d || typeof d.id !== 'string' || !vec3(d.p) || !vec3(d.v)) return;
    socket.broadcast.emit('grenade', { id: d.id.slice(0, 40), p: d.p, v: d.v });
  });

  socket.on('boom', d => {
    const me = players.get(socket.id);
    if (!me || !me.playing || !d || typeof d.id !== 'string' || !vec3(d.p)) return;
    socket.broadcast.emit('boom', { id: d.id.slice(0, 40), p: d.p });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('playerLeft', socket.id);
    broadcastCount();
  });
});

setInterval(() => {            // fin de partida por tiempo: gana quien tenga más bajas
  if (active && Date.now() - match.start >= MATCH_MS) {
    active = false;
    io.emit('matchEnd', { scores: scoreList() });
    for (const q of players.values()) { q.playing = 0; q.alive = 1; }
  }
}, 500);

server.listen(PORT, '0.0.0.0', () => console.log(`Tormenta 3D online en puerto ${PORT}`));
