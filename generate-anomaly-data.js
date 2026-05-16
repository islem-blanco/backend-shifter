/**
 * generate-anomaly-data.js
 * Génère des données réalistes de choc et de normal
 * pour entraîner le LSTM sans faire tomber le kit physiquement.
 *
 * Usage :
 *   node generate-anomaly-data.js
 */

'use strict';
require('dotenv').config();

const mongoose = require('mongoose');
const SensorData = require('./models/SensorData');
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => {
    console.error('❌ MongoDB erreur:', err.message);
    process.exit(1);
  });
const mqtt   = require('mqtt');
const client = mqtt.connect('mqtt://broker.hivemq.com:1883');

// ── Config ─────────────────────────────────────────────────
const DEVICE     = 'sahra001';
const PACKAGE_ID = 'COLIS001';
const TOPIC      = 'sahra/sensor';

// ── Générateur de nombre aléatoire ─────────────────────────
function rand(min, max) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(4));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Données NORMALES — kit posé sur une table ───────────────
function normalData() {
  return {
    device     : DEVICE,
    package_id : PACKAGE_ID,
    ax         : rand(-0.1, 0.1),
    ay         : rand(-0.1, 0.1),
    az         : rand(0.95, 1.05),   // gravité ~1g sur l'axe Z
    magnitude  : rand(0.95, 1.05),
    duration_ms: 0,
    temperature: rand(22, 26),
    humidity   : rand(55, 70),
    ville      : 'Sfax, Tunisie',
    is_anomaly : false,
  };
}

// ── Données CHOC — kit secoué / tombé ───────────────────────
function shockData(intensity = 'medium') {
  const profiles = {
    light : { ax: rand(0.5, 1.0),  ay: rand(0.5, 1.0),  az: rand(1.5, 2.0), dur: rand(100, 300)  },
    medium: { ax: rand(1.0, 2.0),  ay: rand(1.0, 2.0),  az: rand(2.0, 3.0), dur: rand(300, 800)  },
    hard  : { ax: rand(2.0, 3.5),  ay: rand(2.0, 3.5),  az: rand(3.0, 4.5), dur: rand(800, 2000) },
  };
  const p   = profiles[intensity];
  const mag = Math.sqrt(p.ax**2 + p.ay**2 + p.az**2);
  return {
    device     : DEVICE,
    package_id : PACKAGE_ID,
    ax         : p.ax,
    ay         : p.ay,
    az         : p.az,
    magnitude  : parseFloat(mag.toFixed(4)),
    duration_ms: p.dur,
    temperature: rand(22, 26),
    humidity   : rand(55, 70),
    ville      : 'Sfax, Tunisie',
    is_anomaly : true,
  };
}

// ── Publication MQTT ────────────────────────────────────────
async function publish(data) {
  // Keep MQTT for real-time display
  client.publish(TOPIC, JSON.stringify(data), { qos: 1 });

  // Save directly to MongoDB with all values guaranteed
  try {
    const saved = await SensorData.create({
      kit_id        : data.device,
      colis_id      : data.package_id,
      temperature   : data.temperature,   // ✅ real value
      humidity      : data.humidity,       // ✅ real value
      ville         : data.ville,
      shock         : data.is_anomaly,
      magnitude     : data.magnitude,
      shock_duration: data.duration_ms,
      ax            : data.ax,             // ✅ real value
      ay            : data.ay,             // ✅ real value
      az            : data.az,             // ✅ real value
      receivedAt    : new Date(),
    });
    console.log(`✅ Mongo saved: shock=${saved.shock} ax=${saved.ax}`);
  } catch (err) {
    console.error('❌ Erreur:', err.message);
  }
}
// ── Scénarios ───────────────────────────────────────────────

// Scénario 1 : 40 mesures normales (fenêtre complète)
async function scenarioNormal(count = 40) {
  console.log(`\n📦 Scénario NORMAL — ${count} mesures...`);
  for (let i = 0; i < count; i++) {
    await publish(normalData());
    process.stdout.write(`  ✅ normal ${i + 1}/${count}\r`);
    await sleep(300);
  }
  console.log(`\n✅ Scénario normal terminé`);
}

// Scénario 2 : choc isolé précédé de normales
async function scenarioShock(intensity = 'medium', shockCount = 5) {
  console.log(`\n💥 Scénario CHOC (${intensity}) — 15 normales + ${shockCount} chocs...`);

  // 15 mesures normales avant le choc
  for (let i = 0; i < 15; i++) {
    await publish(normalData());
    process.stdout.write(`  ✅ normal ${i + 1}/15\r`);
    await sleep(300);
  }

  // Chocs
  for (let i = 0; i < shockCount; i++) {
await publish(shockData(intensity));
    console.log(`\n  💥 choc ${intensity} ${i + 1}/${shockCount} envoyé`);
    await sleep(300);
  }

  // 5 mesures normales après
  for (let i = 0; i < 5; i++) {
await publish(normalData());
    await sleep(300);
  }

  console.log(`✅ Scénario choc terminé`);
}

// Scénario 3 : simulation complète pour entraînement LSTM
async function scenarioTraining() {
  console.log('\n🏋️  GÉNÉRATION DONNÉES ENTRAÎNEMENT LSTM');
  console.log('═══════════════════════════════════════');

  // 100 normales
  await scenarioNormal(100);
  await sleep(1000);

  // 10 chocs légers
  // Change shock counts to be bigger clusters
for (let i = 0; i < 3; i++) {
  await scenarioShock('light', 10);  // was 3
  await sleep(500);
}
for (let i = 0; i < 3; i++) {
  await scenarioShock('medium', 15); // was 5
  await sleep(500);
}
for (let i = 0; i < 2; i++) {
  await scenarioShock('hard', 20);   // was 8
  await sleep(500);
}
  // 50 normales finales
  await scenarioNormal(50);

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  ✅ Génération terminée !             ║');
  console.log('║  Lance maintenant :                  ║');
  console.log('║  node lstm/lstm-trainer.js           ║');
  console.log('╚══════════════════════════════════════╝\n');
}

// ── Point d'entrée ──────────────────────────────────────────
client.on('connect', async () => {
  console.log('✅ Connecté à HiveMQ');

  const arg = process.argv[2] || 'training';

  if (arg === 'normal')   await scenarioNormal(40);
  if (arg === 'shock')    await scenarioShock('medium', 10);
  if (arg === 'hard')     await scenarioShock('hard', 10);
  if (arg === 'training') await scenarioTraining();
await sleep(5000);

console.log("⏳ Fermeture propre...");

await mongoose.connection.close();

client.end();

console.log("✅ Fin programme");
  
});

client.on('error', err => {
  console.error('❌ MQTT erreur:', err.message);
  process.exit(1);
});

