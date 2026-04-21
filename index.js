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

// Mapa: socketId → { roomCode, playerName } para reconexión rápida
const sessionMap = new Map();

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

function sanitizeInput(str) {
    if (!str) return "";
    return String(str).trim().substring(0, 50).replace(/[<>]/g, "");
}

// Cancela el timer de votación de una sala si existe
function clearVotingTimer(room) {
    if (room._votingTimer) {
        clearTimeout(room._votingTimer);
        room._votingTimer = null;
    }
}

// Procesa resultado de votación: lógica central
function processVotingResult(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearVotingTimer(room);

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

        const wasImpostor = (victim.roleData && victim.roleData.role === 'impostor');

        // Notificar eliminación a todos (incluyendo desconectados cuando reconecten)
        room.players.forEach(p => {
            if (!p.disconnected) {
                io.to(p.id).emit("player_eliminated", {
                    eliminatedId: victim.id,
                    playerName: victim.name,
                    isYou: (p.id === victim.id),
                    wasImpostor: wasImpostor
                });
            }
        });

        // 4. VERIFICAR CONDICIONES DE VICTORIA
        const remainingImpostors = room.players.filter(p => !p.isDead && p.roleData && p.roleData.role === 'impostor');

        if (remainingImpostors.length === 0) {
            io.to(roomCode).emit("game_over", {
                winner: 'citizen',
                reason: `¡Eliminaron a ${victim.name}! Era el Impostor.`,
                impostorNames: [victim.name]
            });
            resetRoomToLobby(room, roomCode);
            return;
        }

        const survivors = room.players.filter(p => !p.isDead);
        const impostorsCount = remainingImpostors.length;
        const citizensCount = survivors.length - impostorsCount;

        if (impostorsCount >= citizensCount) {
            const allImpostors = room.players
                .filter(p => p.roleData && p.roleData.role === 'impostor')
                .map(p => p.name);

            io.to(roomCode).emit("game_over", {
                winner: 'impostor',
                reason: "Los Impostores han tomado el control de la nave.",
                impostorNames: allImpostors
            });
            resetRoomToLobby(room, roomCode);
            return;
        }

        // 5. EL JUEGO SIGUE (NEXT ROUND)
        room.gameState = "playing";
        room.votes = {};

        const aliveSurvivors = survivors.filter(p => !p.disconnected);
        const nextPlayer = aliveSurvivors.length > 0
            ? aliveSurvivors[Math.floor(Math.random() * aliveSurvivors.length)]
            : survivors[Math.floor(Math.random() * survivors.length)];

        io.to(roomCode).emit("next_round", {
            startingPlayer: nextPlayer.name
        });

    } else {
        // Empate o sin votos → continuar
        room.gameState = "playing";
        room.votes = {};
        const survivors = room.players.filter(p => !p.isDead && !p.disconnected);
        const fallback = survivors[0] || room.players.find(p => !p.isDead);
        io.to(roomCode).emit("voting_cancelled", { reason: "Empate en la votación. ¡Nadie fue eliminado!" });
        if (fallback) {
            io.to(roomCode).emit("next_round", { startingPlayer: fallback.name });
        }
    }
}

function resetRoomToLobby(room, roomCode) {
    clearVotingTimer(room);
    room.gameState = "lobby";
    room.votes = {};
    room.players.forEach(p => {
        p.isDead = false;
        p.roleData = null;
        p.disconnected = false; // al reiniciar, limpiar desconectados
    });

    setTimeout(() => {
        // Solo emitir a jugadores aún conectados
        const connectedPlayers = room.players;
        connectedPlayers.forEach(p => {
            io.to(p.id).emit("game_reset", connectedPlayers);
        });
    }, 4000);
}

io.on("connection", (socket) => {
  console.log("Conectado:", socket.id);

  // ─────────────────────────────────────────────
  //  CREAR SALA
  // ─────────────────────────────────────────────
  socket.on("create_room", (rawPlayerName) => {
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
      players: [{ id: socket.id, name: playerName, isDead: false, disconnected: false, roleData: null }],
      gameState: "lobby",
      votes: {}
    };
    socket.join(roomCode);
    sessionMap.set(socket.id, { roomCode, playerName });

    socket.emit("room_created", {
        roomCode,
        isHost: true,
        players: rooms[roomCode].players
    });
  });

  // ─────────────────────────────────────────────
  //  UNIRSE A SALA  (soporta reconexión)
  // ─────────────────────────────────────────────
  socket.on("join_room", ({ roomCode, playerName: rawName }) => {
    const playerName = sanitizeInput(rawName);
    if (!roomCode || !playerName) return socket.emit("error_message", "Datos inválidos.");

    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) return socket.emit("error_message", "Sala no encontrada.");
    if (room.players.length >= 12) return socket.emit("error_message", "Sala llena.");

    // ── CASO: Reconexión durante juego ───────────────────────────────
    // Busca al jugador por nombre (aunque cambió su socket ID)
    const existingPlayer = room.players.find(
        p => p.name.toLowerCase() === playerName.toLowerCase()
    );

    if (existingPlayer) {
        if (room.gameState === "lobby") {
            // En lobby: nombre duplicado de un jugador activo
            if (!existingPlayer.disconnected) {
                return socket.emit("error_message", "Ese nombre ya está en uso en esta sala.");
            }
        }

        // Reconexión válida: actualizar socket ID
        const oldId = existingPlayer.id;
        existingPlayer.id = socket.id;
        existingPlayer.disconnected = false;

        // Si era el host, transferir host al nuevo socket ID
        if (room.host === oldId) {
            room.host = socket.id;
        }

        socket.join(code);
        sessionMap.set(socket.id, { roomCode: code, playerName });

        // Avisarle su estado actual
        socket.emit("rejoin_success", {
            roomCode: code,
            players: room.players,
            gameState: room.gameState,
            isHost: (room.host === socket.id),
            roleData: existingPlayer.roleData || null
        });

        // Avisar a todos que volvió
        io.to(code).emit("player_reconnected", {
            playerId: socket.id,
            playerName: existingPlayer.name,
            players: room.players,
            hostId: room.host
        });

        // Si la votación estaba activa, avisarle los candidatos actuales
        if (room.gameState === "voting") {
            const alivePlayers = room.players.filter(p => !p.isDead);
            const candidates = alivePlayers.map(p => ({ id: p.id, name: p.name }));
            socket.emit("voting_phase_started", candidates);
        }

        return;
    }

    // ── CASO: Jugador nuevo ───────────────────────────────────────────
    if (room.gameState !== "lobby") {
        return socket.emit("error_message", "La partida ya empezó y no estabas en esta sala.");
    }

    room.players.push({ id: socket.id, name: playerName, isDead: false, disconnected: false, roleData: null });
    socket.join(code);
    sessionMap.set(socket.id, { roomCode: code, playerName });

    socket.emit("join_success", { roomCode: code, players: room.players });
    io.to(code).emit("update_players", { players: room.players, hostId: room.host });
  });

  // ─────────────────────────────────────────────
  //  SALIR VOLUNTARIO
  // ─────────────────────────────────────────────
  const handlePlayerExit = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const wasHost = (room.host === socket.id);
    room.players.splice(playerIndex, 1);

    sessionMap.delete(socket.id);

    if (room.players.length === 0) {
        clearVotingTimer(room);
        delete rooms[roomCode];
        console.log(`Sala ${roomCode} eliminada (vacía).`);
    } else {
        if (wasHost) {
            room.host = room.players[0].id;
        }
        io.to(roomCode).emit("update_players", {
            players: room.players,
            hostId: room.host
        });
        // Si la votación quedó sin suficientes jugadores, resolverla
        if (room.gameState === "voting") {
            _checkVotingCompletion(roomCode);
        }
    }
  };

  socket.on("leave_room", (roomCode) => {
    handlePlayerExit(roomCode);
    socket.leave(roomCode);
  });

  // ─────────────────────────────────────────────
  //  INICIAR JUEGO
  // ─────────────────────────────────────────────
  socket.on("start_game", ({ roomCode, wordData, impostorCount }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    if (!wordData || !wordData.word || !wordData.category) return;

    // Solo jugadores conectados participan
    const activePlayers = room.players.filter(p => !p.disconnected);
    if (activePlayers.length < 3) {
        return socket.emit("error_message", "Se necesitan mínimo 3 jugadores activos para iniciar.");
    }

    const playerIds = activePlayers.map(p => p.id);
    const impostors = [];
    const maxImpostors = Math.max(1, playerIds.length - 1);
    const finalImpostorCount = Math.min(impostorCount, maxImpostors);

    while (impostors.length < finalImpostorCount) {
        const r = Math.floor(Math.random() * playerIds.length);
        if (!impostors.includes(playerIds[r])) impostors.push(playerIds[r]);
    }

    const startingPlayerIndex = Math.floor(Math.random() * activePlayers.length);
    const startingPlayerName = activePlayers[startingPlayerIndex].name;

    room.gameState = "playing";
    room.votes = {};

    // Asignar roles SOLO a jugadores activos
    activePlayers.forEach(player => {
        const isImpostor = impostors.includes(player.id);
        player.roleData = {
            role: isImpostor ? "impostor" : "citizen",
            word: isImpostor ? null : wordData.word,
            category: wordData.category,
            impostorHint: isImpostor ? wordData.hint : null,
            startingPlayer: startingPlayerName
        };
        player.isDead = false;
        io.to(player.id).emit("game_started", player.roleData);
    });
  });

  // ─────────────────────────────────────────────
  //  RESET
  // ─────────────────────────────────────────────
  socket.on("reset_game", (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
        clearVotingTimer(room);
        room.gameState = "lobby";
        room.votes = {};
        room.players.forEach(p => {
            p.isDead = false;
            p.roleData = null;
        });
        io.to(roomCode).emit("game_reset", room.players);
    }
  });

  // ─────────────────────────────────────────────
  //  CHAT
  // ─────────────────────────────────────────────
  socket.on("send_chat", ({ roomCode, message, playerName }) => {
    if (!message || typeof message !== 'string') return;
    const cleanMessage = sanitizeInput(message);
    const cleanName = sanitizeInput(playerName);
    if (cleanMessage.length > 0) {
        io.to(roomCode).emit("receive_chat", {
            playerName: cleanName,
            message: cleanMessage,
            playerId: socket.id
        });
    }
  });

  // ─────────────────────────────────────────────
  //  INICIAR VOTACIÓN
  // ─────────────────────────────────────────────
  socket.on("start_voting", (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.gameState !== "playing") return;

    room.gameState = "voting";
    room.votes = {};

    const alivePlayers = room.players.filter(p => !p.isDead);
    const candidates = alivePlayers.map(p => ({ id: p.id, name: p.name }));

    io.to(roomCode).emit("voting_phase_started", candidates);

    // Timer de seguridad: si en 120s no votan todos, procesamos igual
    clearVotingTimer(room);
    room._votingTimer = setTimeout(() => {
        console.log(`[${roomCode}] Timeout de votación. Procesando votos actuales.`);
        if (room.gameState === "voting") {
            processVotingResult(roomCode);
        }
    }, 120000);
  });

  // ─────────────────────────────────────────────
  //  CANCELAR VOTACIÓN (SOLO HOST)
  // ─────────────────────────────────────────────
  socket.on("cancel_voting", (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.gameState !== "voting") return;

    clearVotingTimer(room);
    room.gameState = "playing";
    room.votes = {};

    io.to(roomCode).emit("voting_cancelled", { reason: "El anfitrión canceló la votación." });
  });

  // ─────────────────────────────────────────────
  //  RECIBIR VOTO
  // ─────────────────────────────────────────────
  socket.on("cast_vote", ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== "voting") return;

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || voter.isDead || voter.disconnected || room.votes[socket.id]) return;

    room.votes[socket.id] = targetId;

    _checkVotingCompletion(roomCode);
  });

  // ─────────────────────────────────────────────
  //  DESCONEXIÓN
  // ─────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log("Desconectado:", socket.id);

    for (const code in rooms) {
        const room = rooms[code];
        const player = room.players.find(p => p.id === socket.id);

        if (player) {
            if (room.gameState === "lobby") {
                // En lobby: sacar al jugador directamente
                room.players = room.players.filter(p => p.id !== socket.id);
                sessionMap.delete(socket.id);

                if (room.players.length === 0) {
                    clearVotingTimer(room);
                    delete rooms[code];
                    console.log(`Sala ${code} eliminada (vacía).`);
                } else {
                    if (room.host === socket.id) {
                        room.host = room.players[0].id;
                    }
                    io.to(code).emit("update_players", {
                        players: room.players,
                        hostId: room.host
                    });
                }
            } else {
                // En juego/votación: marcar como desconectado (RESERVAR SU ROL)
                player.disconnected = true;

                const wasHost = (room.host === socket.id);
                if (wasHost) {
                    // Transferir host al siguiente jugador conectado
                    const nextHost = room.players.find(p => p.id !== socket.id && !p.disconnected);
                    if (nextHost) {
                        room.host = nextHost.id;
                        io.to(nextHost.id).emit("you_are_now_host", {});
                    }
                }

                // Avisar a todos
                io.to(code).emit("player_disconnected", {
                    playerName: player.name,
                    playerId: socket.id,
                    players: room.players,
                    hostId: room.host
                });

                // Si estaba en votación, revisar si ya se puede procesar
                if (room.gameState === "voting") {
                    _checkVotingCompletion(code);
                }
            }
            break;
        }
    }
  });
});

// ─────────────────────────────────────────────
//  HELPER: Comprobar si todos los vivos votaron
// ─────────────────────────────────────────────
function _checkVotingCompletion(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.gameState !== "voting") return;

    // Jugadores vivos Y conectados son los únicos que pueden votar
    const aliveAndConnected = room.players.filter(p => !p.isDead && !p.disconnected);
    const votesCount = Object.keys(room.votes).length;

    // Procesamos si todos los que pueden votar ya votaron
    if (votesCount >= aliveAndConnected.length && aliveAndConnected.length > 0) {
        processVotingResult(roomCode);
    }
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));