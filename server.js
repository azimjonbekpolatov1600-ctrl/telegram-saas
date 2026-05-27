/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        TELEGRAM STORE SAAS — BACKEND SERVER v2.0            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * SETUP:
 * 1. npm install
 * 2. Set env vars (or edit CONFIG below):
 *      JWT_SECRET=some-long-random-string
 *      SUPER_ADMIN_EMAIL=you@email.com
 *      SUPER_ADMIN_PASSWORD=YourStrongPass123
 * 3. node server.js
 *
 * DEPLOY ON RENDER:
 * - Build: npm install  |  Start: node server.js
 * - Add env vars in Render dashboard
 */

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const db       = require('./db');

const app = express();

// ─── CONFIG ────────────────────────────────────────────────
const CONFIG = {
  PORT:         process.env.PORT || 3000,
  // REPLACE: Long random string for JWT signing
  JWT_SECRET:   process.env.JWT_SECRET || 'replace-this-with-a-long-random-secret-string',
  JWT_EXPIRES:  '30d',
  // REPLACE: Your super admin credentials (you — the SaaS owner)
  SUPER_ADMIN_EMAIL:    process.env.SUPER_ADMIN_EMAIL    || 'admin@yourstore.com',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin2025!',
};

// ─── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));  // serves store.html, dashboard.html etc.

app.use((req, res, next) => {
  const now = new Date().toLocaleTimeString('ru-RU');
  console.log(`[${now}] ${req.method} ${req.path}`);
  next();
});

// ─── AUTH MIDDLEWARE ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, CONFIG.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function superAdminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  });
}

// Middleware that attaches ownerId from token OR from URL param (for store.html)
function ownerMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    // Super admin can act on behalf of any owner via ?ownerId=
    if (req.user.role === 'superadmin' && req.query.ownerId) {
      req.ownerId = req.query.ownerId;
    } else {
      req.ownerId = req.user.id;
    }
    next();
  });
}

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * POST /auth/register
 * Register a new store owner account
 */
app.post('/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password and name are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (db.owners.getByEmail(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const hashed = await bcrypt.hash(password, 10);
  const owner  = {
    id:        uuidv4(),
    email:     email.toLowerCase().trim(),
    password:  hashed,
    name:      name.trim(),
    role:      'owner',
    active:    true,   // set false to deactivate a store
    plan:      'trial', // trial | active | suspended
    createdAt: new Date().toISOString(),
  };
  db.owners.save(owner);

  // Seed with sample products so they see a working store immediately
  seedSampleProducts(owner.id);

  const token = jwt.sign(
    { id: owner.id, email: owner.email, role: 'owner' },
    CONFIG.JWT_SECRET,
    { expiresIn: CONFIG.JWT_EXPIRES }
  );

  console.log(`✅ New owner registered: ${email}`);
  res.status(201).json({
    token,
    owner: sanitizeOwner(owner),
  });
});

/**
 * POST /auth/login
 * Login — works for both owners and super admin
 */
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  // Check super admin first
  if (
    email.toLowerCase() === CONFIG.SUPER_ADMIN_EMAIL.toLowerCase() &&
    password === CONFIG.SUPER_ADMIN_PASSWORD
  ) {
    const token = jwt.sign(
      { id: 'superadmin', email: CONFIG.SUPER_ADMIN_EMAIL, role: 'superadmin' },
      CONFIG.JWT_SECRET,
      { expiresIn: CONFIG.JWT_EXPIRES }
    );
    return res.json({ token, owner: { id: 'superadmin', name: 'Super Admin', role: 'superadmin' } });
  }

  const owner = db.owners.getByEmail(email);
  if (!owner) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, owner.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  if (!owner.active) {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact support.' });
  }

  const token = jwt.sign(
    { id: owner.id, email: owner.email, role: 'owner' },
    CONFIG.JWT_SECRET,
    { expiresIn: CONFIG.JWT_EXPIRES }
  );
  res.json({ token, owner: sanitizeOwner(owner) });
});

/**
 * GET /auth/me
 * Get current user info
 */
app.get('/auth/me', authMiddleware, (req, res) => {
  if (req.user.role === 'superadmin') {
    return res.json({ id: 'superadmin', name: 'Super Admin', role: 'superadmin' });
  }
  const owner = db.owners.getById(req.user.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  res.json(sanitizeOwner(owner));
});

// ═══════════════════════════════════════════════════════════
// PUBLIC STORE ROUTES (accessed by Mini App customers)
// These use ownerId in URL so each store has its own endpoint
// ═══════════════════════════════════════════════════════════

/**
 * GET /store/:ownerId/products
 * Public — get all products for a specific store
 */
app.get('/store/:ownerId/products', (req, res) => {
  const owner = db.owners.getById(req.params.ownerId);
  if (!owner || !owner.active) {
    return res.status(404).json({ error: 'Store not found' });
  }
  res.json(db.products.getAll(req.params.ownerId));
});

/**
 * GET /store/:ownerId/config
 * Public — get store display config (name, currency)
 */
app.get('/store/:ownerId/config', (req, res) => {
  const owner = db.owners.getById(req.params.ownerId);
  if (!owner || !owner.active) {
    return res.status(404).json({ error: 'Store not found' });
  }
  const cfg = db.storeConfig.get(req.params.ownerId);
  // Only return public fields — never expose botToken or keys
  res.json({
    storeName:  cfg.storeName  || owner.name + "'s Shop",
    currency:   cfg.currency   || 'сум',
    ownerId:    req.params.ownerId,
  });
});

/**
 * POST /store/:ownerId/orders
 * Public — place an order in a specific store
 */
app.post('/store/:ownerId/orders', async (req, res) => {
  const ownerId = req.params.ownerId;
  const owner   = db.owners.getById(ownerId);
  if (!owner || !owner.active) {
    return res.status(404).json({ error: 'Store not found' });
  }

  const { items, customer } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }
  if (!customer?.id) {
    return res.status(400).json({ error: 'customer.id required' });
  }

  const storeProducts = db.products.getAll(ownerId);
  const resolvedItems = [];

  for (const item of items) {
    const product = storeProducts.find(p => p.id === String(item.productId));
    if (!product) return res.status(400).json({ error: `Product ${item.productId} not found` });
    if (!product.available) return res.status(400).json({ error: `"${product.name}" is out of stock` });
    resolvedItems.push({
      productId: product.id,
      name:      product.name,
      price:     product.price,
      quantity:  item.quantity || 1,
      image:     product.image,
    });
  }

  const total    = resolvedItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const newOrder = db.orders.add(ownerId, {
    items:    resolvedItems,
    total,
    customer,
    status:   'new',
  });

  // Notify this owner's bot
  const cfg = db.storeConfig.get(ownerId);
  if (cfg.botToken && cfg.ownerChatId) {
    notifyOwner(cfg.botToken, cfg.ownerChatId, newOrder, ownerId).catch(console.error);
  }

  console.log(`📦 Order #${newOrder.id} placed in store ${ownerId}`);
  res.status(201).json({ success: true, orderId: newOrder.id, order: newOrder });
});

// ═══════════════════════════════════════════════════════════
// OWNER DASHBOARD ROUTES (authenticated)
// ═══════════════════════════════════════════════════════════

/** GET /api/products — owner's products */
app.get('/api/products', ownerMiddleware, (req, res) => {
  res.json(db.products.getAll(req.ownerId));
});

/** POST /api/products — add product */
app.post('/api/products', ownerMiddleware, (req, res) => {
  const { name, price, category, description, image, available } = req.body;
  if (!name || !price || !category) {
    return res.status(400).json({ error: 'name, price, category required' });
  }
  const product = db.products.add(req.ownerId, {
    name, price: Number(price), category,
    description: description || '',
    image: image || `https://placehold.co/400x400/cccccc/333?text=${encodeURIComponent(name)}`,
    available: available !== false,
  });
  res.status(201).json({ success: true, product });
});

/** PUT /api/products/:id — edit product */
app.put('/api/products/:id', ownerMiddleware, (req, res) => {
  const product = db.products.update(req.ownerId, req.params.id, req.body);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true, product });
});

/** DELETE /api/products/:id */
app.delete('/api/products/:id', ownerMiddleware, (req, res) => {
  db.products.delete(req.ownerId, req.params.id);
  res.json({ success: true });
});

/** PATCH /api/products/:id/toggle */
app.patch('/api/products/:id/toggle', ownerMiddleware, (req, res) => {
  const all = db.products.getAll(req.ownerId);
  const p   = all.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const updated = db.products.update(req.ownerId, req.params.id, { available: !p.available });
  res.json({ success: true, available: updated.available });
});

/** GET /api/orders — owner's orders */
app.get('/api/orders', ownerMiddleware, (req, res) => {
  let list = db.orders.getAll(req.ownerId).reverse();
  if (req.query.status) list = list.filter(o => o.status === req.query.status);
  res.json(list);
});

/** PATCH /api/orders/:id/status */
app.patch('/api/orders/:id/status', ownerMiddleware, async (req, res) => {
  const valid = ['new', 'confirmed', 'delivered', 'cancelled'];
  if (!valid.includes(req.body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const order = db.orders.updateStatus(req.ownerId, req.params.id, req.body.status);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Notify customer
  const cfg = db.storeConfig.get(req.ownerId);
  if (cfg.botToken) notifyCustomer(cfg.botToken, order).catch(console.error);

  res.json({ success: true, order });
});

/** GET /api/store-config */
app.get('/api/store-config', ownerMiddleware, (req, res) => {
  const cfg = db.storeConfig.get(req.ownerId);
  // Mask bot token for display
  const safe = { ...cfg };
  if (safe.botToken) safe.botToken = safe.botToken.slice(0, 8) + '••••••••';
  res.json(safe);
});

/** POST /api/store-config */
app.post('/api/store-config', ownerMiddleware, (req, res) => {
  // If botToken is masked (contains ••), don't overwrite
  const updates = { ...req.body };
  if (updates.botToken && updates.botToken.includes('••')) {
    delete updates.botToken;
  }
  const cfg = db.storeConfig.save(req.ownerId, updates);
  res.json({ success: true, config: cfg });
});

/** GET /api/dashboard-stats */
app.get('/api/dashboard-stats', ownerMiddleware, (req, res) => {
  const allOrders   = db.orders.getAll(req.ownerId);
  const allProducts = db.products.getAll(req.ownerId);
  const today       = new Date().toDateString();

  res.json({
    totalOrders:   allOrders.length,
    newOrders:     allOrders.filter(o => o.status === 'new').length,
    todayOrders:   allOrders.filter(o => new Date(o.createdAt).toDateString() === today).length,
    totalRevenue:  allOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0),
    totalProducts: allProducts.length,
    inStock:       allProducts.filter(p => p.available).length,
  });
});

// ═══════════════════════════════════════════════════════════
// SUPER ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

/** GET /superadmin/owners — list all store owners */
app.get('/superadmin/owners', superAdminMiddleware, (req, res) => {
  const all = db.owners.getAll().map(o => ({
    ...sanitizeOwner(o),
    orderCount:   db.orders.getAll(o.id).length,
    productCount: db.products.getAll(o.id).length,
    revenue:      db.orders.getAll(o.id)
                    .filter(ord => ord.status !== 'cancelled')
                    .reduce((s, ord) => s + ord.total, 0),
  }));
  res.json(all);
});

/** PATCH /superadmin/owners/:id/toggle — activate/deactivate store */
app.patch('/superadmin/owners/:id/toggle', superAdminMiddleware, (req, res) => {
  const owner = db.owners.getById(req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  owner.active = !owner.active;
  db.owners.save(owner);
  res.json({ success: true, active: owner.active });
});

/** PATCH /superadmin/owners/:id/plan */
app.patch('/superadmin/owners/:id/plan', superAdminMiddleware, (req, res) => {
  const { plan } = req.body;
  const owner = db.owners.getById(req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  owner.plan = plan;
  db.owners.save(owner);
  res.json({ success: true });
});

/** DELETE /superadmin/owners/:id */
app.delete('/superadmin/owners/:id', superAdminMiddleware, (req, res) => {
  db.owners.delete(req.params.id);
  res.json({ success: true });
});

/** GET /superadmin/stats */
app.get('/superadmin/stats', superAdminMiddleware, (req, res) => {
  const all = db.owners.getAll();
  res.json({
    totalStores:  all.length,
    activeStores: all.filter(o => o.active).length,
    totalOrders:  all.reduce((s, o) => s + db.orders.getAll(o.id).length, 0),
    totalRevenue: all.reduce((s, o) =>
      s + db.orders.getAll(o.id)
        .filter(ord => ord.status !== 'cancelled')
        .reduce((ss, ord) => ss + ord.total, 0), 0),
  });
});

// ═══════════════════════════════════════════════════════════
// BOT NOTIFICATION HELPERS
// ═══════════════════════════════════════════════════════════
async function telegramPost(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function notifyOwner(botToken, ownerChatId, order, ownerId) {
  const cfg      = db.storeConfig.get(ownerId);
  const currency = cfg.currency || 'сум';
  const lines    = order.items.map((item, i) =>
    `${i+1}. ${item.name} ×${item.quantity} — ${item.price * item.quantity} ${currency}`
  ).join('\n');

  const text =
    `🛍 Новый заказ #${order.id}\n\n` +
    `${lines}\n\n` +
    `💰 Итого: ${order.total.toLocaleString('ru-RU')} ${currency}\n` +
    `📞 Покупатель: @${order.customer?.username || 'неизвестен'} (${order.customer?.firstName || ''})`;

  await telegramPost(botToken, 'sendMessage', {
    chat_id: ownerChatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Подтвердить', callback_data: `confirm_${order.id}_${ownerId}` },
        { text: '❌ Отменить',    callback_data: `cancel_${order.id}_${ownerId}` },
      ]]
    }
  });
}

async function notifyCustomer(botToken, order) {
  const chatId = order.customer?.id;
  if (!chatId) return;
  const msgs = {
    confirmed: `✅ Ваш заказ #${order.id} подтверждён! Мы свяжемся с вами для доставки.`,
    cancelled: `❌ Ваш заказ #${order.id} отменён.`,
    delivered: `📦 Ваш заказ #${order.id} доставлен! Спасибо за покупку 🎉`,
  };
  const text = msgs[order.status];
  if (text) await telegramPost(botToken, 'sendMessage', { chat_id: chatId, text });
}

// ═══════════════════════════════════════════════════════════
// SAMPLE PRODUCTS SEEDER
// ═══════════════════════════════════════════════════════════
function seedSampleProducts(ownerId) {
  const samples = [
    { name: 'Футболка Classic',    price: 89000,  category: 'Одежда',     description: 'Базовая хлопковая футболка',   image: 'https://placehold.co/400x400/f0f0f0/333?text=👕', available: true },
    { name: 'Джинсы Slim Fit',     price: 259000, category: 'Одежда',     description: 'Классические зауженные джинсы', image: 'https://placehold.co/400x400/3b5bdb/fff?text=👖', available: true },
    { name: 'Кроссовки Urban Run', price: 450000, category: 'Обувь',      description: 'Лёгкие беговые кроссовки',      image: 'https://placehold.co/400x400/2f9e44/fff?text=👟', available: true },
    { name: 'Наушники AirBuds',    price: 380000, category: 'Электроника', description: 'TWS с шумоподавлением',         image: 'https://placehold.co/400x400/1c7ed6/fff?text=🎧', available: true },
    { name: 'Рюкзак TravelPack',   price: 215000, category: 'Аксессуары', description: 'Городской рюкзак 25L',          image: 'https://placehold.co/400x400/0ca678/fff?text=🎒', available: true },
    { name: 'Смарт-часы FitBand',  price: 690000, category: 'Электроника', description: 'GPS, мониторинг здоровья',     image: 'https://placehold.co/400x400/f76707/fff?text=⌚', available: false },
  ];
  samples.forEach(p => db.products.add(ownerId, p));
}

// ─── HELPERS ────────────────────────────────────────────────
function sanitizeOwner(owner) {
  const { password, ...safe } = owner;
  return safe;
}

// ─── START ──────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  const allOwners = db.owners.getAll();
  console.log(`\n🚀 Telegram Store SaaS running on http://localhost:${CONFIG.PORT}`);
  console.log(`👥 Registered stores: ${allOwners.length}`);
  console.log(`\n🔑 Super Admin:`);
  console.log(`   Email:    ${CONFIG.SUPER_ADMIN_EMAIL}`);
  console.log(`   Password: ${CONFIG.SUPER_ADMIN_PASSWORD}`);
  console.log(`   URL:      http://localhost:${CONFIG.PORT}/superadmin.html\n`);
});
