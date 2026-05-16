// ai-bridge.js — AI Analyzer Service for Shiftter
// ══════════════════════════════════════════════════════════════════════
// Ce service écoute les données capteurs et utilise l'IA pour détecter
// des anomalies complexes (chocs, température, comportement GPS).
// ══════════════════════════════════════════════════════════════════════

const mqtt = require('mqtt');
const { analyzeWithAI } = require('./ai-analyzer');
const KitService = require('./services/KitService');

function startAiBridge() {
  const AI_TOPICS = new Set([
    process.env.MQTT_TOPIC_SENSOR || 'sahra/sensor',
    process.env.MQTT_TOPIC_DHT    || 'sahra/dht',
    process.env.MQTT_TOPIC_GPS    || 'sahra/gps',
    process.env.MQTT_TOPIC_DROP   || 'sahra/chute',
  ]);

  const baseId = process.env.MQTT_CLIENT_ID || 'sahra-ai-bridge';
  const uniqueClientId = `${baseId}-${Math.random().toString(16).slice(2, 6)}`;

  const client = mqtt.connect(process.env.MQTT_BROKER, {
    clientId:        uniqueClientId,
    clean:           true,
    keepalive:       60,
    connectTimeout:  10000,
    reconnectPeriod: 5000,
  });

  const history = {
    sensor:   [],
    dht:      [],
    gps:      [],
    chute:    [],
    decision: [],
  };

  let geminiQueue = Promise.resolve();

  function addToHistory(type, data) {
    history[type].push(data);
    if (history[type].length > 10) history[type].shift();
  }

  client.on('connect', () => {
    console.log('🤖 AI Bridge connecté au broker MQTT');
    AI_TOPICS.forEach(t => {
      client.subscribe(t, { qos: 0 }, (err) => {
        if (err) console.error(`❌ AI Subscription error ${t}:`, err);
      });
    });
  });

  client.on('message', async (topic, message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      return;
    }

    // Mise à jour historique
    if (topic.includes('sensor')) {
      addToHistory('sensor', { ...data, timestamp: Date.now() });
    } else if (topic.includes('dht')) {
      addToHistory('dht', { ...data, timestamp: Date.now() });
    } else if (topic.includes('gps')) {
      addToHistory('gps', { ...data, timestamp: Date.now() });
    } else if (topic.includes('chute') || topic.includes('drop')) {
      addToHistory('chute', { ...data, timestamp: Date.now() });
    }

    if (!AI_TOPICS.has(topic)) return;

    // Capture des données pour la queue
    const topicSnapshot = topic;
    
    // 🚀 ENRICHISSEMENT : Si l'Arduino ne connaît pas son package_id, on le cherche en base
    if (!data.package_id || data.package_id === "" || data.package_id === "non_assigné") {
      try {
        const current_kit = (data.device || data.kit_id || 'SAHRA001').toUpperCase();
        const kitInfo = await KitService.getById(current_kit);
        if (kitInfo && kitInfo.status === 'occupied' && kitInfo.colis_id) {
          data.package_id = kitInfo.colis_id;
        }
      } catch (err) {
        // Silencieux
      }
    }

    const dataSnapshot  = JSON.parse(JSON.stringify(data));

    geminiQueue = geminiQueue.then(async () => {
      try {
        const decision = await analyzeWithAI(topicSnapshot, dataSnapshot, history);

        // Publier la décision sur sahra/ai (dédié à l'IA)
        client.publish(
          process.env.MQTT_TOPIC_AI || 'sahra/ai',
          JSON.stringify(decision),
          { qos: 0, retain: false }
        );
        
        addToHistory('decision', decision);
        console.log(`🤖 AI Decision [${decision.event}] for package ${decision.package_id}`);
      } catch (err) {
        console.error('❌ AI Analysis error:', err.message);
      }
    });
  });

  client.on('error', (err) => console.error('❌ AI Bridge Error:', err.message));

  return client;
}

module.exports = { startAiBridge };
