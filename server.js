const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

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

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log('Nouvelle connexion : ', socket.id);

    socket.on('ping', () => {
        console.log('Ping reçu de : ', socket.id);
        socket.emit('pong', { message: 'Pong', timestamp: Date.now() });
    });

    socket.on('disconnect', () => {
        console.log('Déconnexion : ', socket.id);
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