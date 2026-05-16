// mqtt-bridge.js — Shiftter IoT Backend
// ══════════════════════════════════════════════════════════════════════
//  Rôle unique : pont entre le kit IoT et le reste du système.
//
//  UPLINK (kit → backend) :
//    sahra/dht      → { temperature, humidity, package_id }
//    sahra/gps      → { lat, lon, vitesse, ville, package_id }
//    sahra/sensor   → { magnitude, duration_ms, package_id }
//    sahra/status   → { device, event, package_id }
//
//  Ce que ce fichier fait :
//    1. Reçoit les données du kit
//    2. Sauvegarde en MongoDB (SensorData)
//    3. Émet via Socket.io vers quiconque écoute (collègue, dashboard…)
//    4. Met à jour le statut du kit (free/occupied)
//
//  Ce qu'il ne fait PAS :
//    ❌ Gérer les colis (c'est la collègue)
//    ❌ Gérer les associations (c'est la collègue)
//    ❌ Envoyer des commandes (la collègue publie directement sur sahra/commande)
// ══════════════════════════════════════════════════════════════════════

const mqtt = require('mqtt');
const KitService = require('./services/KitService');
const SensorService = require('./services/SensorService');

const BROKER = process.env.MQTT_BROKER || 'mqtt://broker.hivemq.com:1883';

const TOPIC_DHT = 'sahra/dht';
const TOPIC_GPS = 'sahra/gps';
const TOPIC_SENSOR = 'sahra/sensor';
const TOPIC_STATUS = 'sahra/status';
const TOPIC_AI = 'sahra/ai';
const TOPIC_CMD = 'sahra/commande';

const lstmService = require('./lstm/lstm-service');

let mqttClient = null;

// ─────────────────────────────────────────────────────────────────────
//  startMqttBridge(io)
// ─────────────────────────────────────────────────────────────────────

async function startMqttBridge(io) {
  SensorService.init(io);
  await lstmService.init();
  mqttClient = mqtt.connect(BROKER, {
    clientId: `shiftter_bridge_${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 30000,
  });

  mqttClient.on('connect', () => {
    console.log(`✅ MQTT Bridge connecté → ${BROKER}`);
    [TOPIC_DHT, TOPIC_GPS, TOPIC_SENSOR, TOPIC_STATUS, TOPIC_AI, TOPIC_CMD].forEach((topic) => {
      mqttClient.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.error(`❌ Subscribe [${topic}]:`, err.message);
        else console.log(`📡 Souscrit: ${topic}`);
      });
    });
  });

  mqttClient.on('message', async (topic, message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      console.warn(`⚠️  MQTT parse error [${topic}]:`, e.message);
      return;
    }

    // 🚀 ENRICHISSEMENT AUTO : Si package_id manque, on le cherche en base
    async function getRealPackageId(incomingData) {
      let pkg = incomingData.package_id || incomingData.colis_id;
      if (!pkg || pkg === "" || pkg === "non_assigné") {
        const kit_id = (incomingData.device || incomingData.kit_id || 'SAHRA001').toUpperCase();
        const info = await KitService.getById(kit_id);
        if (info && info.status === 'occupied') return info.colis_id;
      }
      return pkg;
    }

    try {
      const final_package_id = await getRealPackageId(data);

      // ── DHT22 : température + humidité ─────────────────────
      if (topic === TOPIC_DHT) {
        const reading = {
          kit_id: 'SAHRA001',
          colis_id: final_package_id,
          temperature: data.temperature,
          humidity: data.humidity,
        };
        await SensorService.saveReading(reading);
        console.log(`🌡️  DHT T=${data.temperature}°C H=${data.humidity}% colis=${final_package_id || 'none'}`);
 io.emit('dht_update', {
          device     : data.device || 'sahra001',
          temperature: data.temperature,
          humidity   : data.humidity,
          package_id : final_package_id,
          timestamp  : Date.now(),
        });
      }
      // ── GPS ────────────────────────────────────────────────
      else if (topic === TOPIC_GPS) {
          const reading = {
            kit_id: 'SAHRA001',
            colis_id: final_package_id,
            lat: parseFloat(data.lat),
            lon: parseFloat(data.lon),
            vitesse: parseFloat(data.vitesse || 0),
            ville: data.ville || null,
          };
          await SensorService.saveReading(reading);
          io.emit('gps_update', {
            device     : data.device || 'sahra001',
            lat        : data.lat,
            lon        : data.lon,
            vitesse    : data.vitesse,
            ville      : data.ville,
            package_id : final_package_id,
            timestamp  : Date.now(),
          });
          console.log(`📍 GPS lat=${data.lat} lon=${data.lon} ville=${data.ville || '?'}`);
          
        }

        // ── MPU6050 : choc / vibration ─────────────────────────
else if (topic === TOPIC_SENSOR) {
  // ✅ Sauvegarder TOUTES les données (pas juste magnitude)
  const reading = {
    kit_id: 'SAHRA001',
    colis_id: final_package_id,
    magnitude: data.magnitude,
    shock_duration: data.duration_ms || data.shock_duration || 0,
    
    // ✅ AJOUT : Axes bruts pour le LSTM
    ax: data.ax || data.x || null,
    ay: data.ay || data.y || null,
    az: data.az || data.z || null,
    
    // ✅ AJOUT : Contexte environnemental
    temperature: data.temperature || null,
    humidity: data.humidity || null,
    ville: data.ville || null,
  };
  
  console.log('💾 [DEBUG] Sauvegarde capteur:', reading);
  await SensorService.saveReading(reading);

  // Analyse LSTM (utilise les mêmes données)
  const lstmResult = await lstmService.analyze(
    data.device || 'SAHRA001', 
    reading,  // ✅ Utiliser 'reading' au lieu de créer un nouvel objet
    io
  );

  // Groq s'active SEULEMENT si LSTM détecte une anomalie
  if (lstmResult?.is_anomaly) {
    console.log(`[MQTT Bridge] 🚨 LSTM prob: ${lstmResult.probability} → Groq activé`);
    io.emit('lstm_anomaly', {
      device     : data.device || 'sahra001',
      package_id : final_package_id,
      probability: lstmResult.probability,
      timestamp  : Date.now(),
    })
    mqttClient.publish('sahra/ai', JSON.stringify({
      ...data,
      type: 'motion_anomaly',
      lstm_probability: lstmResult.probability,
      package_id: final_package_id,
      event: 'LSTM_ANOMALY',
    }), { qos: 1 });
  } else if (lstmResult && !lstmResult.is_anomaly) {
    console.log(`[MQTT Bridge] ✅ LSTM prob: ${lstmResult.probability} → Groq silencieux`);
  }

  console.log(`📳 MPU: mag=${data.magnitude}g dur=${data.duration_ms || 0}ms`);
}
        // ── Statut kit (LIFECYCLE) ──────────────────────────────
        else if (topic === TOPIC_STATUS) {
          const event = data.event || '';
          const kit_id = 'SAHRA001';

          // Si c'est juste un battement de coeur, on met à jour la présence sans changer le statut
        if (event === 'heartbeat') {
  await KitService.heartbeat(kit_id);
  return;
}

          console.log(`📬 STATUS [Hardware]: event=${event} device=${data.device}`);

          if (event === 'assigned') {
            await KitService.markOccupied(kit_id, data.package_id || null);
            io.emit('kit_status_update', { kit_id, status: 'occupied', colis_id: data.package_id || null });
            console.log(`🔗 Kit ${kit_id} occupé → colis ${data.package_id || '?'}`);
          }

          if (event === 'delivered' || event === 'free') {
  await KitService.markFree(kit_id);
  if (event === 'delivered') {
    lstmService.handleDeviceReset(data.device || 'SAHRA001');
  }
  io.emit('kit_status_update', { kit_id, status: 'free' });
}
        }

        // ── Décisions IA (ANALYTICS) ───────────────────────────
        else if (topic === TOPIC_AI) {
          const eventName = data.event || data.type || 'ANOMALY';
          if (eventName === 'LSTM_ANOMALY') return;

          console.log(`🤖 AI DECISION/ALERT: ${eventName} for package ${data.package_id || '?'}`);

          // On normalise pour SensorService
          await SensorService.saveAIAlert({
            ...data,
            event: eventName
          });
        }

        // ── Synchronisation des Commandes (DASHBOARD COLLÈGUE) ──
        else if (topic === TOPIC_CMD) {
          const { cmd, package_id, kit_id } = data;
          const target_kit = (kit_id || 'SAHRA001').toUpperCase();

          if (cmd === 'assign') {
            await KitService.markOccupied(target_kit, package_id);
            io.emit('kit_status_update', { kit_id: target_kit, status: 'occupied', colis_id: package_id });
            console.log(`📡 [Sync] Commande assignation détectée pour ${target_kit}`);
          }
          else if (cmd === 'deliver' || cmd === 'reset') {
            await KitService.markFree(target_kit);
            io.emit('kit_status_update', { kit_id: target_kit, status: 'free' });
            console.log(`📡 [Sync] Commande libération détectée pour ${target_kit}`);
          }
        }

      } catch (e) {
        console.error(`❌ Handler [${topic}]:`, e.message);
      }
    });

  mqttClient.on('error', (err) => console.error('❌ MQTT:', err.message));
  mqttClient.on('reconnect', () => console.log('🔄 MQTT reconnexion…'));
  mqttClient.on('offline', () => console.warn('📵 MQTT hors ligne'));
  mqttClient.on('close', () => console.warn('🔌 MQTT connexion fermée'));

  // ── Heartbeat : Annonce le kit toutes les 30s ───────────────────────
  setInterval(() => {
    if (mqttClient && mqttClient.connected) {
      const heartbeat = {
  device: 'sahra001',
  event: 'heartbeat',   // ← ne touche plus au buffer
  timestamp: Date.now()
};
      mqttClient.publish(TOPIC_STATUS, JSON.stringify(heartbeat), { qos: 1 });
      console.log(' Serveur envoie son signal de présence...');
    }
  }, 30000);

  return mqttClient;
}

/**
 * Envoie une commande au kit via MQTT
 * @param {string} kit_id 
 * @param {string} cmd 'assign' | 'deliver' | 'reset'
 * @param {string} package_id 
 */
function sendCommand(kit_id, cmd, package_id = '') {
  if (!mqttClient || !mqttClient.connected) {
    console.error('❌ MQTT non connecté, impossible d\'envoyer la commande');
    return false;
  }

  const payload = {
    kit_id: kit_id.toLowerCase(),
    cmd: cmd,
    package_id: package_id
  };

  mqttClient.publish('sahra/commande', JSON.stringify(payload), { qos: 0 });
  console.log(`📤 Commande envoyée [${cmd}] pour le kit ${kit_id} (colis: ${package_id})`);
  return true;
}

module.exports = { startMqttBridge, sendCommand };
