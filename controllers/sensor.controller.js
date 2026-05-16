// controllers/sensor.controller.js
// ══════════════════════════════════════════════════════════════════════
//  Endpoints REST pour consulter les données capteurs
//  (lecture seule — l'écriture passe par MQTT uniquement)
// ══════════════════════════════════════════════════════════════════════

const SensorService = require('../services/SensorService');

// GET /api/sensors/colis/:colis_id
// Retourne les N dernières lectures d'un colis
// Query: ?limit=100
async function getByColis(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const data  = await SensorService.getByColis(req.params.colis_id, limit);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

// GET /api/sensors/kit/:kit_id/latest
// Dernière lecture d'un kit (utile pour affichage dashboard)
async function getLatestByKit(req, res) {
  try {
    const data = await SensorService.getLatestByKit(req.params.kit_id);
    if (!data)
      return res.status(404).json({ success: false, message: 'Aucune donnée disponible' });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

// GET /api/sensors/stats/:colis_id
// Statistiques agrégées (temp min/max/avg, humidité avg)
async function getStats(req, res) {
  try {
    const stats = await SensorService.getStats(req.params.colis_id);
    if (!stats)
      return res.status(404).json({ success: false, message: 'Aucune donnée pour ce colis' });
    res.json({ success: true, data: stats });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

async function getAIAlerts(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const data  = await SensorService.getAIAlerts(req.params.colis_id, limit);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

module.exports = { getByColis, getLatestByKit, getStats, getAIAlerts };
