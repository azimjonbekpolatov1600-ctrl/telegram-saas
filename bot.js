/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           TELEGRAM STORE — BOT (node-telegram-bot-api)      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HOW TO CREATE YOUR BOT:
 * 1. Open Telegram → search @BotFather
 * 2. Send /newbot
 * 3. Choose a name: "My Uzb Store Bot"
 * 4. Choose a username: "myuzbstore_bot" (must end in _bot)
 * 5. Copy the API token → paste as BOT_TOKEN below
 *
 * HOW TO SET MINI APP URL:
 * 1. In @BotFather → /mybots → select your bot
 * 2. Bot Settings → Menu Button → Configure menu button
 * 3. Enter your deployed URL (e.g. https://your-store.render.com)
 * 4. Enter button text: "🛍 Открыть магазин"
 *
 * HOW TO GET YOUR OWNER CHAT ID:
 * 1. Send any message to @userinfobot in Telegram
 * 2. It replies with your ID → copy it as OWNER_CHAT_ID
 *
 * RUN THIS BOT:
 *   node bot.js          (in a separate terminal from server.js)
 *   npm run bot          (same thing)
 *   npm run dev:bot      (with auto-reload via nodemon)
 */

const TelegramBot = require('node-telegram-bot-api');

// ─── CONFIG ────────────────────────────────────────────────────────────────
// REPLACE: Your bot token from @BotFather
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
// REPLACE: Your deployed Mini App URL (from Render/Railway/ngrok)
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-store-url.render.com';
// REPLACE: Your personal Telegram chat ID (from @userinfobot)
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || 'YOUR_CHAT_ID_HERE';
// REPLACE: Store name shown in welcome message
const STORE_NAME = process.env.STORE_NAME || 'Telegram Shop 🛍';

// ─── BOT INIT ──────────────────────────────────────────────────────────────
if (BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('❌ ERROR: Set BOT_TOKEN before running the bot!');
  console.error('   Either edit bot.js or set env: BOT_TOKEN=xxx node bot.js');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log(`\n🤖 ${STORE_NAME} bot started!`);
console.log(`🌐 Mini App URL: ${MINI_APP_URL}\n`);

// ─── /start COMMAND ────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'Покупатель';

  const welcomeText =
    `Привет, ${firstName}! 👋\n\n` +
    `Добро пожаловать в *${STORE_NAME}* — ваш мини-магазин прямо в Telegram.\n\n` +
    `🛒 Просматривайте товары\n` +
    `🏷️ Фильтруйте по категориям\n` +
    `📦 Оформляйте заказы\n\n` +
    `Нажмите кнопку ниже, чтобы открыть магазин:`;

  await bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        {
          text: '🛍 Открыть магазин',
          web_app: { url: MINI_APP_URL }
        }
      ]]
    }
  });
});

// ─── /help COMMAND ─────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `📖 *Помощь*\n\n` +
    `/start — главное меню\n` +
    `/catalog — открыть каталог\n` +
    `/myorders — мои заказы\n\n` +
    `По вопросам заказов свяжитесь с нами напрямую.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /catalog COMMAND ──────────────────────────────────────────────────────
bot.onText(/\/catalog/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '🛍 Открываем каталог...', {
    reply_markup: {
      inline_keyboard: [[
        { text: '📦 Каталог товаров', web_app: { url: MINI_APP_URL } }
      ]]
    }
  });
});

// ─── CALLBACK QUERY HANDLER (for order confirm/cancel buttons) ─────────────
bot.on('callback_query', async (query) => {
  const data     = query.data;  // e.g. "confirm_001" or "cancel_001"
  const chatId   = query.message.chat.id;
  const msgId    = query.message.message_id;

  if (!data) return;

  const [action, orderId] = data.split('_');

  if (action === 'confirm' || action === 'cancel') {
    const newStatus = action === 'confirm' ? 'confirmed' : 'cancelled';
    const emoji     = action === 'confirm' ? '✅' : '❌';
    const label     = action === 'confirm' ? 'Подтверждён' : 'Отменён';

    // Update order via server API
    try {
      const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
      const adminKey  = process.env.ADMIN_API_KEY || 'super-secret-admin-key-2025';

      const res = await fetch(`${serverUrl}/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': adminKey,
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        // Edit the original message to show updated status
        await bot.editMessageText(
          query.message.text + `\n\n${emoji} Статус обновлён: *${label}*`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] } // Remove buttons
          }
        );
        await bot.answerCallbackQuery(query.id, { text: `Заказ #${orderId} ${label}` });
      } else {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Ошибка обновления статуса' });
      }
    } catch (err) {
      console.error('Callback error:', err.message);
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Сервер недоступен' });
    }
  }
});

// ─── HANDLE WEB APP DATA (when Mini App sends data via sendData) ───────────
bot.on('message', async (msg) => {
  // Mini App can send order data directly via Telegram.WebApp.sendData()
  if (msg.web_app_data) {
    try {
      const orderData = JSON.parse(msg.web_app_data.data);
      const chatId    = msg.chat.id;

      if (orderData.type === 'order_placed') {
        await bot.sendMessage(chatId,
          `✅ Заказ #${orderData.orderId} оформлен!\n\n` +
          `Мы скоро свяжемся с вами для подтверждения. 📦`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      // Not our data format, ignore
    }
  }
});

// ─── ERROR HANDLING ────────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM') {
    console.error('❌ Telegram API error:', err.response?.body?.description);
    if (err.response?.body?.description?.includes('Unauthorized')) {
      console.error('   → Check your BOT_TOKEN!');
    }
  } else {
    console.error('Polling error:', err.message);
  }
});

process.on('SIGINT', () => {
  console.log('\n👋 Bot stopped.');
  bot.stopPolling();
  process.exit(0);
});
