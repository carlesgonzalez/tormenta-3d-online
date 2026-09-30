const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const players = new Map();
const names = ['Jugador 1','Jugador 2','Jugador 3','Jugador 4','Jugador 5','Jugador 6','Jugador 7','Jugador 8','Jugador 9'];

function currentHost(){
  return players.values().next().value?.id || null;
}

io.on('connection', socket => {
  if (players.size >= 9) {
    socket.emit('full');
    socket.disconnect(true);
    return;
  }

  const p = {
    id: socket.id,
    name: names[players.size],
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    hp: 100, sh: 50, alive: 1, weapon: 'pistol'
  };
  players.set(socket.id, p);

  const hostId = currentHost();
  socket.emit('welcome', { id: socket.id, name: p.name, host: socket.id === hostId, count: players.size });
  socket.emit('players', [...players.values()].filter(x => x.id !== socket.id));
  socket.broadcast.emit('playerJoined', p);
  io.emit('hostChanged', socket.id === hostId);

  socket.on('playerState', data => {
    const p = players.get(socket.id);
    if (!p || !data) return;
    for (const k of ['x','y','z','yaw','pitch','hp','sh','alive','weapon']) {
      if (typeof data[k] === 'number' || typeof data[k] === 'string') p[k] = data[k];
    }
    socket.broadcast.emit('playerState', p);
  });

  // The host owns the bots. Their state is relayed to all other clients.
  socket.on('botState', bots => {
    if (socket.id !== currentHost() || !Array.isArray(bots)) return;
    socket.broadcast.emit('botState', bots);
  });

  // Relay player hits to the player who was hit. The receiving client is authoritative for its own HP.
  socket.on('hitPlayer', data => {
    if (!data || typeof data.target !== 'string') return;
    if (!players.has(data.target) || data.target === socket.id) return;
    const damage = Math.max(0, Math.min(200, Number(data.damage) || 0));
    io.to(data.target).emit('hitPlayer', { target: data.target, damage, from: players.get(socket.id)?.name || 'Jugador' });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('playerLeft', socket.id);
    const newHost = currentHost();
    if (newHost) io.emit('hostChanged', newHost === newHost); // clients recompute via connection order
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Tormenta 3D online en puerto ${PORT}`));
