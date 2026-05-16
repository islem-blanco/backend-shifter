// routes/sensor.routes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/sensor.controller');
const lstmService = require('../lstm/lstm-service');
const lstmPredictor = require('../lstm/lstm-predictor');

// Routes existantes
router.get('/colis/:colis_id',      ctrl.getByColis);
router.get('/kit/:kit_id/latest',   ctrl.getLatestByKit);
router.get('/stats/:colis_id',      ctrl.getStats);
router.get('/ai-alerts/:colis_id',  ctrl.getAIAlerts);

// Routes LSTM existantes
router.get('/lstm/status', (_req, res) => {
  res.json(lstmService.getStatus());
});

router.post('/lstm/train', async (req, res) => {
  try {
    const result = await lstmService.triggerTraining(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// NOUVELLES ROUTES POUR LA VISUALISATION
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/sensors/lstm/metrics - Récupérer toutes les métriques
router.get('/lstm/metrics', (_req, res) => {
  try {
    const metrics = lstmPredictor.getMetrics();
    res.json({
      success: true,
      data: metrics,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('[Routes LSTM] Erreur metrics:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// GET /api/sensors/lstm/anomalies - Liste des anomalies récentes
router.get('/lstm/anomalies', (_req, res) => {
  try {
    const metrics = lstmPredictor.getMetrics();
    res.json({
      success: true,
      data: metrics.recentAnomalies,
      count: metrics.anomalyCount,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('[Routes LSTM] Erreur anomalies:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// POST /api/sensors/lstm/reset-metrics - Réinitialiser les métriques
router.post('/lstm/reset-metrics', (_req, res) => {
  try {
    lstmPredictor.resetMetrics();
    res.json({
      success: true,
      message: 'Métriques réinitialisées avec succès',
      timestamp: new Date()
    });
  } catch (err) {
    console.error('[Routes LSTM] Erreur reset:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// GET /api/sensors/lstm/buffer-status - État des buffers par device
router.get('/lstm/buffer-status', (_req, res) => {
  try {
    const status = lstmPredictor.getBufferStatus();
    res.json({
      success: true,
      data: status,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('[Routes LSTM] Erreur buffer-status:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// GET /api/sensors/lstm/export-csv - Export CSV des prédictions
router.get('/lstm/export-csv', (_req, res) => {
  try {
    const metrics = lstmPredictor.getMetrics();
    
    // Générer le CSV
    let csv = 'timestamp,deviceId,score,threshold,isAnomaly,latency,temperature,humidity\n';
    
    metrics.recentPredictions.forEach(p => {
      const temp = p.rawData?.temperature || 'N/A';
      const hum = p.rawData?.humidity || 'N/A';
      csv += `${p.timestamp},${p.deviceId},${p.score},${p.threshold},${p.isAnomaly},${p.latency},${temp},${hum}\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=lstm_predictions_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('[Routes LSTM] Erreur export-csv:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

module.exports = router;