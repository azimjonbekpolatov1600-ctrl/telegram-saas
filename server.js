/**
 * server.js — Telegram Store SaaS Backend v2.1 (MongoDB)
 */

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db       = require('./db');

const app = express();

const CONFIG = {
  PORT:                 process.env.PORT || 3000,
  JWT_SECRET:           process.env.JWT_SECRET || 'replace-this-with-a-long-random-secret-string',
  JWT_EXPIRES:          '30d',
  SUPER_ADMIN_EMAIL:    process.env.SUPER_ADMIN_EMAIL    || 'admin@yourstore.com',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin2025!',
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
  next();
});

// ─── AUTH MIDDLEWARE ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, CONFIG.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function superAdminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

function ownerMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    req.ownerId = (req.user.role === 'superadmin' && req.query.ownerId)
      ? req.query.ownerId : req.user.id;
    next();
  });
}

// ═══════════════ AUTH ROUTES ═══════════════════════════════

app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    if (await db.owners.getByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

    const owner = {
      id: uuidv4(), email: email.toLowerCase().trim(),
      password: await bcrypt.hash(password, 10),
      name: name.trim(), role: 'owner', active: true,
      plan: 'trial', createdAt: new Date().toISOString(),
    };
    await db.owners.save(owner);
    await seedSampleProducts(owner.id);

    const token = jwt.sign({ id: owner.id, email: owner.email, role: 'owner' }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRES });
    const { password: _, ...safe } = owner;
    res.status(201).json({ token, owner: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    if (email.toLowerCase() === CONFIG.SUPER_ADMIN_EMAIL.toLowerCase() && password === CONFIG.SUPER_ADMIN_PASSWORD) {
      const token = jwt.sign({ id: 'superadmin', email, role: 'superadmin' }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRES });
      return res.json({ token, owner: { id: 'superadmin', name: 'Super Admin', role: 'superadmin' } });
    }

    const owner = await db.owners.getByEmail(email);
    if (!owner || !await bcrypt.compare(password, owner.password)) return res.status(401).json({ error: 'Invalid email or password' });
    if (!owner.active) return res.status(403).json({ error: 'Account deactivated' });

    const token = jwt.sign({ id: owner.id, email: owner.email, role: 'owner' }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRES });
    const { password: _, ...safe } = owner;
    res.json({ token, owner: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'superadmin') return res.json({ id: 'superadmin', name: 'Super Admin', role: 'superadmin' });
    const owner = await db.owners.getById(req.user.id);
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    const { password: _, ...safe } = owner;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════ PUBLIC STORE ROUTES ═══════════════════════

app.get('/store/:ownerId/products', async (req, res) => {
  try {
    const owner = await db.owners.getById(req.params.ownerId);
    if (!owner || !owner.active) return res.status(404).json({ error: 'Store not found' });
    res.json(await db.products.getAll(req.params.ownerId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/store/:ownerId/config', async (req, res) => {
  try {
    const owner = await db.owners.getById(req.params.ownerId);
    if (!owner || !owner.active) return res.status(404).json({ error: 'Store not found' });
    const cfg = await db.storeConfig.get(req.params.ownerId);
    res.json({ storeName: cfg.storeName || owner.name + "'s Shop", currency: cfg.currency || 'сум', ownerId: req.params.ownerId, defaultLang: cfg.defaultLang || 'ru' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/store/:ownerId/orders', async (req, res) => {
  try {
    const ownerId = req.params.ownerId;
    const owner   = await db.owners.getById(ownerId);
    if (!owner || !owner.active) return res.status(404).json({ error: 'Store not found' });

    const { items, customer } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'items required' });
    if (!customer?.id)  return res.status(400).json({ error: 'customer.id required' });

    const storeProducts = await db.products.getAll(ownerId);
    const resolvedItems = [];
    for (const item of items) {
      const p = storeProducts.find(p => p.id === String(item.productId));
      if (!p) return res.status(400).json({ error: `Product ${item.productId} not found` });
      if (!p.available) return res.status(400).json({ error: `"${p.name}" out of stock` });
      resolvedItems.push({ productId: p.id, name: p.name, price: p.price, quantity: item.quantity || 1, image: p.image });
    }

    const total    = resolvedItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const newOrder = await db.orders.add(ownerId, { items: resolvedItems, total, customer, status: 'new' });
    const cfg      = await db.storeConfig.get(ownerId);
    if (cfg.botToken && cfg.ownerChatId) notifyOwner(cfg.botToken, cfg.ownerChatId, newOrder, ownerId, cfg.currency).catch(console.error);

    res.status(201).json({ success: true, orderId: newOrder.id, order: newOrder });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════ OWNER API ROUTES ══════════════════════════

app.get('/api/products', ownerMiddleware, async (req, res) => {
  try { res.json(await db.products.getAll(req.ownerId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', ownerMiddleware, async (req, res) => {
  try {
    const { name, price, category, description, image, available } = req.body;
    if (!name || !price || !category) return res.status(400).json({ error: 'name, price, category required' });
    const product = await db.products.add(req.ownerId, {
      name, price: Number(price), category,
      description: description || '',
      image: image || `https://placehold.co/400x400/cccccc/333?text=${encodeURIComponent(name)}`,
      available: available !== false,
    });
    res.status(201).json({ success: true, product });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', ownerMiddleware, async (req, res) => {
  try {
    const product = await db.products.update(req.ownerId, req.params.id, req.body);
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, product });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', ownerMiddleware, async (req, res) => {
  try { await db.products.delete(req.ownerId, req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/products/:id/toggle', ownerMiddleware, async (req, res) => {
  try {
    const all = await db.products.getAll(req.ownerId);
    const p   = all.find(p => p.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const updated = await db.products.update(req.ownerId, req.params.id, { available: !p.available });
    res.json({ success: true, available: updated.available });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', ownerMiddleware, async (req, res) => {
  try {
    let list = await db.orders.getAll(req.ownerId);
    if (req.query.status) list = list.filter(o => o.status === req.query.status);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/status', ownerMiddleware, async (req, res) => {
  try {
    const valid = ['new','confirmed','delivered','cancelled'];
    if (!valid.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    const order = await db.orders.updateStatus(req.ownerId, req.params.id, req.body.status);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const cfg = await db.storeConfig.get(req.ownerId);
    if (cfg.botToken) notifyCustomer(cfg.botToken, order).catch(console.error);
    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/store-config', ownerMiddleware, async (req, res) => {
  try {
    const cfg  = await db.storeConfig.get(req.ownerId);
    const safe = { ...cfg };
    if (safe.botToken) safe.botToken = safe.botToken.slice(0,8) + '••••••••';
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/store-config', ownerMiddleware, async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.botToken?.includes('••')) delete updates.botToken;
    const cfg = await db.storeConfig.save(req.ownerId, updates);
    res.json({ success: true, config: cfg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard-stats', ownerMiddleware, async (req, res) => {
  try {
    const [allOrders, allProducts] = await Promise.all([
      db.orders.getAll(req.ownerId),
      db.products.getAll(req.ownerId),
    ]);
    const today = new Date().toDateString();
    res.json({
      totalOrders:   allOrders.length,
      newOrders:     allOrders.filter(o => o.status === 'new').length,
      todayOrders:   allOrders.filter(o => new Date(o.createdAt).toDateString() === today).length,
      totalRevenue:  allOrders.filter(o => o.status !== 'cancelled').reduce((s,o) => s+o.total, 0),
      totalProducts: allProducts.length,
      inStock:       allProducts.filter(p => p.available).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════ SUPER ADMIN ROUTES ════════════════════════

app.get('/superadmin/owners', superAdminMiddleware, async (req, res) => {
  try {
    const all = await db.owners.getAll();
    const result = await Promise.all(all.map(async o => {
      const [ords, prods] = await Promise.all([db.orders.getAll(o.id), db.products.getAll(o.id)]);
      const { password: _, ...safe } = o;
      return { ...safe, orderCount: ords.length, productCount: prods.length,
        revenue: ords.filter(ord => ord.status !== 'cancelled').reduce((s,ord) => s+ord.total, 0) };
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/superadmin/owners/:id/toggle', superAdminMiddleware, async (req, res) => {
  try {
    const owner = await db.owners.getById(req.params.id);
    if (!owner) return res.status(404).json({ error: 'Not found' });
    owner.active = !owner.active;
    await db.owners.save(owner);
    res.json({ success: true, active: owner.active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/superadmin/owners/:id/plan', superAdminMiddleware, async (req, res) => {
  try {
    const owner = await db.owners.getById(req.params.id);
    if (!owner) return res.status(404).json({ error: 'Not found' });
    owner.plan = req.body.plan;
    await db.owners.save(owner);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/superadmin/owners/:id', superAdminMiddleware, async (req, res) => {
  try { await db.owners.delete(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/superadmin/stats', superAdminMiddleware, async (req, res) => {
  try {
    const all = await db.owners.getAll();
    const stats = await Promise.all(all.map(async o => {
      const ords = await db.orders.getAll(o.id);
      return { active: o.active, orders: ords.length, revenue: ords.filter(ord => ord.status !== 'cancelled').reduce((s,ord) => s+ord.total, 0) };
    }));
    res.json({
      totalStores:  all.length,
      activeStores: stats.filter(s => s.active).length,
      totalOrders:  stats.reduce((s,st) => s+st.orders, 0),
      totalRevenue: stats.reduce((s,st) => s+st.revenue, 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════ BOT NOTIFICATION HELPERS ══════════════════

async function telegramPost(botToken, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

async function notifyOwner(botToken, ownerChatId, order, ownerId, currency = 'сум') {
  const lines = order.items.map((i,idx) => `${idx+1}. ${i.name} ×${i.quantity} — ${(i.price*i.quantity).toLocaleString('ru-RU')} ${currency}`).join('\n');
  await telegramPost(botToken, 'sendMessage', {
    chat_id: ownerChatId,
    text: `🛍 Новый заказ #${order.id}\n\n${lines}\n\n💰 Итого: ${order.total.toLocaleString('ru-RU')} ${currency}\n📞 Покупатель: @${order.customer?.username || 'неизвестен'}`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Подтвердить', callback_data: `confirm_${order.id}_${ownerId}` },
      { text: '❌ Отменить',    callback_data: `cancel_${order.id}_${ownerId}` },
    ]]}
  });
}

async function notifyCustomer(botToken, order) {
  const chatId = order.customer?.id;
  if (!chatId) return;
  const msgs = { confirmed: `✅ Заказ #${order.id} подтверждён!`, cancelled: `❌ Заказ #${order.id} отменён.`, delivered: `📦 Заказ #${order.id} доставлен! Спасибо 🎉` };
  const text = msgs[order.status];
  if (text) await telegramPost(botToken, 'sendMessage', { chat_id: chatId, text });
}

// ═══════════════ SAMPLE PRODUCTS SEEDER ════════════════════

async function seedSampleProducts(ownerId) {
  const samples = [
    { name:'Футболка Classic', price:89000, category:'Одежда', description:'Базовая хлопковая футболка', image:'https://placehold.co/400x400/f0f0f0/333?text=👕', available:true },
    { name:'Джинсы Slim Fit', price:259000, category:'Одежда', description:'Классические зауженные джинсы', image:'https://placehold.co/400x400/3b5bdb/fff?text=👖', available:true },
    { name:'Кроссовки Urban Run', price:450000, category:'Обувь', description:'Лёгкие беговые кроссовки', image:'https://placehold.co/400x400/2f9e44/fff?text=👟', available:true },
    { name:'Наушники AirBuds', price:380000, category:'Электроника', description:'TWS с шумоподавлением', image:'https://placehold.co/400x400/1c7ed6/fff?text=🎧', available:true },
    { name:'Рюкзак TravelPack', price:215000, category:'Аксессуары', description:'Городской рюкзак 25L', image:'https://placehold.co/400x400/0ca678/fff?text=🎒', available:true },
    { name:'Смарт-часы FitBand', price:690000, category:'Электроника', description:'GPS, мониторинг здоровья', image:'https://placehold.co/400x400/f76707/fff?text=⌚', available:false },
  ];
  for (const p of samples) await db.products.add(ownerId, p);
}

// ─── START ──────────────────────────────────────────────────
app.listen(CONFIG.PORT, async () => {
  const allOwners = await db.owners.getAll().catch(() => []);
  console.log(`\n🚀 Telegram Store SaaS running on http://localhost:${CONFIG.PORT}`);
  console.log(`👥 Registered stores: ${allOwners.length}`);
  console.log(`\n🔑 Super Admin:`);
  console.log(`   Email:    ${CONFIG.SUPER_ADMIN_EMAIL}`);
  console.log(`   Password: ${CONFIG.SUPER_ADMIN_PASSWORD}`);
  console.log(`   URL:      http://localhost:${CONFIG.PORT}/superadmin.html\n`);
});
