const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

const disconnectTimers = {};

// 1. SEGURIDAD CORS
const ALLOWED_ORIGINS = [
  "https://impostor-play.vercel.app"
];

app.use(cors({
  origin: ALLOWED_ORIGINS
}));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"]
  }
});

const rooms = {};

// Mapa para controlar la velocidad de creación de salas (Rate Limiting)
const roomCreationLimits = new Map();

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

// Función auxiliar para limpiar texto (Sanitización básica en servidor)
function sanitizeInput(str) {
    if (!str) return "";
    return String(str).trim().substring(0, 50).replace(/[<>]/g, ""); // Elimina < y >
}

io.on("connection", (socket) => {
  console.log("Conectado:", socket.id);

  // --- EVENTO DE RECONEXIÓN ---
  socket.on("rejoin_room", ({ roomCode, playerName }) => {
    const code = sanitizeInput(roomCode);
    const name = sanitizeInput(playerName);
    const room = rooms[code];

    if (!room) {
        // La sala ya no existe, decirle al cliente que borre su memoria
        return socket.emit("error_message", "La sala ya no existe.");
    }

    // Buscar al jugador por nombre (ya que el socket.id cambió al recargar)
    const playerIndex = room.players.findIndex(p => p.name === name);

    if (playerIndex !== -1) {
        const oldSocketId = room.players[playerIndex].id;
        
        // 1. Cancelar la "muerte" pendiente del socket anterior
        if (disconnectTimers[oldSocketId]) {
            clearTimeout(disconnectTimers[oldSocketId]);
            delete disconnectTimers[oldSocketId];
            console.log(`Reconexión exitosa: ${name} recuperado.`);
        }

        // 2. Actualizar el ID del jugador al nuevo socket
        room.players[playerIndex].id = socket.id;
        socket.join(code);

        // 3. Restaurar estado del cliente
        // ¿Era el host?
        const isHost = (room.host === oldSocketId); 
        if (isHost) room.host = socket.id; // Actualizar host ID también

        // Enviar datos actualizados a todos
        io.to(code).emit("update_players", { players: room.players, hostId: room.host });

        // Si la partida ya estaba en curso, hay que devolverle su ROL
        if (room.gameState === "playing") {
            socket.emit("game_started", room.players[playerIndex].roleData);
        } else {
            socket.emit("join_success", { roomCode: code, players: room.players });
        }
        
    } else {
        socket.emit("error_message", "No se pudo recuperar la sesión.");
    }
  });

  // --- CREAR SALA (CON PROTECCIÓN DE RATE LIMIT) ---
  socket.on("create_room", (rawPlayerName) => {
    // 2. RATE LIMITING: Evitar crear más de 1 sala cada 10 segundos por socket
    const lastCreation = roomCreationLimits.get(socket.id);
    const now = Date.now();
    if (lastCreation && now - lastCreation < 10000) {
        return socket.emit("error_message", "Espera unos segundos antes de crear otra sala.");
    }
    roomCreationLimits.set(socket.id, now);

    const playerName = sanitizeInput(rawPlayerName);
    if (!playerName) return socket.emit("error_message", "Nombre inválido.");

    const roomCode = generateUniqueRoomCode();
    rooms[roomCode] = {
      host: socket.id,
      players: [{ id: socket.id, name: playerName }],
      gameState: "lobby"
    };
    socket.join(roomCode);
    
    socket.emit("room_created", { 
        roomCode, 
        isHost: true, 
        players: rooms[roomCode].players 
    });
  });

  // --- UNIRSE A SALA ---
  socket.on("join_room", ({ roomCode, playerName: rawName }) => {
    const playerName = sanitizeInput(rawName);
    if (!roomCode || !playerName) return socket.emit("error_message", "Datos inválidos.");

    const code = roomCode.toUpperCase(); // Sanitizar código
    const room = rooms[code];
    
    if (!room) return socket.emit("error_message", "Sala no encontrada.");
    if (room.gameState !== "lobby") return socket.emit("error_message", "La partida ya empezó.");
    if (room.players.length >= 12) return socket.emit("error_message", "Sala llena.");
    
    // Verificar nombre duplicado
    const nameExists = room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (nameExists) return socket.emit("error_message", "Ese nombre ya está en uso.");

    room.players.push({ id: socket.id, name: playerName });
    socket.join(code);

    socket.emit("join_success", { roomCode: code, players: room.players });
    io.to(code).emit("update_players", room.players);
  });

  // --- MANEJO DE SALIDA ---
  const handlePlayerExit = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
        const wasHost = (room.host === socket.id);
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
            delete rooms[roomCode];
            console.log(`Sala ${roomCode} eliminada (vacía).`);
        } else {
            if (wasHost) {
                room.host = room.players[0].id; // Nuevo host
            }
            io.to(roomCode).emit("update_players", {
                players: room.players,
                hostId: room.host
            });
        }
    }
  };

  socket.on("leave_room", (roomCode) => {
    handlePlayerExit(roomCode);
    socket.leave(roomCode);
  });

  // --- INICIAR JUEGO ---
  socket.on("start_game", ({ roomCode, wordData, impostorCount }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;

    // Validación básica de datos del juego
    if (!wordData || !wordData.word || !wordData.category) return;

    const playerIds = room.players.map(p => p.id);
    const impostors = [];
    const maxImpostors = Math.max(1, playerIds.length - 1);
    const finalImpostorCount = Math.min(impostorCount, maxImpostors);

    while (impostors.length < finalImpostorCount) {
        const r = Math.floor(Math.random() * playerIds.length);
        if (!impostors.includes(playerIds[r])) impostors.push(playerIds[r]);
    }

    // === NUEVO: ELEGIR JUGADOR INICIAL ===
    const startingPlayerIndex = Math.floor(Math.random() * room.players.length);
    const startingPlayerName = room.players[startingPlayerIndex].name;

    room.gameState = "playing";
    room.players.forEach(player => {
        const isImpostor = impostors.includes(player.id);
        
        // GUARDA EL ROL EN EL SERVIDOR
        player.roleData = {
            role: isImpostor ? "impostor" : "citizen",
            word: isImpostor ? null : wordData.word,
            category: wordData.category,
            impostorHint: isImpostor ? wordData.hint : null,
            startingPlayer: startingPlayerName
        };

        io.to(player.id).emit("game_started", player.roleData);
    });
  });

  socket.on("disconnect", () => {
    console.log("Desconectado (esperando...):", socket.id);

    // En lugar de borrar inmediatamente, esperamos 45 segundos
    disconnectTimers[socket.id] = setTimeout(() => {
        console.log("Tiempo agotado. Eliminando:", socket.id);
        
        // Lógica original de eliminación
        for (const code in rooms) {
            const room = rooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                const wasHost = (room.host === socket.id);
                room.players.splice(playerIndex, 1); // Ahora sí lo borramos
                
                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    if (wasHost) {
                        room.host = room.players[0].id;
                    }
                    io.to(code).emit("update_players", {
                        players: room.players,
                        hostId: room.host
                    });
                }
                break;
            }
        }
        delete disconnectTimers[socket.id]; // Limpiar timer
    }, 45000); // 45 segundos de gracia
  });

  socket.on("reset_game", (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
        room.gameState = "lobby";
        io.to(roomCode).emit("game_reset", room.players);
    }
  });

  // --- CHAT (Sanitizado) ---
  socket.on("send_chat", ({ roomCode, message, playerName }) => {
    if (!message || typeof message !== 'string') return;
    
    // 3. SANITIZACIÓN: Limpiar mensaje y limitar longitud
    const cleanMessage = sanitizeInput(message);
    const cleanName = sanitizeInput(playerName);

    if (cleanMessage.length > 0) {
        io.to(roomCode).emit("receive_chat", {
            playerName: cleanName,
            message: cleanMessage
        });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));