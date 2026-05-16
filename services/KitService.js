// services/KitService.js
// ══════════════════════════════════════════════════════════════════════
//  SOURCE DE VÉRITÉ pour l'état des kits.
//  RÈGLE : seul le backend décide si un kit est free ou occupied.
//  Le kit IoT envoie des données — il ne décide PAS de son état.
// ══════════════════════════════════════════════════════════════════════

const Kit = require('../models/Kit');

class KitService {
  // ── Créer un kit (enregistrement initial) ──────────────────────────
  async create(kit_id, description = '') {
    const existing = await Kit.findOne({ kit_id: kit_id.toUpperCase() });
    if (existing) throw new Error(`Kit ${kit_id} existe déjà`);
    return Kit.create({ kit_id: kit_id.toUpperCase(), status: 'free', description });
  }

  // ── Récupérer tous les kits ────────────────────────────────────────
  async getAll() {
    return Kit.find().sort({ kit_id: 1 });
  }

  // ── Récupérer uniquement les kits libres ───────────────────────────
  async getFree() {
    return Kit.find({ status: 'free' }).sort({ kit_id: 1 });
  }

  // ── Récupérer un kit par ID ────────────────────────────────────────
  async getById(kit_id) {
    const kit = await Kit.findOne({ kit_id: kit_id.toUpperCase() });
    if (!kit) throw new Error(`Kit ${kit_id} introuvable`);
    return kit;
  }

  // ── Vérifier si un kit est libre ──────────────────────────────────
  async isAvailable(kit_id) {
    const kit = await this.getById(kit_id);
    return kit.status === 'free';
  }

  // ── Marquer un kit comme occupé (appelé par AssociationService) ───
  async markOccupied(kit_id, colis_id = null) {
    const kit = await Kit.findOneAndUpdate(
      { kit_id: kit_id.toUpperCase() },
      { $set: { status: 'occupied', colis_id: colis_id, lastSeen: new Date() } },
      { new: true }
    );
    if (!kit) throw new Error(`Kit ${kit_id} introuvable`);
    return kit;
  }

  // ── Marquer un kit comme libre (appelé après livraison) ───────────
  async markFree(kit_id) {
    const kit = await Kit.findOneAndUpdate(
      { kit_id: kit_id.toUpperCase() },
      { $set: { status: 'free', colis_id: null, lastSeen: new Date() } },
      { new: true }
    );
    if (!kit) throw new Error(`Kit ${kit_id} introuvable`);
    return kit;
  }

  // ── Mise à jour lastSeen (heartbeat depuis MQTT) ──────────────────
  async heartbeat(kit_id) {
    await Kit.updateOne(
      { kit_id: kit_id.toUpperCase() },
      { $set: { lastSeen: new Date() } }
    );
  }

  // ── Supprimer un kit ──────────────────────────────────────────────
  async delete(kit_id) {
    const kit = await Kit.findOne({ kit_id: kit_id.toUpperCase() });
    if (!kit) throw new Error(`Kit ${kit_id} introuvable`);
    if (kit.status === 'occupied')
      throw new Error(`Kit ${kit_id} est occupé — libérez-le d'abord`);
    await Kit.deleteOne({ kit_id: kit_id.toUpperCase() });
    return { deleted: true };
  }
}

module.exports = new KitService();
