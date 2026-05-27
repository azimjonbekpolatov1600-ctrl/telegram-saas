/**
 * db.js — Simple JSON file database
 * All data lives in /data/ folder, separated by owner.
 *
 * Structure:
 *   data/
 *     owners.json          — all registered store owners
 *     stores/{ownerId}/
 *       products.json      — that owner's products
 *       orders.json        — that owner's orders
 *       config.json        — that owner's store settings
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, 'data');
const OWNERS_FILE = path.join(DATA_DIR, 'owners.json');
const STORES_DIR  = path.join(DATA_DIR, 'stores');

// Ensure base dirs exist
[DATA_DIR, STORES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── GENERIC HELPERS ───────────────────────────────────────
function readJSON(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── OWNER STORE DIR ───────────────────────────────────────
function ownerDir(ownerId) {
  const dir = path.join(STORES_DIR, ownerId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── OWNERS ────────────────────────────────────────────────
const owners = {
  getAll() {
    return readJSON(OWNERS_FILE, []);
  },
  getById(id) {
    return this.getAll().find(o => o.id === id) || null;
  },
  getByEmail(email) {
    return this.getAll().find(o => o.email.toLowerCase() === email.toLowerCase()) || null;
  },
  save(owner) {
    const all = this.getAll();
    const idx = all.findIndex(o => o.id === owner.id);
    if (idx === -1) all.push(owner);
    else all[idx] = owner;
    writeJSON(OWNERS_FILE, all);
    return owner;
  },
  delete(id) {
    const all = this.getAll().filter(o => o.id !== id);
    writeJSON(OWNERS_FILE, all);
  },
};

// ─── PRODUCTS (per owner) ──────────────────────────────────
function productsFile(ownerId) {
  return path.join(ownerDir(ownerId), 'products.json');
}

const products = {
  getAll(ownerId) {
    return readJSON(productsFile(ownerId), []);
  },
  save(ownerId, list) {
    writeJSON(productsFile(ownerId), list);
  },
  add(ownerId, product) {
    const list = this.getAll(ownerId);
    const maxId = list.length > 0 ? Math.max(...list.map(p => parseInt(p.id) || 0)) : 0;
    product.id = String(maxId + 1);
    list.push(product);
    this.save(ownerId, list);
    return product;
  },
  update(ownerId, id, fields) {
    const list = this.getAll(ownerId);
    const idx  = list.findIndex(p => p.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...fields };
    if (fields.price !== undefined) list[idx].price = Number(fields.price);
    this.save(ownerId, list);
    return list[idx];
  },
  delete(ownerId, id) {
    const list = this.getAll(ownerId).filter(p => p.id !== id);
    this.save(ownerId, list);
  },
};

// ─── ORDERS (per owner) ────────────────────────────────────
function ordersFile(ownerId) {
  return path.join(ownerDir(ownerId), 'orders.json');
}

const orders = {
  getAll(ownerId) {
    return readJSON(ordersFile(ownerId), []);
  },
  save(ownerId, list) {
    writeJSON(ordersFile(ownerId), list);
  },
  add(ownerId, order) {
    const list  = this.getAll(ownerId);
    const maxId = list.length > 0 ? Math.max(...list.map(o => parseInt(o.id) || 0)) : 0;
    order.id    = String(maxId + 1).padStart(3, '0');
    order.createdAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    list.push(order);
    this.save(ownerId, list);
    return order;
  },
  updateStatus(ownerId, orderId, status) {
    const list = this.getAll(ownerId);
    const idx  = list.findIndex(o => o.id === orderId);
    if (idx === -1) return null;
    list[idx].status    = status;
    list[idx].updatedAt = new Date().toISOString();
    this.save(ownerId, list);
    return list[idx];
  },
};

// ─── STORE CONFIG (per owner) ──────────────────────────────
function configFile(ownerId) {
  return path.join(ownerDir(ownerId), 'config.json');
}

const storeConfig = {
  get(ownerId) {
    return readJSON(configFile(ownerId), {
      storeName:    'My Telegram Shop',
      currency:     'сум',
      botToken:     '',
      ownerChatId:  '',
    });
  },
  save(ownerId, config) {
    const existing = this.get(ownerId);
    const updated  = { ...existing, ...config };
    writeJSON(configFile(ownerId), updated);
    return updated;
  },
};

module.exports = { owners, products, orders, storeConfig };
