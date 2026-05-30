/**
 * db.js — MongoDB database (replaces JSON files)
 * Data persists across Render restarts and deployments.
 *
 * Collections:
 *   owners       — store owner accounts
 *   products     — products per owner
 *   orders       — orders per owner
 *   storeconfigs — bot token, store name, currency per owner
 */

const { MongoClient } = require('mongodb');

// REPLACE: your MongoDB connection string
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://admin:YxEsTNLHhmrDSwqN@telegram-saas.18phgui.mongodb.net/?appName=Telegram-SaaS';
const DB_NAME   = 'telegramstore';

let _client = null;
let _db     = null;

async function getDb() {
  if (_db) return _db;
  if (!_client) {
    _client = new MongoClient(MONGO_URI);
    await _client.connect();
    console.log('✅ Connected to MongoDB Atlas');
  }
  _db = _client.db(DB_NAME);
  return _db;
}

// ─── OWNERS ────────────────────────────────────────────────
const owners = {
  async getAll() {
    const db = await getDb();
    return db.collection('owners').find({}).toArray();
  },
  async getById(id) {
    const db = await getDb();
    return db.collection('owners').findOne({ id });
  },
  async getByEmail(email) {
    const db = await getDb();
    return db.collection('owners').findOne({ email: email.toLowerCase() });
  },
  async save(owner) {
    const db = await getDb();
    await db.collection('owners').updateOne(
      { id: owner.id },
      { $set: owner },
      { upsert: true }
    );
    return owner;
  },
  async delete(id) {
    const db = await getDb();
    await db.collection('owners').deleteOne({ id });
  },
};

// ─── PRODUCTS (per owner) ──────────────────────────────────
const products = {
  async getAll(ownerId) {
    const db = await getDb();
    return db.collection('products').find({ ownerId }).toArray();
  },
  async add(ownerId, product) {
    const db   = await getDb();
    const all  = await this.getAll(ownerId);
    const maxId = all.length > 0 ? Math.max(...all.map(p => parseInt(p.id) || 0)) : 0;
    product.id      = String(maxId + 1);
    product.ownerId = ownerId;
    await db.collection('products').insertOne(product);
    return product;
  },
  async update(ownerId, id, fields) {
    const db = await getDb();
    if (fields.price !== undefined) fields.price = Number(fields.price);
    await db.collection('products').updateOne(
      { ownerId, id },
      { $set: fields }
    );
    return db.collection('products').findOne({ ownerId, id });
  },
  async delete(ownerId, id) {
    const db = await getDb();
    await db.collection('products').deleteOne({ ownerId, id });
  },
};

// ─── ORDERS (per owner) ────────────────────────────────────
const orders = {
  async getAll(ownerId) {
    const db = await getDb();
    return db.collection('orders').find({ ownerId }).sort({ createdAt: -1 }).toArray();
  },
  async add(ownerId, order) {
    const db  = await getDb();
    const all = await this.getAll(ownerId);
    const maxId = all.length > 0 ? Math.max(...all.map(o => parseInt(o.id) || 0)) : 0;
    order.id        = String(maxId + 1).padStart(3, '0');
    order.ownerId   = ownerId;
    order.createdAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    await db.collection('orders').insertOne(order);
    return order;
  },
  async updateStatus(ownerId, orderId, status) {
    const db = await getDb();
    await db.collection('orders').updateOne(
      { ownerId, id: orderId },
      { $set: { status, updatedAt: new Date().toISOString() } }
    );
    return db.collection('orders').findOne({ ownerId, id: orderId });
  },
};

// ─── STORE CONFIG (per owner) ──────────────────────────────
const storeConfig = {
  async get(ownerId) {
    const db  = await getDb();
    const cfg = await db.collection('storeconfigs').findOne({ ownerId });
    return cfg || {
      storeName:   'My Telegram Shop',
      currency:    'сум',
      botToken:    '',
      ownerChatId: '',
    };
  },
  async save(ownerId, config) {
    const db       = await getDb();
    const existing = await this.get(ownerId);
    const updated  = { ...existing, ...config, ownerId };
    await db.collection('storeconfigs').updateOne(
      { ownerId },
      { $set: updated },
      { upsert: true }
    );
    return updated;
  },
};

module.exports = { owners, products, orders, storeConfig, getDb };
