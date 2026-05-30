/**
 * bot-runner.js
 * Runs ONE polling bot per registered owner — each with their own token.
 * Polls every 30s for new owners and starts their bot automatically.
 *
 * Run: node bot-runner.js  (separate terminal from server.js)
 */

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

// REPLACE: Your deployed server URL (used for callback updates)
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

// Map of ownerId → running bot instance
const runningBots = new Map();

console.log('\n🤖 Bot runner started');
console.log(`   Server: ${SERVER_URL}\n`);

// ─── START BOT FOR ONE OWNER ──────────────────────────────
function startBotForOwner(owner, cfg) {
  if (!cfg.botToken || !cfg.ownerChatId) return;
  if (runningBots.has(owner.id)) return; // already running

  let bot;
  try {
    bot = new TelegramBot(cfg.botToken, { polling: true });
  } catch (e) {
    console.error(`❌ Failed to start bot for ${owner.email}:`, e.message);
    return;
  }

  const storeUrl = cfg.storeUrl || `${SERVER_URL}/store.html?owner=${owner.id}`;
  // REPLACE: customize welcome message
  const storeName = cfg.storeName || owner.name + "'s Shop";

  // /start command
  bot.onText(/\/start/, async (msg) => {
    const chatId    = msg.chat.id;
    const firstName = msg.from.first_name || 'Покупатель';
    await bot.sendMessage(chatId,
      `Привет, ${firstName}! 👋\n\nДобро пожаловать в *${storeName}*!\n\nНажмите кнопку ниже, чтобы открыть магазин:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🛍 Открыть магазин', web_app: { url: storeUrl } }
          ]]
        }
      }
    );
  });

  // /catalog command
  bot.onText(/\/catalog/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '📦 Открываем каталог...', {
      reply_markup: {
        inline_keyboard: [[
          { text: '📦 Каталог', web_app: { url: storeUrl } }
        ]]
      }
    });
  });

  // Callback: confirm/cancel order buttons
  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    // Format: confirm_ORDERID_OWNERID or cancel_ORDERID_OWNERID
    const parts = data.split('_');
    if (parts.length < 3) return;

    const [action, orderId, callbackOwnerId] = parts;
    if (callbackOwnerId !== owner.id) return; // not for this bot

    const newStatus = action === 'confirm' ? 'confirmed' : 'cancelled';
    const emoji     = action === 'confirm' ? '✅' : '❌';
    const label     = action === 'confirm' ? 'Подтверждён' : 'Отменён';

    try {
      const res = await fetch(`${SERVER_URL}/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          // Use a server-internal call — pass owner JWT
          'Authorization': `Bearer ${generateOwnerToken(owner)}`,
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        await bot.editMessageText(
          query.message.text + `\n\n${emoji} Статус: *${label}*`,
          {
            chat_id:    query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] },
          }
        );
        await bot.answerCallbackQuery(query.id, { text: `Заказ #${orderId} ${label}` });
      } else {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Ошибка обновления' });
      }
    } catch (e) {
      console.error(`Bot callback error (${owner.email}):`, e.message);
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Сервер недоступен' });
    }
  });

  bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM') {
      const desc = err.response?.body?.description || '';
      if (desc.includes('Unauthorized')) {
        console.error(`❌ Invalid bot token for ${owner.email} — stopping their bot`);
        stopBotForOwner(owner.id);
      }
    }
  });

  runningBots.set(owner.id, bot);
  console.log(`✅ Bot started for ${owner.email} (${storeName})`);
}

function stopBotForOwner(ownerId) {
  const bot = runningBots.get(ownerId);
  if (bot) {
    bot.stopPolling();
    runningBots.delete(ownerId);
    console.log(`⛔ Bot stopped for owner ${ownerId}`);
  }
}

// Generate a temporary JWT for the owner (for internal API calls from bot)
function generateOwnerToken(owner) {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'replace-this-with-a-long-random-secret-string';
  return jwt.sign({ id: owner.id, email: owner.email, role: 'owner' }, secret, { expiresIn: '1h' });
}

// ─── POLLING LOOP — check for new owners every 30s ────────
async function syncBots() {
  try {
    const owners = await db.owners.getAll();

    for (const owner of owners) {
      if (!owner.active) {
        stopBotForOwner(owner.id);
        continue;
      }
      const cfg = await db.storeConfig.get(owner.id);
      if (cfg.botToken && cfg.ownerChatId) {
        startBotForOwner(owner, cfg);
      }
    }

    // Stop bots for deleted owners
    for (const [ownerId] of runningBots) {
      if (!owners.find(o => o.id === ownerId)) {
        stopBotForOwner(ownerId);
      }
    }
  } catch (e) {
    console.error('syncBots error:', e.message);
  }
}

// ─── KEEP-ALIVE HTTP SERVER (required for Render) ─────────
// Render expects a web server on a port — this satisfies that
const http = require('http');
const PORT = process.env.PORT || 4000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({
    status: 'ok',
    bots: runningBots.size,
    uptime: process.uptime(),
  }));
}).listen(PORT, () => {
  console.log(`🌐 Bot runner health check on port ${PORT}`);
});

// Initial sync + repeat every 30 seconds
syncBots();
setInterval(syncBots, 30_000);

process.on('SIGINT', () => {
  console.log('\n👋 Stopping all bots...');
  for (const [id, bot] of runningBots) {
    bot.stopPolling();
  }
  process.exit(0);
});
