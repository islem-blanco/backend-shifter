// controllers/kit.controller.js
// ══════════════════════════════════════════════════════════════════════
//  Thin controller — délègue toute la logique à KitService
// ══════════════════════════════════════════════════════════════════════

const KitService = require('../services/KitService');
const { sendCommand } = require('../mqtt-bridge');

// GET /api/kits
async function getAll(req, res) {
  try {
    const kits = await KitService.getAll();
    res.json({ success: true, data: kits });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

// GET /api/kits/free
async function getFree(req, res) {
  try {
    const kits = await KitService.getFree();
    res.json({ success: true, data: kits });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

// GET /api/kits/:kit_id
async function getOne(req, res) {
  try {
    const kit = await KitService.getById(req.params.kit_id);
    res.json({ success: true, data: kit });
  } catch (e) {
    res.status(404).json({ success: false, message: e.message });
  }
}

// POST /api/kits
// Body: { kit_id, description? }
async function create(req, res) {
  try {
    const { kit_id, description } = req.body;
    if (!kit_id)
      return res.status(400).json({ success: false, message: 'kit_id est obligatoire' });

    const kit = await KitService.create(kit_id, description);
    // Notifier le dashboard en temps réel
    req.app.get('io').emit('kit_added', kit);
    res.status(201).json({ success: true, data: kit });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
}

// DELETE /api/kits/:kit_id
async function remove(req, res) {
  try {
    const result = await KitService.delete(req.params.kit_id);
    req.app.get('io').emit('kit_removed', { kit_id: req.params.kit_id.toUpperCase() });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
}

// POST /api/kits/:kit_id/assign
// Body: { package_id }
async function assign(req, res) {
  try {
    const { kit_id } = req.params;
    const { package_id } = req.body;

    if (!package_id) 
      return res.status(400).json({ success: false, message: 'package_id est obligatoire' });

    // 1. Envoyer la commande MQTT
    const ok = sendCommand(kit_id, 'assign', package_id);
    if (!ok) throw new Error('Échec de l\'envoi de la commande MQTT');

    res.json({ success: true, message: `Commande d'assignation envoyée au kit ${kit_id}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

// POST /api/kits/:kit_id/deliver
async function deliver(req, res) {
  try {
    const { kit_id } = req.params;

    // 1. Envoyer la commande MQTT
    const ok = sendCommand(kit_id, 'deliver');
    if (!ok) throw new Error('Échec de l\'envoi de la commande MQTT');

    res.json({ success: true, message: `Commande de livraison envoyée au kit ${kit_id}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

module.exports = { getAll, getFree, getOne, create, remove, assign, deliver };
