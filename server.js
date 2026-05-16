// server.js — Shiftter IoT Backend
// ══════════════════════════════════════════════════════════════════════
//  Point d'entrée principal.
//  Ordre de démarrage :
//    1. Express + middleware
//    2. Socket.io
//    3. MongoDB
//    4. Routes REST
//    5. MQTT Bridge (injecte io + publieur dans les services)
//    6. 🆕 LSTM Predictor (injecte Socket.io)
// ══════════════════════════════════════════════════════════════════════

require('dotenv').config();

// ── Protection anti-crash ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const mongoose   = require('mongoose');
const path       = require('path'); // 🆕
const { Server } = require('socket.io');

const { startMqttBridge } = require('./mqtt-bridge');
const { startAiBridge }   = require('./ai-bridge');

// 🆕 Import du LSTM Predictor
const lstmPredictor = require('./lstm/lstm-predictor');

// ── Routes ────────────────────────────────────────────────────────────
const kitRoutes    = require('./routes/kit.routes');
const sensorRoutes = require('./routes/sensor.routes');

// ─────────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);


// ── Socket.io ─────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));

// 🆕 Servir les fichiers statiques du dossier public (dashboard LSTM)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Rendre io accessible dans tous les controllers via req.app.get('io')
app.set('io', io);

// 🆕 ══════════════════════════════════════════════════════════════════════
//  INJECTER SOCKET.IO DANS LE LSTM PREDICTOR
// ══════════════════════════════════════════════════════════════════════
lstmPredictor.setSocketIO(io);
console.log('✅ Socket.io injecté dans LSTM Predictor');

// ── Socket.io : événements de connexion ──────────────────────────────
io.on('connection', async (socket) => {
  console.log(`📲 Dashboard connecté : ${socket.id}`);

  // ── Envoyer l'état actuel de tous les kits dès connexion ──────────
  // Ainsi le dashboard n'a pas besoin d'attendre un événement MQTT
  try {
    const Kit = require('./models/Kit');
    const kits = await Kit.find().lean();
    kits.forEach(k => {
      socket.emit('kit_status_update', {
        kit_id:  k.kit_id,
        status:  k.status,
        lastSeen: k.lastSeen,
      });
    });
    console.log(`📤 État kits envoyé à ${socket.id} (${kits.length} kit(s))`);
  } catch (e) {
    console.warn('⚠️  Impossible d\'envoyer l\'état initial des kits:', e.message);
  }

  socket.on('disconnect', () => {
    console.log(`📲 Dashboard déconnecté : ${socket.id}`);
  });
});

// ── Routes REST ───────────────────────────────────────────────────────
app.use('/api/kits',    kitRoutes);
app.use('/api/sensors', sensorRoutes);

// 🆕 ══════════════════════════════════════════════════════════════════════
//  ROUTE POUR LE DASHBOARD LSTM
// ══════════════════════════════════════════════════════════════════════
app.get('/lstm-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lstm-dashboard.html'));
});

// ── Health check ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'Shiftter IoT Backend',
    version: '1.0.0',
    time:    new Date().toISOString(),
    dashboards: {
      main: `http://localhost:${PORT}/`,
      lstm: `http://localhost:${PORT}/lstm-dashboard`, // 🆕
    }
  });
});

// ── 404 ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route introuvable : ${req.method} ${req.path}` });
});

// ── Gestionnaire d'erreurs global ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Erreur globale :', err.message);
  res.status(500).json({ success: false, message: 'Erreur serveur interne' });
});

// ─────────────────────────────────────────────────────────────────────
//  Démarrage
// ─────────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT      || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/shiftterdb';

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connecté :', MONGO_URI);

    httpServer.listen(PORT, () => {
      console.log('═══════════════════════════════════════════════════════');
      console.log(`🚀 Serveur Shiftter démarré sur le port ${PORT}`);
      console.log('═══════════════════════════════════════════════════════');
      console.log(`📡 Socket.io actif`);
      console.log(`🧠 LSTM Predictor connecté`);
      console.log(`📊 Dashboard LSTM : http://localhost:${PORT}/lstm-dashboard`); // 🆕
      console.log(`🏠 API principale  : http://localhost:${PORT}/`);
      console.log('═══════════════════════════════════════════════════════');
      
      startMqttBridge(io);
      startAiBridge();
    });

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} déjà utilisé !`);
        console.error(`   → Exécute : Stop-Process -Name node -Force`);
        console.error(`   → Puis relance : npm start\n`);
      } else {
        console.error('❌ Erreur serveur:', err.message);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB erreur de connexion :', err.message);
    process.exit(1);
  });