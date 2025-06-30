const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = 3000;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

const players = new Map();
const rooms = new Map();

const questionsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
    res.json({
        players: players.size,
        rooms: rooms.size,
        status: 'En ligne',
        timestamp: new Date().toISOString()
    });
});

function createRoom() {
    const roomId = Math.random().toString(36).substring(2, 15);
    rooms.set(roomId, {
        id: roomId,
        players: new Map(),
        status: 'waiting',
        createdAt: new Date().toISOString(),
        maxPlayers: 4,
        gameState: {
            isPlaying: false,
            currentQuestion: 0,
            questions: [],
            scores: new Map(),
            answers: new Map(),
            questionStartTime: null,
            questionDuration: 30000
        }
    });
    return roomId;
}

function getAvailableRooms() {
    return Array.from(rooms.values()).map(room => ({
        id: room.id,
        playerCount: room.players.size,
        maxPlayers: room.maxPlayers,
        status: room.status
    }));
}

function getOnlinePlayers() {
    return Array.from(players.values()).map(player => ({
        id: player.id,
        pseudo: player.pseudo
    }));
}

function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const shuffledQuestions = [...questionsData.questions].sort(() => Math.random() - 0.5);
    room.gameState.questions = shuffledQuestions.slice(0, 5);
    room.gameState.isPlaying = true;
    room.gameState.currentQuestion = 0;
    room.gameState.scores.clear();
    room.gameState.answers.clear();
    
    room.players.forEach((player, playerId) => {
        room.gameState.scores.set(playerId, 0);
    });
    
    room.status = 'playing';
    
    sendQuestionToRoom(roomId);
}

function sendQuestionToRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.gameState.isPlaying) return;
    
    const currentQ = room.gameState.questions[room.gameState.currentQuestion];
    if (!currentQ) {
        endGame(roomId);
        return;
    }
    
    room.gameState.questionStartTime = Date.now();
    room.gameState.answers.clear();
    
    const questionData = {
        question: currentQ.question,
        options: currentQ.options,
        questionNumber: room.gameState.currentQuestion + 1,
        totalQuestions: room.gameState.questions.length,
        timeLimit: room.gameState.questionDuration
    };
    
    io.to(roomId).emit('gameStarted', {
        question: questionData,
        players: Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo }))
    });
    
    setTimeout(() => {
        if (room.gameState.currentQuestion === room.gameState.questions.indexOf(currentQ)) {
            showQuestionResults(roomId);
        }
    }, room.gameState.questionDuration);
}

function showQuestionResults(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.gameState.isPlaying) return;
    
    const currentQ = room.gameState.questions[room.gameState.currentQuestion];
    const correctAnswer = currentQ.answer;
    
    room.gameState.answers.forEach((answer, playerId) => {
        if (answer === correctAnswer) {
            const currentScore = room.gameState.scores.get(playerId) || 0;
            room.gameState.scores.set(playerId, currentScore + 10);
        }
    });
    
    const results = {
        correctAnswer: correctAnswer,
        scores: Array.from(room.gameState.scores.entries()).map(([playerId, score]) => {
            const player = room.players.get(playerId);
            return {
                pseudo: player.pseudo,
                score: score,
                answered: room.gameState.answers.has(playerId),
                correct: room.gameState.answers.get(playerId) === correctAnswer
            };
        })
    };
    
    io.to(roomId).emit('questionResults', results);
    
    setTimeout(() => {
        room.gameState.currentQuestion++;
        if (room.gameState.currentQuestion < room.gameState.questions.length) {
            sendQuestionToRoom(roomId);
        } else {
            endGame(roomId);
        }
    }, 3000);
}

function endGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.gameState.isPlaying = false;
    room.status = 'waiting';
    
    const finalScores = Array.from(room.gameState.scores.entries())
        .map(([playerId, score]) => {
            const player = room.players.get(playerId);
            return {
                pseudo: player.pseudo,
                score: score
            };
        })
        .sort((a, b) => b.score - a.score);
    
    io.to(roomId).emit('gameEnded', {
        finalScores: finalScores,
        winner: finalScores[0]
    });
}

io.on('connection', (socket) => {
    console.log('Nouvelle connexion : ', socket.id);

    socket.on('joinGame', (data) => {
        const { pseudo } = data;
        
        const player = {
            id: socket.id,
            pseudo: pseudo,
            roomId: null,
            joinedAt: new Date().toISOString()
        };
        
        players.set(socket.id, player);
        
        socket.emit('playerJoined', {
            pseudo: pseudo,
            availableRooms: getAvailableRooms()
        });
        
        io.emit('playersUpdate', {
            players: getOnlinePlayers()
        });
        
        io.emit('roomsUpdate', {
            rooms: getAvailableRooms()
        });
    });

    socket.on('createRoom', () => {
        const player = players.get(socket.id);
        if (!player) {
            socket.emit('error', { message: 'Joueur non trouvé' });
            return;
        }
        
        const roomId = createRoom();
        const room = rooms.get(roomId);
        
        room.players.set(socket.id, player);
        player.roomId = roomId;
        
        socket.join(roomId);
        
        socket.emit('roomCreated', { 
            roomId: roomId,
            playerCount: room.players.size,
            players: Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo }))
        });
        
        io.emit('roomsUpdate', {
            rooms: getAvailableRooms()
        });
    });

    socket.on('joinRoom', (data) => {
        const { roomId } = data;
        const player = players.get(socket.id);
        const room = rooms.get(roomId);
        
        if (!player) {
            socket.emit('error', { message: 'Joueur non trouvé' });
            return;
        }
        
        if (!room) {
            socket.emit('error', { message: 'Salle non trouvée' });
            return;
        }
        
        if (room.players.size >= room.maxPlayers) {
            socket.emit('error', { message: 'Salle pleine' });
            return;
        }
        
        room.players.set(socket.id, player);
        player.roomId = roomId;
        
        socket.join(roomId);
        
        socket.emit('roomJoined', {
            roomId: roomId,
            playerCount: room.players.size,
            players: Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo }))
        });
        
        socket.to(roomId).emit('playerJoinedRoom', {
            player: { pseudo: player.pseudo },
            playerCount: room.players.size
        });
        
        io.emit('roomsUpdate', {
            rooms: getAvailableRooms()
        });
    });

    socket.on('leaveRoom', (data) => {
        const { roomId } = data;
        const player = players.get(socket.id);
        const room = rooms.get(roomId);
        
        if (player && room) {
            room.players.delete(socket.id);
            player.roomId = null;
            
            socket.leave(roomId);
            
            socket.to(roomId).emit('playerLeft', {
                remainingPlayers: Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo })),
                playerCount: room.players.size
            });
            
            if (room.players.size === 0) {
                rooms.delete(roomId);
            }
            
            io.emit('roomsUpdate', {
                rooms: getAvailableRooms()
            });
        }
    });

    socket.on('startGame', (data) => {
        const { roomId } = data;
        const player = players.get(socket.id);
        const room = rooms.get(roomId);
        
        if (!player || !room) {
            socket.emit('error', { message: 'Erreur lors du démarrage du jeu' });
            return;
        }
        
        if (room.players.size < 2) {
            socket.emit('error', { message: 'Il faut au moins 2 joueurs pour démarrer' });
            return;
        }
        
        startGame(roomId);
    });

    socket.on('submitAnswer', (data) => {
        const { answer } = data;
        const player = players.get(socket.id);
        
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || !room.gameState.isPlaying) return;
        
        if (room.gameState.answers.has(socket.id)) return;
        
        room.gameState.answers.set(socket.id, answer);
        
        socket.to(player.roomId).emit('playerAnswered', {
            player: { pseudo: player.pseudo }
        });
    });

    socket.on('ping', () => {
        console.log('Ping reçu de : ', socket.id);
        socket.emit('pong', { message: 'Pong', timestamp: Date.now() });
    });

    socket.on('disconnect', () => {
        console.log('Déconnexion : ', socket.id);
        
        const player = players.get(socket.id);
        if (player && player.roomId) {
            const room = rooms.get(player.roomId);
            if (room) {
                room.players.delete(socket.id);
                
                socket.to(player.roomId).emit('playerLeft', {
                    remainingPlayers: Array.from(room.players.values()).map(p => ({ pseudo: p.pseudo })),
                    playerCount: room.players.size
                });
                
                if (room.players.size === 0) {
                    rooms.delete(player.roomId);
                }
            }
        }
        
        players.delete(socket.id);
        
        io.emit('roomsUpdate', {
            rooms: getAvailableRooms()
        });
        
        io.emit('playersUpdate', {
            players: getOnlinePlayers()
        });
    });
});

server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});

process.on('uncaughtException', (error) => {
    console.error('Erreur non gérée : ', error);
});

process.on('unhandledRejection', (error, promise) => {
    console.error('Erreur promise non gérée : ', error);
    console.error('Promise : ', promise);
});