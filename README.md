# Impostor Server 🕶️💬

Un servidor en tiempo real basado en Node.js, Express y Socket.io para el juego multijugador online **Impostor** (un juego de deducción social y descripción de palabras). Este servidor gestiona la lógica de las salas de juego, asignación de roles (Ciudadanos vs Impostores), chat en tiempo real, votaciones, reconexiones rápidas y condiciones de victoria.

---

## 🚀 Características Principales

- 🏢 **Gestión de Salas:** Creación dinámica de salas con códigos únicos de 4 letras generados aleatoriamente.
- ⚡ **Comunicación en Tiempo Real:** Intercambio de datos bidireccional y de baja latencia mediante **Socket.io**.
- 🔄 **Sistema de Reconexión:** Si un jugador se desconecta de manera involuntaria durante la partida o el lobby, puede volver a unirse usando el mismo nombre. El servidor reasignará automáticamente su socket ID, conservando su rol, estado de vida y privilegios (como ser anfitrión).
- 🗳️ **Sistema de Votación Automatizado:**
  - Controlado por el anfitrión (host) con opciones para iniciar o cancelar.
  - Votación en tiempo real con recuento y procesamiento automático una vez que todos los jugadores conectados y vivos han votado.
  - Temporizador de seguridad de 120 segundos para evitar bloqueos.
  - Resolución inteligente de empates (ningún jugador es eliminado).
- 💬 **Chat en Tiempo Real:** Chat integrado con límites de caracteres y sanitización de caracteres especiales para evitar inyecciones HTML.
- 🛡️ **Seguridad y Control:**
  - Rate Limiting básico para la creación de salas (10 segundos de cooldown por cliente).
  - Control de CORS configurado mediante lista blanca (`ALLOWED_ORIGINS`).
  - Sanitización de nombres de jugadores y mensajes de chat.

---

## 🛠️ Tecnologías

Este proyecto está construido con las siguientes tecnologías:

- **Node.js** (Entorno de ejecución para JavaScript)
- **Express** (Framework web para la API HTTP básica y CORS)
- **Socket.io** (Biblioteca para comunicación basada en eventos en tiempo real)
- **CORS** (Seguridad de origen cruzado para restringir el acceso a clientes autorizados)

---

## 📦 Requisitos Previos

Asegúrate de tener instalado en tu máquina:
- [Node.js](https://nodejs.org/) (versión 16.x o superior recomendada)
- [npm](https://www.npmjs.com/) (instalado automáticamente con Node.js)

---

## ⚙️ Instalación y Configuración

Sigue estos pasos para ejecutar el servidor localmente:

1. **Clonar el repositorio o descargar los archivos del proyecto:**
   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd impostor-server
   ```

2. **Instalar las dependencias del proyecto:**
   ```bash
   npm install
   ```

3. **Configurar las variables de entorno (Opcional):**
   Por defecto, el servidor corre en el puerto `3000`. Puedes definir un puerto personalizado utilizando la variable de entorno `PORT`:
   - **En Windows (PowerShell):**
     ```powershell
     $env:PORT="4000"
     ```
   - **En Linux/macOS:**
     ```bash
     export PORT=4000
     ```

4. **Configurar orígenes permitidos (CORS):**
   En el archivo [index.js](file:///c:/Users/ander/Documents/Proyectos/impostor-server/index.js), localiza la constante `ALLOWED_ORIGINS` y añade la URL de tu cliente frontend (por ejemplo, `http://localhost:5173` para desarrollo local con Vite):
   ```javascript
   const ALLOWED_ORIGINS = [
     "https://impostor-play.vercel.app",
     "http://localhost:5173" // Añade tu frontend local aquí
   ];
   ```

---

## 🚦 Ejecución del Servidor

Para iniciar el servidor en modo de producción o ejecución normal:
```bash
npm start
```

Deberías ver el siguiente mensaje impreso en la consola confirmando el inicio:
```text
Server running on port 3000
```

---

## 📖 Flujo General del Juego

1. **Creación de Sala (`create_room`):** Un jugador ingresa su nombre y crea una sala. Este jugador se convierte automáticamente en el **Host** (anfitrión) y recibe un código único de 4 letras.
2. **Unión de Jugadores (`join_room`):** Otros jugadores introducen el código de la sala y su nombre para unirse (máximo 12 jugadores).
3. **Inicio de Partida (`start_game`):** El Host inicia el juego enviando la palabra secreta, la categoría, una pista y el número deseado de impostores.
   - **Ciudadanos:** Reciben la palabra secreta y la categoría.
   - **Impostores:** No conocen la palabra secreta; reciben la categoría y la pista genérica.
4. **Fase de Discusión:** Los jugadores describen por turnos sus palabras en el chat para identificar quién es el impostor, cuidando de no revelar explícitamente la palabra.
5. **Votación (`start_voting`):** El Host inicia la votación.
   - Los jugadores eligen a quién sospechar (`cast_vote`).
   - El jugador con más votos es eliminado. Si hay empate, nadie sale de la partida.
6. **Verificación de Victoria:**
   - **Victoria de Ciudadanos:** Todos los impostores han sido descubiertos y eliminados.
   - **Victoria de Impostor:** El número de impostores vivos es mayor o igual al de ciudadanos vivos.
7. **Reinicio (`reset_game`):** El Host puede reiniciar el juego en cualquier momento para volver a la sala de espera (lobby).

---

## 📡 Eventos de Socket.io (API de Eventos)

Todos los eventos principales se gestionan en el archivo [index.js](file:///c:/Users/ander/Documents/Proyectos/impostor-server/index.js):

### Del Cliente al Servidor (Escucha en Servidor)

| Evento | Estructura de Datos | Descripción |
|---|---|---|
| `create_room` | `playerName` (String) | Crea una sala y convierte al cliente en el Host. |
| `join_room` | `{ roomCode, playerName }` | Permite unirse a una sala activa o reconectarse a ella si se perdió conexión. |
| `leave_room` | `roomCode` (String) | Salir de la sala actual de manera voluntaria. |
| `start_game` | `{ roomCode, wordData: { word, category, hint }, impostorCount }` | Inicia la partida y realiza la asignación aleatoria de roles (Solo Host). |
| `send_chat` | `{ roomCode, message, playerName }` | Envía un mensaje de chat al resto de la sala (mensajes sanitizados). |
| `start_voting` | `roomCode` (String) | Activa la fase de votación de sospechosos (Solo Host). |
| `cancel_voting` | `roomCode` (String) | Cancela la votación actual y regresa a la fase de juego libre (Solo Host). |
| `cast_vote` | `{ roomCode, targetId }` | Registra el voto de un jugador vivo hacia un sospechoso. |
| `reset_game` | `roomCode` (String) | Reinicia la sala y los estados de los jugadores al lobby (Solo Host). |

### Del Servidor al Cliente (Emisiones de Servidor)

| Evento | Datos Enviados | Descripción |
|---|---|---|
| `room_created` | `{ roomCode, isHost, players }` | Notifica al creador que la sala se creó con éxito. |
| `join_success` | `{ roomCode, players }` | Confirma al jugador nuevo su entrada a la sala. |
| `rejoin_success` | `{ roomCode, players, gameState, isHost, roleData }` | Restaura el estado completo de un jugador que se ha reconectado. |
| `update_players` | `{ players, hostId }` | Notifica a todos los clientes la lista actualizada de jugadores. |
| `player_reconnected` | `{ playerId, playerName, players, hostId }` | Informa la reconexión de un participante para actualizar el UI. |
| `player_disconnected` | `{ playerName, playerId, players, hostId }` | Avisa que un jugador se desconectó temporalmente (mantiene su cupo en juego). |
| `game_started` | `{ role, word, category, impostorHint, startingPlayer }` | Entrega a cada jugador su rol e información de juego. |
| `receive_chat` | `{ playerName, message, playerId }` | Retransmite un mensaje de chat a todos los participantes de la sala. |
| `voting_phase_started` | `candidates: Array<{ id, name }>` | Inicia la interfaz de votación enviando la lista de candidatos vivos. |
| `player_eliminated` | `{ eliminatedId, playerName, isYou, wasImpostor }` | Anuncia al jugador eliminado en la votación y su rol real. |
| `voting_cancelled` | `{ reason }` | Informa que la votación terminó en empate o fue cancelada por el Host. |
| `next_round` | `{ startingPlayer }` | Inicia la siguiente ronda e indica quién debe comenzar a hablar. |
| `game_over` | `{ winner, reason, impostorNames }` | Notifica el fin de la partida y anuncia los ganadores. |
| `game_reset` | `players` | Retorna a todos los clientes al lobby del juego. |
| `you_are_now_host` | `{}` | Informa al nuevo anfitrión que ha heredado los privilegios de Host. |
| `error_message` | `message` (String) | Envía una alerta de error específica a un cliente (ej. sala llena, cooldown, etc.). |

---

## 📂 Estructura del Proyecto

```text
impostor-server/
├── index.js          # Código principal con Express, Socket.io y la lógica de juego
├── package.json      # Definición del proyecto, scripts y dependencias
└── README.md         # Documentación oficial del servidor (este archivo)
```

---

## 📝 Licencia

Este proyecto está bajo la Licencia MIT. Eres libre de usarlo, modificarlo y distribuirlo de acuerdo a tus necesidades.
