// seed.js — Initialisation de la base de données
// ══════════════════════════════════════════════════════════════════════
//  Enregistre les kits IoT en base.
//  Usage : node seed.js
// ══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const mongoose = require('mongoose');
const Kit      = require('./models/Kit');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/shiftterdb';

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB connecté\n');

  const kits = [
    { kit_id: 'SAHRA001', description: 'Kit ESP32 + SIM808 — MPU6050 + DHT22 + GPS' },
  ];

  for (const k of kits) {
    const exists = await Kit.findOne({ kit_id: k.kit_id });
    if (exists) {
      console.log(`⚠️  Kit ${k.kit_id} existe déjà (status: ${exists.status})`);
    } else {
      await Kit.create({ ...k, status: 'free' });
      console.log(`✅ Kit créé : ${k.kit_id}`);
    }
  }

  console.log('\n🎉 Seed terminé !');
  console.log('   → Démarrer le serveur : npm start\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('❌ Seed error:', err.message);
  process.exit(1);
});
