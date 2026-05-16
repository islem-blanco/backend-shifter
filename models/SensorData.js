// models/SensorData.js
// ══════════════════════════════════════════════════════
//  Données capteurs reçues depuis le kit IoT
//  Stockées avec le colis_id associé au moment de la réception
// ══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const sensorDataSchema = new mongoose.Schema(
  {
    kit_id: { type: String, required: true, uppercase: true },
    colis_id: { type: String, default: null, set: v => v ? v.toUpperCase() : null },

    // DHT22
    temperature: { type: Number, default: null },
    humidity: { type: Number, default: null },

    // GPS (SIM808 / NEO-6M)
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    vitesse: { type: Number, default: null },
    ville: { type: String, default: null },

    // MPU6050 — choc / chute
    shock: { type: Boolean, default: false },
    magnitude: { type: Number, default: null },
    shock_duration: { type: Number, default: null }, // ✅ AJOUTÉ

    // ✅ AJOUT : Axes bruts pour le LSTM
    ax: { type: Number, default: null },
    ay: { type: Number, default: null },
    az: { type: Number, default: null },

    // Batterie (optionnel)
    battery: { type: Number, default: null },

    receivedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
  }
);

module.exports = mongoose.model('SensorData', sensorDataSchema);
