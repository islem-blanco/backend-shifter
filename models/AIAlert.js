// models/AIAlert.js
const mongoose = require('mongoose');

const aiAlertSchema = new mongoose.Schema(
  {
    kit_id: { type: String, required: true, uppercase: true },
    colis_id: { type: String, default: null, set: v => v ? v.toUpperCase() : null },
    event: { type: String, required: true },
    shock_detected: { type: Boolean, default: false },
    shock_severity: { type: String, default: 'none' },
    temperature_status: { type: String, default: 'OK' },
    gps_status: { type: String, default: 'OK' },
    confidence: { type: Number, default: 0 },
    reason: { type: String },
    alert_level: { type: String, default: 'none' },
    lstm_probability:  { type: Number, default: null },
    lstm_window_size:  { type: Number, default: 20 },
    lstm_sensor_snapshot: {
      ax: Number, ay: Number, az: Number,
      temperature: Number, humidity: Number, magnitude: Number,
    },
    receivedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
  }
);

module.exports = mongoose.model('AIAlert', aiAlertSchema);
