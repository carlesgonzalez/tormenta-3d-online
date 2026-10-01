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
function broadcastCount(){io.emit('playerCount', players.size);}
io.on('connection', socket => {
  const p={id:socket.id,name:'Jugador',x:0,y:0,z:0,yaw:0,pitch:0,hp:100,sh:50,alive:1,weapon:'pistol'};
  players.set(socket.id,p);
  socket.emit('welcome',{id:p.id,name:p.name,host:players.size===1,count:players.size});
  socket.emit('players',[...players.values()].filter(x=>x.id!==socket.id));
  socket.broadcast.emit('playerJoined',p);
  broadcastCount();
  socket.on('setName',name=>{const player=players.get(socket.id);if(!player)return;player.name=String(name||'Jugador').trim().slice(0,16)||'Jugador';io.emit('nameChanged',{id:socket.id,name:player.name});});
  socket.on('playerState',data=>{const player=players.get(socket.id);if(!player||!data)return;for(const k of ['x','y','z','yaw','pitch','hp','sh','alive','weapon'])if(typeof data[k]==='number'||typeof data[k]==='string')player[k]=data[k];socket.broadcast.emit('playerState',player);});
  socket.on('hitPlayer',data=>{if(!data||typeof data.target!=='string'||!players.has(data.target)||data.target===socket.id)return;const victim=players.get(data.target);if(!victim||!victim.alive)return;let damage=Math.max(0,Math.min(100,Number(data.damage)||0));const absorbed=Math.min(victim.sh||0,damage);victim.sh=Math.max(0,(victim.sh||0)-absorbed);damage-=absorbed;victim.hp=Math.max(0,(victim.hp||100)-damage);if(victim.hp<=0)victim.alive=0;const from=players.get(socket.id)?.name||'Jugador';io.to(data.target).emit('hitPlayer',{target:data.target,damage:absorbed+damage,from});io.emit('playerState',victim);});
  socket.on('disconnect',()=>{players.delete(socket.id);io.emit('playerLeft',socket.id);broadcastCount();});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Tormenta 3D online en puerto ${PORT}`));
