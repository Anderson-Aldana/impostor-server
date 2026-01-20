/**
 * index.js - Servidor de Impostor
 */

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" } // Permite conexiones desde cualquier web
});

// Aquí guardamos las salas en memoria RAM
// Si el servidor se reinicia o se "duerme" en Render, esto se borra.
const rooms = {};

/**
 * Genera un código de 4 letras ÚNICO.
 * Revisa si ya existe en 'rooms'. Si existe, genera otro.
 */
function generateUniqueRoomCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  
  do {
    result = '';
    for (let i = 0; i < 4; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    // El bucle se repite SI el código ya existe en rooms
  } while (rooms[result]); 
  
  return result;
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // 1. CREAR SALA
  socket.on("create_room", (playerName) => {
    const roomCode = generateUniqueRoomCode();
    
    rooms[roomCode] = {
      host: socket.id, // Guardamos quién es el jefe de sala
      players: [{ id: socket.id, name: playerName }],
      gameState: "lobby"
    };
    
    socket.join(roomCode);
    console.log(`Sala creada: ${roomCode} por ${playerName}`);
    
    // Confirmamos al creador
    socket.emit("room_created", { 
        roomCode, 
        isHost: true, 
        players: rooms[roomCode].players 
    });
  });

  // 2. UNIRSE A SALA
  socket.on("join_room", ({ roomCode, playerName }) => {
    // Convertimos a mayúsculas por si acaso
    roomCode = roomCode.toUpperCase();
    const room = rooms[roomCode];
    
    // Validaciones
    if (!room) {
        return socket.emit("error_message", "Sala no encontrada. Revisa el código.");
    }
    if (room.gameState !== "lobby") {
        return socket.emit("error_message", "La partida ya empezó.");
    }
    if (room.players.length >= 12) {
        return socket.emit("error_message", "La sala está llena (Máx 12).");
    }

    // Comprobar si ya hay alguien con ese nombre en la sala (opcional, para evitar confusión)
    const nameExists = room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (nameExists) {
        return socket.emit("error_message", "Ya hay alguien con ese nombre en la sala.");
    }

    // Agregar jugador
    room.players.push({ id: socket.id, name: playerName });
    socket.join(roomCode);
    
    console.log(`${playerName} se unió a ${roomCode}`);

    // Avisar a TODOS en la sala que llegó alguien nuevo
    io.to(roomCode).emit("update_players", room.players);
  });

  // 3. INICIAR JUEGO (Recibe la palabra del Host)
  socket.on("start_game", ({ roomCode, wordData, impostorCount }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Solo el host puede iniciar (seguridad extra)
    if (room.host !== socket.id) return;

    // Elegir impostores al azar
    const playerIds = room.players.map(p => p.id);
    const impostors = [];
    
    // Aseguramos que impostorCount no sea mayor que jugadores - 1
    const maxImpostors = Math.max(1, playerIds.length - 1);
    const finalImpostorCount = Math.min(impostorCount, maxImpostors);

    while (impostors.length < finalImpostorCount) {
        const randomIndex = Math.floor(Math.random() * playerIds.length);
        const selectedId = playerIds[randomIndex];
        if (!impostors.includes(selectedId)) {
            impostors.push(selectedId);
        }
    }

    room.gameState = "playing";
    console.log(`Juego iniciado en ${roomCode}. Impostores: ${impostors.length}`);

    // Repartir roles a cada jugador individualmente
    room.players.forEach(player => {
        const isImpostor = impostors.includes(player.id);
        
        const dataToSend = {
            role: isImpostor ? "impostor" : "citizen",
            word: isImpostor ? null : wordData.word, // Ciudadano recibe palabra
            category: wordData.category,
            impostorHint: isImpostor ? wordData.hint : null // Impostor recibe pista
        };
        
        io.to(player.id).emit("game_started", dataToSend);
    });
  });

  // 4. DESCONEXIÓN
  socket.on("disconnect", () => {
    // Buscar en qué sala estaba el jugador que se fue
    for (const code in rooms) {
      const room = rooms[code];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        // Lo sacamos de la lista
        const removedPlayer = room.players[playerIndex];
        room.players.splice(playerIndex, 1);
        console.log(`${removedPlayer.name} salió de ${code}`);
        
        // Si la sala se queda vacía, la borramos para liberar memoria
        if (room.players.length === 0) {
          delete rooms[code];
          console.log(`Sala ${code} eliminada por estar vacía.`);
        } else {
          // Si quedan jugadores, avisamos que alguien se fue
          // (Opcional: Si el host se fue, podríamos asignar uno nuevo, 
          // pero por ahora simple: la sala sigue sin host o el host original sigue siendo la ref)
          io.to(code).emit("update_players", room.players);
        }
        break; // Ya lo encontramos, dejamos de buscar
      }
    }
  });
});

// Render asigna un puerto automáticamente en process.env.PORT
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});