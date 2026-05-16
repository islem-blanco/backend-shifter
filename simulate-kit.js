// simulate-kit.js
// ══════════════════════════════════════════════════════════════════════
//  Simule le kit Arduino SAHRA001 pour tester le backend
//  sans avoir besoin du kit physique.
//
//  Usage : node simulate-kit.js
// ══════════════════════════════════════════════════════════════════════

const mqtt = require('mqtt');

const BROKER    = 'mqtt://broker.hivemq.com:1883';
const COLIS_ID  = 'COLIS_001';
const DEVICE_ID = 'sahra001';

let packageId    = '';   // sera mis à jour via sahra/commande
let kitActif     = false;
let intervalDHT, intervalSensor, intervalGPS;

const client = mqtt.connect(BROKER, {
  clientId: `sim_sahra001_${Date.now()}`,
  clean:    true,
});

client.on('connect', () => {
  console.log('✅ Simulateur connecté à HiveMQ');
  console.log('📡 En attente de commande assign sur sahra/commande…\n');

  // Souscrire aux commandes backend → kit
  client.subscribe('sahra/commande', { qos: 1 }, (err) => {
    if (!err) console.log('📡 Souscrit: sahra/commande');
  });

  // Publier statut initial : kit libre
  publishStatus('free', '');

  // Démarrer les publications périodiques
  startPublishing();
});

// ── Réception des commandes du backend ─────────────────────────────
client.on('message', (topic, message) => {
  if (topic !== 'sahra/commande') return;

  let cmd;
  try { cmd = JSON.parse(message.toString()); } catch { return; }

  console.log(`\n📥 COMMANDE REÇUE: ${JSON.stringify(cmd)}`);

  if (cmd.cmd === 'assign' && cmd.package_id) {
    packageId = cmd.package_id;
    kitActif  = true;
    console.log(`╔══════════════════════════════════════╗`);
    console.log(`║  KIT ASSIGNÉ → colis: ${packageId.padEnd(15)} ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
    publishStatus('assigned', packageId);
  }

  if (cmd.cmd === 'deliver') {
    console.log(`╔══════════════════════════════════════╗`);
    console.log(`║  LIVRAISON CONFIRMÉE → ${packageId.padEnd(13)} ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
    publishStatus('delivered', packageId);
    packageId = '';
    kitActif  = false;
    setTimeout(() => publishStatus('free', ''), 1000);
  }

  if (cmd.cmd === 'reset') {
    packageId = '';
    kitActif  = false;
    publishStatus('free', '');
  }
});

// ── Publications périodiques ────────────────────────────────────────
function startPublishing() {
  // DHT22 toutes les 15 secondes
  intervalDHT = setInterval(() => {
    const temp = (22 + Math.random() * 3).toFixed(1);
    const hum  = (60 + Math.random() * 20).toFixed(1);
    const payload = JSON.stringify({
      temperature: parseFloat(temp),
      humidity:    parseFloat(hum),
      timestamp:   Date.now(),
      package_id:  packageId,
    });
    client.publish('sahra/dht', payload);
    console.log(`🌡️  DHT publié: T=${temp}°C H=${hum}% colis=${packageId || 'none'}`);
  }, 15000);

  // MPU6050 toutes les 3 secondes
  intervalSensor = setInterval(() => {
    const mag  = (0.98 + Math.random() * 0.05).toFixed(3);
    const delta = (Math.random() * 0.02).toFixed(3);
    const payload = JSON.stringify({
      ax:              (Math.random() * 0.1).toFixed(3),
      ay:              (Math.random() * 0.1).toFixed(3),
      az:              (0.95 + Math.random() * 0.05).toFixed(3),
      magnitude:       parseFloat(mag),
      delta_magnitude: parseFloat(delta),
      duration_ms:     0,
      package_id:      packageId,
    });
    client.publish('sahra/sensor', payload);
  }, 3000);

  // GPS toutes les 10 secondes
  intervalGPS = setInterval(() => {
    const lat   = (36.8 + Math.random() * 0.02).toFixed(6);
    const lon   = (10.15 + Math.random() * 0.02).toFixed(6);
    const payload = JSON.stringify({
      lat:       parseFloat(lat),
      lat_dir:   'N',
      lon:       parseFloat(lon),
      lon_dir:   'E',
      vitesse:   (Math.random() * 60).toFixed(1),
      date:      new Date().toLocaleDateString('fr-FR'),
      heure_utc: new Date().toUTCString().slice(17, 25),
      ville:     'Tunis',
      package_id: packageId,
    });
    client.publish('sahra/gps', payload);
    console.log(`📍 GPS publié: lat=${lat} lon=${lon} colis=${packageId || 'none'}`);
  }, 10000);

  console.log('🔄 Publications démarrées (DHT/15s, Sensor/3s, GPS/10s)\n');
}

// ── Publication statut ──────────────────────────────────────────────
function publishStatus(event, pkg) {
  const payload = JSON.stringify({
    device:     DEVICE_ID,
    event,
    package_id: pkg,
    timestamp:  Date.now(),
  });
  client.publish('sahra/status', payload);
  console.log(`📤 sahra/status: event=${event} colis=${pkg || 'none'}`);
}

client.on('error',     (e)  => console.error('❌ MQTT error:', e.message));
client.on('reconnect', ()   => console.log('🔄 Reconnexion…'));
client.on('offline',   ()   => console.warn('📵 Hors ligne'));

console.log('🚀 Simulateur kit SAHRA001 démarré');
console.log('   Ctrl+C pour arrêter\n');
