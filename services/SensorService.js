// services/SensorService.js
// ══════════════════════════════════════════════════════════════════════
//  Stockage des données capteurs + détection d'anomalies.
//  Le colis_id vient directement du payload Arduino (package_id).
// ══════════════════════════════════════════════════════════════════════

const SensorData = require('../models/SensorData');
const AIAlert = require('../models/AIAlert');

// Seuils d'anomalie
const TEMP_MAX  = 40;   // °C
const TEMP_MIN  = 0;    // °C
const SHOCK_MAG = 3.0;  // g

let _io = null;

class SensorService {
  init(ioInstance) {
    _io = ioInstance;
  }

  async saveAIAlert(data) {
    const kit_id = (data.device || data.kit_id || 'SAHRA001').toUpperCase();
    const colis_id = data.package_id || null;

    const alert = await AIAlert.create({
      kit_id,
      colis_id,
      event: data.event,
      shock_detected: data.shock_detected,
      shock_severity: data.shock_severity,
      temperature_status: data.temperature_status,
      gps_status: data.gps_status,
      confidence: data.confidence,
      reason: data.reason,
      alert_level: data.alert_level,
      receivedAt: new Date(),
    });

    if (_io) {
      _io.emit('ai_alert', alert.toObject());
      
      // If it's a high level alert, also emit to sensor_alert for backward compatibility
      if (data.alert_level === 'high' || data.alert_level === 'medium') {
         _io.emit('sensor_alert', { 
           kit_id, 
           colis_id, 
           alerts: [{ type: 'AI_DETECTION', reason: data.reason, severity: data.alert_level }] 
         });
      }
    }

    return alert;
  }

  // ════════════════════════════════════════════════════════════════
  //  saveReading(data)
  //  data: { kit_id, colis_id?, temperature?, humidity?,
  //          lat?, lon?, vitesse?, ville?, magnitude?, shock_duration? }
  // ════════════════════════════════════════════════════════════════
  async saveReading(data) {
    const kit_id   = (data.kit_id   || '').toUpperCase();
    const colis_id = (data.colis_id || null);

    if (!kit_id) throw new Error('kit_id manquant');

    const shockDuration = data.shock_duration != null
      ? parseInt(data.shock_duration)
      : data.duration_ms != null ? parseInt(data.duration_ms) : 0;
    const isShock = Boolean(data.shock) || shockDuration > 0;

    const reading = await SensorData.create({
      kit_id,
      colis_id,
      temperature: data.temperature != null ? parseFloat(data.temperature) : null,
      humidity:    data.humidity    != null ? parseFloat(data.humidity)    : null,
      lat:         data.lat         != null ? parseFloat(data.lat)         : null,
      lon:         data.lon         != null ? parseFloat(data.lon)         : null,
      vitesse:     data.vitesse     != null ? parseFloat(data.vitesse)     : null,
      ville:       data.ville       || null,
      shock:       isShock,
      magnitude:   data.magnitude   != null ? parseFloat(data.magnitude)   : null,
      receivedAt:  new Date(),
    });

    // ── Socket.io → dashboard / collègue ─────────────────────────
    if (_io) {
      _io.emit('sensor_data', reading.toObject());
    }

    // ── Détection anomalies ───────────────────────────────────────
    this._detectAnomalies(reading);

    return reading;
  }

  // ── Anomalies ──────────────────────────────────────────────────
  _detectAnomalies(reading) {
    if (!_io) return;
    const alerts = [];

    if (reading.temperature != null) {
      if (reading.temperature > TEMP_MAX)
        alerts.push({ type: 'TEMP_HIGH', value: reading.temperature, threshold: TEMP_MAX });
      if (reading.temperature < TEMP_MIN)
        alerts.push({ type: 'TEMP_LOW',  value: reading.temperature, threshold: TEMP_MIN });
    }

    if (reading.shock && reading.magnitude != null && reading.magnitude > SHOCK_MAG) {
      alerts.push({ type: 'SHOCK', value: reading.magnitude, threshold: SHOCK_MAG });
    }

    if (alerts.length > 0) {
      _io.emit('sensor_alert', { kit_id: reading.kit_id, colis_id: reading.colis_id, alerts });
      console.warn(`🚨 ANOMALIE [${reading.kit_id}]`, alerts);
    }
  }

  async getByColis(colis_id, limit = 100) {
    return SensorData.find({ colis_id }).sort({ receivedAt: -1 }).limit(limit);
  }

  async getLatestByKit(kit_id) {
    return SensorData.findOne({ kit_id: kit_id.toUpperCase() }).sort({ receivedAt: -1 });
  }

  async getStats(colis_id) {
    const stats = await SensorData.aggregate([
      { $match: { colis_id, temperature: { $ne: null } } },
      { $group: {
        _id:     '$colis_id',
        tempMin: { $min: '$temperature' },
        tempMax: { $max: '$temperature' },
        tempAvg: { $avg: '$temperature' },
        humAvg:  { $avg: '$humidity' },
        count:   { $sum: 1 },
      }},
    ]);
    return stats[0] || null;
  }

  async getAIAlerts(colis_id, limit = 50) {
    return AIAlert.find({ colis_id }).sort({ receivedAt: -1 }).limit(limit);
  }
}

module.exports = new SensorService();
