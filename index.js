require('dotenv').config();  // Load environment variables
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS origin – use env variable or fallback to * (development)
const allowedOrigin = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
    cors: {
        origin: allowedOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
    },
});

// Production: serve frontend static files
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../client/dist')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../client/dist', 'index.html'));
    });
} else {
    app.get('/', (req, res) => res.send('Server running'));
}

// ---------- Global state (unchanged) ----------
const rooms = new Map();
const usernames = new Set();
const usernameToSocket = new Map();
const socketToRoom = new Map();
const socketToUser = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function generateColor() {
    const colors = ['#FF6B9D', '#C77DFF', '#72EFDD', '#FFB347', '#87CEEB', '#FF8C69', '#98FB98', '#DDA0DD', '#F0E68C', '#87CEFA'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (room && room.players.size === 0) {
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted (empty)`);
    }
}

// ---------- Socket handlers (unchanged logic) ----------
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Lobby: set/change username
    socket.on('join_lobby', ({ username }) => {
        const trimmed = username?.trim().slice(0, 20);
        if (!trimmed) return socket.emit('error', { msg: 'Username required' });

        const oldUsername = socketToUser.get(socket.id);
        if (oldUsername) {
            usernames.delete(oldUsername.toLowerCase());
            usernameToSocket.delete(oldUsername.toLowerCase());
        }

        const existingSocketId = usernameToSocket.get(trimmed.toLowerCase());
        if (existingSocketId && existingSocketId !== socket.id) {
            const existingSocket = io.sockets.sockets.get(existingSocketId);
            if (!existingSocket) {
                usernames.delete(trimmed.toLowerCase());
                usernameToSocket.delete(trimmed.toLowerCase());
            } else {
                return socket.emit('error', { msg: 'Username already taken' });
            }
        }

        usernames.add(trimmed.toLowerCase());
        socketToUser.set(socket.id, trimmed);
        usernameToSocket.set(trimmed.toLowerCase(), socket.id);
        socket.emit('lobby_joined', { username: trimmed });
    });

    // Create room
    socket.on('create_room', () => {
        const username = socketToUser.get(socket.id);
        if (!username) return socket.emit('error', { msg: 'Not in lobby' });
        if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'Already in a room' });

        const code = generateRoomCode();
        const color = generateColor();
        const player = {
            id: socket.id,
            username,
            color,
            x: 400 + Math.random() * 100 - 50,
            y: 300 + Math.random() * 100 - 50,
            hat: null,
            pet: null,
            sitting: false,
            sittingAt: null
        };

        rooms.set(code, {
            code,
            players: new Map([[socket.id, player]]),
            musicState: { track: 0, startTime: Date.now(), playing: true },
            weather: 'rain',
            created: Date.now()
        });

        socketToRoom.set(socket.id, code);
        socket.join(code);
        socket.emit('room_joined', { code, player, players: [player], musicState: rooms.get(code).musicState });
    });

    // Join room
    socket.on('join_room', ({ code }) => {
        const username = socketToUser.get(socket.id);
        if (!username) return socket.emit('error', { msg: 'Not in lobby' });
        if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'You are already in a room. Leave it first.' });

        const upperCode = code?.toUpperCase().trim();
        const room = rooms.get(upperCode);
        if (!room) return socket.emit('error', { msg: 'Room not found' });

        const existingPlayer = Array.from(room.players.values()).find(p => p.username.toLowerCase() === username.toLowerCase());
        if (existingPlayer) return socket.emit('error', { msg: 'That username is already taken in this room' });

        const color = generateColor();
        const player = {
            id: socket.id,
            username,
            color,
            x: 400 + Math.random() * 100 - 50,
            y: 300 + Math.random() * 100 - 50,
            hat: null,
            pet: null,
            sitting: false,
            sittingAt: null
        };

        room.players.set(socket.id, player);
        socketToRoom.set(socket.id, upperCode);
        socket.join(upperCode);

        const allPlayers = Array.from(room.players.values());
        socket.emit('room_joined', { code: upperCode, player, players: allPlayers, musicState: room.musicState });
        socket.to(upperCode).emit('player_joined', { player });
    });

    // Movement & sit
    socket.on('move', ({ x, y }) => {
        const roomCode = socketToRoom.get(socket.id);
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(socket.id);
        if (!player) return;

        player.x = Math.max(20, Math.min(1180, x));
        player.y = Math.max(20, Math.min(680, y));
        player.sitting = false;
        player.sittingAt = null;
        socket.to(roomCode).emit('player_moved', { id: socket.id, x: player.x, y: player.y, sitting: false });
    });

    socket.on('sit', ({ spotId, x, y }) => {
        const roomCode = socketToRoom.get(socket.id);
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(socket.id);
        if (!player) return;

        player.sitting = true;
        player.sittingAt = spotId;
        player.x = x;
        player.y = y;
        socket.to(roomCode).emit('player_moved', { id: socket.id, x, y, sitting: true, sittingAt: spotId });
        socket.emit('player_moved', { id: socket.id, x, y, sitting: true, sittingAt: spotId });
    });

    // Chat
    socket.on('chat', ({ message }) => {
        const roomCode = socketToRoom.get(socket.id);
        if (!roomCode) return;
        const player = rooms.get(roomCode)?.players.get(socket.id);
        if (!player) return;
        const trimmed = message?.trim().slice(0, 120);
        if (!trimmed) return;
        io.to(roomCode).emit('chat_message', {
            id: socket.id,
            username: player.username,
            message: trimmed,
            timestamp: Date.now(),
            system: false
        });
    });

    // Emote & Equip
    socket.on('emote', ({ emote }) => {
        const roomCode = socketToRoom.get(socket.id);
        if (!roomCode) return;
        const player = rooms.get(roomCode)?.players.get(socket.id);
        if (!player) return;
        io.to(roomCode).emit('player_emote', { id: socket.id, emote });
    });

    socket.on('equip', ({ hat, pet }) => {
        const roomCode = socketToRoom.get(socket.id);
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(socket.id);
        if (!player) return;
        if (hat !== undefined) player.hat = hat;
        if (pet !== undefined) player.pet = pet;
        io.to(roomCode).emit('player_equipped', { id: socket.id, hat: player.hat, pet: player.pet });
    });

    // Leave room
    socket.on('leave_room', () => handleLeave(socket));

    socket.on('disconnect', () => {
        handleLeave(socket);
        const username = socketToUser.get(socket.id);
        if (username) {
            usernames.delete(username.toLowerCase());
            usernameToSocket.delete(username.toLowerCase());
            socketToUser.delete(socket.id);
        }
    });

    function handleLeave(socket) {
        const roomCode = socketToRoom.get(socket.id);
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        if (room) {
            const player = room.players.get(socket.id);
            room.players.delete(socket.id);
            socket.to(roomCode).emit('player_left', { id: socket.id });
            cleanupRoom(roomCode);
        }
        socket.leave(roomCode);
        socketToRoom.delete(socket.id);
        socket.emit('left_room');
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌧️ Hangout server running on http://localhost:${PORT}`));