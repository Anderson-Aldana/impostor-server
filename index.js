const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

const rooms = {};

function generateUniqueRoomCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  do {
    result = '';
    for (let i = 0; i < 4; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
  } while (rooms[result]); 
  return result;
}

io.on("connection", (socket) => {
  console.log("Conectado:", socket.id);

  // 1. CREAR SALA
  socket.on("create_room", (playerName) => {
    const roomCode = generateUniqueRoomCode();
    rooms[roomCode] = {
      host: socket.id,
      players: [{ id: socket.id, name: playerName }],
      gameState: "lobby"
    };
    socket.join(roomCode);
    
    // Avisar al creador
    socket.emit("room_created", { 
        roomCode, 
        isHost: true, 
        players: rooms[roomCode].players 
    });
  });

  // 2. UNIRSE A SALA (CORREGIDO)
  socket.on("join_room", ({ roomCode, playerName }) => {
    roomCode = roomCode.toUpperCase();
    const room = rooms[roomCode];
    
    if (!room) return socket.emit("error_message", "Sala no encontrada.");
    if (room.gameState !== "lobby") return socket.emit("error_message", "La partida ya empezó.");
    if (room.players.length >= 12) return socket.emit("error_message", "Sala llena.");
    
    // Verificar nombre duplicado
    const nameExists = room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (nameExists) return socket.emit("error_message", "Ese nombre ya está en uso.");

    room.players.push({ id: socket.id, name: playerName });
    socket.join(roomCode);

    // IMPORTANTE: Avisar AL INVITADO que entró con éxito
    socket.emit("join_success", { 
        roomCode, 
        players: room.players 
    });

    // Avisar a TODOS que la lista cambió
    io.to(roomCode).emit("update_players", room.players);
  });

  // 3. SALIR DE SALA (NUEVO)
  socket.on("leave_room", (roomCode) => {
    const room = rooms[roomCode];
    if (room) {
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            socket.leave(roomCode);
            
            if (room.players.length === 0) {
                delete rooms[roomCode];
            } else {
                // Si el host se va, el juego podría romperse, o asignamos nuevo host. 
                // Por simplicidad, solo actualizamos lista.
                io.to(roomCode).emit("update_players", room.players);
            }
        }
    }
  });

  // 4. INICIAR JUEGO
  socket.on("start_game", ({ roomCode, wordData, impostorCount }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;

    const playerIds = room.players.map(p => p.id);
    const impostors = [];
    const maxImpostors = Math.max(1, playerIds.length - 1);
    const finalImpostorCount = Math.min(impostorCount, maxImpostors);

    while (impostors.length < finalImpostorCount) {
        const r = Math.floor(Math.random() * playerIds.length);
        if (!impostors.includes(playerIds[r])) impostors.push(playerIds[r]);
    }

    room.gameState = "playing";
    room.players.forEach(player => {
        const isImpostor = impostors.includes(player.id);
        io.to(player.id).emit("game_started", {
            role: isImpostor ? "impostor" : "citizen",
            word: isImpostor ? null : wordData.word,
            category: wordData.category,
            impostorHint: isImpostor ? wordData.hint : null
        });
    });
  });

  // 5. DESCONEXIÓN
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) delete rooms[code];
        else io.to(code).emit("update_players", room.players);
        break;
      }
    }
  });

  // 6. REINICIAR PARTIDA (Volver al Lobby)
  socket.on("reset_game", (roomCode) => {
    const room = rooms[roomCode];
    
    // Solo el anfitrión puede reiniciar
    if (room && room.host === socket.id) {
        room.gameState = "lobby";
        // Avisamos a TODOS en la sala que vuelvan al lobby
        io.to(roomCode).emit("game_reset", room.players);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));