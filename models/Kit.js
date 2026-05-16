// models/Kit.js
// ══════════════════════════════════════════════════════
//  Représente un kit IoT physique (ESP32 + capteurs)
//  status: 'free' | 'occupied'
// ══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const kitSchema = new mongoose.Schema(
  {
    kit_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      // ex: KIT_01, KIT_02 …
    },
    status: {
      type: String,
      enum: ['free', 'occupied'],
      default: 'free',
    },
    colis_id: {
      type: String,
      default: null,
    },
    lastSeen: {
      type: Date,
      default: null,
    },
    description: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Kit', kitSchema);
