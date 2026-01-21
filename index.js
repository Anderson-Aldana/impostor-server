const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

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
    console.log("Desconectado:", socket.id);

    for (const code in rooms) {
      const room = rooms[code];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        const wasHost = (room.host === socket.id);
        
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
          // Si no queda nadie, borramos la sala
          delete rooms[code];
          console.log(`Sala ${code} eliminada (vacía).`);
        } else {
          // Si quedan jugadores, reasignamos host si es necesario
          if (wasHost) {
            room.host = room.players[0].id;
          }
          // Avisamos a todos los que quedan
          io.to(code).emit("update_players", {
            players: room.players,
            hostId: room.host
          });
        }
        break;
      }
    }
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

  // --- INICIAR FASE DE VOTACIÓN ---
  socket.on("start_voting", (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.gameState !== "playing") return;

    room.gameState = "voting";
    room.votes = {}; // Objeto simple para guardar votos: { "id_votante": "id_objetivo" }

    // Filtramos solo jugadores VIVOS para que voten
    const alivePlayers = room.players.filter(p => !p.isDead);
    
    // Enviamos solo los datos necesarios (id, name)
    const candidates = alivePlayers.map(p => ({ id: p.id, name: p.name }));
    
    io.to(roomCode).emit("voting_phase_started", candidates);
  });

  // --- RECIBIR VOTO ---
  socket.on("cast_vote", ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== "voting") return;

    // Verificar si el jugador ya votó o está muerto
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.isDead || room.votes[socket.id]) return;

    // Registrar voto
    room.votes[socket.id] = targetId;

    // Contar cuántos vivos faltan por votar
    const aliveCount = room.players.filter(p => !p.isDead).length;
    const votesCount = Object.keys(room.votes).length;

    // Si todos votaron, procesamos resultado
    if (votesCount >= aliveCount) {
        processVotingResult(roomCode);
    }
  });
});

// --- FUNCIÓN PARA PROCESAR RESULTADOS ---
function processVotingResult(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // 1. Contar Votos
    const tallies = {};
    Object.values(room.votes).forEach(targetId => {
        tallies[targetId] = (tallies[targetId] || 0) + 1;
    });

    // 2. Encontrar al más votado
    let maxVotes = -1;
    let eliminatedId = null;
    
    for (const [target, count] of Object.entries(tallies)) {
        if (count > maxVotes) {
            maxVotes = count;
            eliminatedId = target;
        }
    }

    // 3. Ejecutar Eliminación
    const victimIndex = room.players.findIndex(p => p.id === eliminatedId);
    
    if (victimIndex !== -1) {
        const victim = room.players[victimIndex];
        victim.isDead = true; 
        
        // Datos del rol de la víctima para revelar a todos
        const wasImpostor = (victim.roleData && victim.roleData.role === 'impostor');

        // Notificar eliminación (Revelando si era o no impostor)
        room.players.forEach(p => {
             io.to(p.id).emit("player_eliminated", {
                 eliminatedId: victim.id,
                 playerName: victim.name,
                 isYou: (p.id === victim.id),
                 wasImpostor: wasImpostor // <--- ENVIAMOS ESTE DATO
             });
        });

        // 4. VERIFICAR CONDICIONES DE VICTORIA

        // A) Si eliminaron al Impostor (o a TODOS los impostores si hay varios)
        const remainingImpostors = room.players.filter(p => !p.isDead && p.roleData.role === 'impostor');
        
        if (remainingImpostors.length === 0) {
            io.to(roomCode).emit("game_over", { 
                winner: 'citizen', 
                reason: `¡Eliminaron a ${victim.name}! Era el Impostor.`,
                impostorNames: [victim.name] // Para mostrar quién era
            });
            resetRoomToLobby(room);
            return;
        }

        // B) Si ganan los Impostores
        // Regla: Ganan si son igual o más cantidad que los ciudadanos (ej: 1 Imp vs 1 Ciudadano, o 2 vs 2)
        const survivors = room.players.filter(p => !p.isDead);
        const impostorsCount = remainingImpostors.length;
        const citizensCount = survivors.length - impostorsCount;

        if (impostorsCount >= citizensCount) {
            // Obtenemos los nombres de TODOS los impostores (vivos y muertos) para revelarlos
            const allImpostors = room.players
                .filter(p => p.roleData.role === 'impostor')
                .map(p => p.name);

            io.to(roomCode).emit("game_over", { 
                winner: 'impostor', 
                reason: "Los Impostores han tomado el control de la nave.",
                impostorNames: allImpostors // <--- LISTA DE NOMBRES
            });
            resetRoomToLobby(room);
            return;
        }

        // 5. EL JUEGO SIGUE (NEXT ROUND)
        // Si había 4 jugadores (1 Imp, 3 Cit) y se va 1 Cit -> Quedan 3 (1 Imp, 2 Cit).
        // 1 < 2, así que entra aquí y sigue jugando.
        room.gameState = "playing";
        room.votes = {}; 
        
        const randomSurvivor = survivors[Math.floor(Math.random() * survivors.length)];
        
        io.to(roomCode).emit("next_round", {
            startingPlayer: randomSurvivor.name
        });

    } else {
        // Empate o error
        room.gameState = "playing";
        room.votes = {};
        const survivors = room.players.filter(p => !p.isDead);
        io.to(roomCode).emit("next_round", { startingPlayer: survivors[0].name });
    }
}

function resetRoomToLobby(room) {
    room.gameState = "lobby";
    room.votes = {};
    // Revivir a todos para la próxima partida
    room.players.forEach(p => { 
        p.isDead = false; 
        p.roleData = null; 
    });
    
    // Pequeño delay para que lean el resultado antes de ir al lobby
    setTimeout(() => {
        io.to(room.players[0].id).emit("game_reset", room.players); // Usamos el evento existente
        // Y actualizamos a todos
        const hostId = room.host; 
        // Nota: en tu codigo original game_reset mandaba al lobby.
        // Asegurate de emitir update_players también
        room.players.forEach(p => {
             io.to(p.id).emit("game_reset", room.players);
        });
    }, 4000);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));