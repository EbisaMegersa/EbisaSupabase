const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);

function tg(method, body) {
  return fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function kb(rows) {
  return { inline_keyboard: rows };
}

// build keyboard rows for a withdrawal
async function wdKeyboard(w) {
  const { data: extra } = await supabase.from('admin_buttons')
    .select('id, label, payload').eq('active', true).order('id');
  const rows = [
    [
      { text: '✅ Approve', callback_data: 'wd:paid:' + w.id },
      { text: '❌ Reject', callback_data: 'wd:rejmenu:' + w.id }
    ]
  ];
  if (extra && extra.length) {
    const row = extra.slice(0, 3).map(b => ({ text: b.label, callback_data: 'wd:extra:' + b.id + ':' + w.id }));
    rows.push(row);
  }
  return kb(rows);
}

async function buildRejectMenu(wid) {
  const { data: extra } = await supabase.from('admin_buttons')
    .select('id, label, payload').eq('active', true).order('id');
  const rows = [
    [ { text: '⚠️ Not Eligible', callback_data: 'wd:rej:' + wid + ':Not eligible by requirements' } ],
    [ { text: '👤 Fake Account', callback_data: 'wd:rej:' + wid + ':Fake account details' } ],
    [ { text: '🕵️ Suspicious Activity', callback_data: 'wd:rej:' + wid + ':Suspicious activity detected' } ]
  ];
  if (extra && extra.length) {
    for (const b of extra.slice(0, 4)) {
      rows.push([ { text: b.label, callback_data: 'wd:rej:' + wid + ':' + b.payload.slice(0, 40) } ]);
    }
  }
  rows.push([ { text: '✏️ Other reason… (type it)', callback_data: 'wd:rejcustom:' + wid } ]);
  rows.push([ { text: '➕ Add custom reason button', callback_data: 'wd:addbtn:' + wid } ]);
  rows.push([ { text: '⬅️ Back', callback_data: 'wd:back:' + wid } ]);
  return kb(rows);
}

async function wdText(w) {
  const { data: u } = await supabase.from('users')
    .select('first_name, username, points').eq('telegram_id', w.user_id).maybeSingle();
  return '🔔 WITHDRAWAL REQUEST #' + w.id + '\n\n' +
    '👤 ' + (u && u.first_name ? u.first_name : 'User') + (u && u.username ? ' (@' + u.username + ')' : '') +
    '\n🆔 ' + w.user_id +
    '\n💰 ' + w.points + ' ETB' +
    '\n💳 ' + w.method + ': ' + w.account +
    '\n🏦 Balance now: ' + (u && u.points !== undefined ? u.points : '?') + ' ETB' +
    '\n\n⏳ Status: pending';
}

function guessIcon(link) {
  const l = link.toLowerCase();
  if (l.includes('x.com') || l.includes('twitter.com')) return 'x';
  if (l.includes('t.me')) return 'tg';
  if (l.includes('youtube.com') || l.includes('youtu.be')) return 'yt';
  if (l.includes('instagram.com')) return 'camera';
  if (l.includes('tiktok.com')) return 'note';
  if (l.includes('facebook.com')) return 'globe';
  return 'star';
}

async function findUser(target) {
  if (!target) return null;
  if (target.startsWith('@')) {
    const { data } = await supabase.from('users')
      .select('telegram_id, first_name, username').ilike('username', target.slice(1)).maybeSingle();
    return data;
  }
  const num = Number(target);
  if (!Number.isInteger(num)) return null;
  const { data } = await supabase.from('users')
    .select('telegram_id, first_name, username').eq('telegram_id', num).maybeSingle();
  return data;
}

// pending custom-reason input: admin is typing a reason for withdrawal X
const pendingCustom = {}; // chatId -> wid  (in-memory, fine for single admin)

module.exports = async (req, res) => {
  try {
    // ---------- CALLBACK QUERIES (button taps) ----------
    const cq = (req.body || {}).callback_query;
    if (cq) {
      const data = cq.data || '';
      const cqId = cq.id;
      const chatId = cq.message && cq.message.chat.id;
      const msgId = cq.message && cq.message.message_id;

      const answer = (text) => fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/answerCallbackQuery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cqId, text: text || '' })
      });

      if (chatId !== ADMIN_ID) return res.status(200).json({ ok: true });

      const p = data.split(':');

      // ---- approve ----
      if (p[0] === 'wd' && p[1] === 'paid') {
        const wid = parseInt(p[2], 10);
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (!w) { await answer('Not found'); return res.status(200).json({ ok: true }); }
        if (w.status !== 'pending') {
          await tg('editMessageText', { chat_id: chatId, message_id: msgId,
            text: (cq.message.text || '').split('\n\n⏳')[0] + '\n\n⚠️ Already ' + w.status + '.',
            reply_markup: { inline_keyboard: [] } });
          await answer('Already ' + w.status);
          return res.status(200).json({ ok: true });
        }
        await supabase.from('withdrawals').update({ status: 'done' }).eq('id', wid);
        try {
          await tg('sendMessage', { chat_id: w.user_id, text: '🎉 Payment sent!\n\nYour withdrawal of ' + w.points + ' ETB has been PAID to your ' + w.method + ' account:\n' + w.account });
        } catch (e) {}
        await tg('editMessageText', { chat_id: chatId, message_id: msgId,
          text: (cq.message.text || '').split('\n\n⏳')[0] + '\n\n✅ APPROVED — ' + w.points + ' ETB paid to ' + w.method + '.',
          reply_markup: { inline_keyboard: [] } });
        await answer('Paid ✓ User notified');
        return res.status(200).json({ ok: true });
      }

      // ---- open reject menu ----
      if (p[0] === 'wd' && p[1] === 'rejmenu') {
        const wid = parseInt(p[2], 10);
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId,
          reply_markup: await buildRejectMenu(wid) });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- reject with a preset reason ----
      if (p[0] === 'wd' && p[1] === 'rej') {
        const wid = parseInt(p[2], 10);
        const reason = p.slice(3).join(':') || 'Rejected';
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (!w || w.status !== 'pending') { await answer('Already handled'); return res.status(200).json({ ok: true }); }
        await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', wid);
        await supabase.rpc('add_points', { p_telegram_id: w.user_id, p_amount: w.points });
        const { data: ru } = await supabase.from('users')
          .select('ads_used, refs_used, spins_used').eq('telegram_id', w.user_id).maybeSingle();
        if (ru) {
          await supabase.from('users').update({
            ads_used: Math.max(0, (ru.ads_used || 0) - (w.ads_c || 0)),
            refs_used: Math.max(0, (ru.refs_used || 0) - (w.refs_c || 0)),
            spins_used: Math.max(0, (ru.spins_used || 0) - (w.spins_c || 0))
          }).eq('telegram_id', w.user_id);
        }
        try {
          await tg('sendMessage', { chat_id: w.user_id, text: '❌ Your withdrawal of ' + w.points + ' ETB was rejected.\n\nReason: ' + reason + '\n\nYour ETB and withdrawal requirements have been refunded.' });
        } catch (e) {}
        await tg('editMessageText', { chat_id: chatId, message_id: msgId,
          text: (cq.message.text || '').split('\n\n⏳')[0] + '\n\n❌ REJECTED — ' + reason,
          reply_markup: { inline_keyboard: [] } });
        await answer('Rejected. Refunded.');
        return res.status(200).json({ ok: true });
      }

      // ---- custom reason: ask admin to type ----
      if (p[0] === 'wd' && p[1] === 'rejcustom') {
        pendingCustom[chatId] = parseInt(p[2], 10);
        await tg('sendMessage', { chat_id: chatId, text: '✏️ Type the rejection reason for #' + p[2] + ' (next message will be used):' });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- add custom reason button for this withdrawal ----
      if (p[0] === 'wd' && p[1] === 'addbtn') {
        const wid = parseInt(p[2], 10);
        pendingCustom[chatId] = 'btn:' + wid;
        await tg('sendMessage', { chat_id: chatId, text: '➕ Send the new button in this format:\n\nLabel | Payload-as-reason\n\nExample:\nWrong Phone Number | User entered wrong phone' });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- back to main buttons ----
      if (p[0] === 'wd' && p[1] === 'back') {
        const wid = parseInt(p[2], 10);
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (w) {
          await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: await wdKeyboard(w) });
        }
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- extra custom button pressed on a withdrawal ----
      if (p[0] === 'wd' && p[1] === 'extra') {
        const btnId = parseInt(p[2], 10);
        const wid = parseInt(p[3], 10);
        const { data: b } = await supabase.from('admin_buttons').select('label, payload').eq('id', btnId).maybeSingle();
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (!b || !w) { await answer('Not found'); return res.status(200).json({ ok: true }); }
        if (w.status !== 'pending') { await answer('Already handled'); return res.status(200).json({ ok: true }); }
        await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', wid);
        await supabase.rpc('add_points', { p_telegram_id: w.user_id, p_amount: w.points });
        const { data: ru } = await supabase.from('users')
          .select('ads_used, refs_used, spins_used').eq('telegram_id', w.user_id).maybeSingle();
        if (ru) {
          await supabase.from('users').update({
            ads_used: Math.max(0, (ru.ads_used || 0) - (w.ads_c || 0)),
            refs_used: Math.max(0, (ru.refs_used || 0) - (w.refs_c || 0)),
            spins_used: Math.max(0, (ru.spins_used || 0) - (w.spins_c || 0))
          }).eq('telegram_id', w.user_id);
        }
        try {
          await tg('sendMessage', { chat_id: w.user_id, text: '❌ Your withdrawal of ' + w.points + ' ETB was rejected.\n\nReason: ' + (b.payload || b.label) + '\n\nYour ETB and requirements have been refunded.' });
        } catch (e) {}
        await tg('editMessageText', { chat_id: chatId, message_id: msgId,
          text: (cq.message.text || '').split('\n\n⏳')[0] + '\n\n❌ REJECTED — ' + (b.payload || b.label),
          reply_markup: { inline_keyboard: [] } });
        await answer('Rejected.');
        return res.status(200).json({ ok: true });
      }

      // ---- admin menu: list custom buttons ----
      if (data === 'menu:buttons') {
        const { data: list } = await supabase.from('admin_buttons').select('*').eq('active', true).order('id');
        let out = '🔘 CUSTOM BUTTONS\n\n';
        if (!list || !list.length) out += 'None yet. Add one:\n/addbtn Label | Reason text';
        else for (const b of list) out += '#' + b.id + ' ' + b.label + '\n';
        out += '\nAdd: /addbtn Label | Reason\nRemove: /delbtn ID';
        await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: out,
          reply_markup: kb([[{ text: '⬅️ Menu', callback_data: 'menu:main' }]]) });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- admin main menu ----
      if (data === 'menu:main') {
        const { data: extra } = await supabase.from('admin_buttons')
          .select('id, label').eq('active', true).order('id');
        const rows = [
          [ { text: '⏳ Pending', callback_data: 'menu:pending' }, { text: '🔘 Buttons', callback_data: 'menu:buttons' } ],
          [ { text: '📋 Tasks', callback_data: 'menu:tasks' } ]
        ];
        if (extra && extra.length) {
          rows.push(extra.slice(0, 3).map(b => ({ text: b.label, callback_data: 'exbtn:' + b.id })));
        }
        await tg('editMessageText', { chat_id: chatId, message_id: msgId,
          text: '👑 ADMIN PANEL', reply_markup: kb(rows) });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- pending list via menu ----
      if (data === 'menu:pending') {
        const { data: list } = await supabase.from('withdrawals')
          .select('id, user_id, points, method, account').eq('status', 'pending').order('id');
        if (!list || !list.length) {
          await tg('editMessageText', { chat_id: chatId, message_id: msgId,
            text: '✅ No pending withdrawals.', reply_markup: kb([[{ text: '⬅️ Menu', callback_data: 'menu:main' }]]) });
          await answer();
          return res.status(200).json({ ok: true });
        }
        const rows = list.slice(0, 10).map(w => ([ { text: '#' + w.id + ' — ' + w.points + ' ETB — ' + w.method, callback_data: 'wd:view:' + w.id } ]));
        rows.push([ { text: '⬅️ Menu', callback_data: 'menu:main' } ]);
        await tg('editMessageText', { chat_id: chatId, message_id: msgId,
          text: '⏳ PENDING (' + list.length + ')', reply_markup: kb(rows) });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- view a withdrawal from the list ----
      if (p[0] === 'wd' && p[1] === 'view') {
        const wid = parseInt(p[2], 10);
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (!w) { await answer('Not found'); return res.status(200).json({ ok: true }); }
        if (w.status !== 'pending') {
          await tg('editMessageText', { chat_id: chatId, message_id: msgId,
            text: '#' + wid + ' is ' + w.status + '.',
            reply_markup: kb([[{ text: '⬅️ Pending', callback_data: 'menu:pending' }]]) });
          await answer();
          return res.status(200).json({ ok: true });
        }
        await tg('editMessageText', { chat_id: chatId, message_id: msgId,
          text: await wdText(w), reply_markup: await wdKeyboard(w) });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- tasks list via menu ----
      if (data === 'menu:tasks') {
        const { data: list } = await supabase.from('tasks').select('*').order('id');
        let out = '📋 TASKS\n\n';
        if (!list || !list.length) out += 'None yet.';
        for (const t of (list || [])) {
          out += '#' + t.id + ' +' + t.reward + ' ETB — ' + t.title + (t.active ? ' 🟢' : ' ⚪') + '\n';
        }
        await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: out,
          reply_markup: kb([[{ text: '⬅️ Menu', callback_data: 'menu:main' }]]) });
        await answer();
        return res.status(200).json({ ok: true });
      }

      // ---- custom button pressed in main menu (free action) ----
      if (p[0] === 'exbtn') {
        const { data: b } = await supabase.from('admin_buttons').select('*').eq('id', parseInt(p[1], 10)).maybeSingle();
        await answer(b ? ('"' + b.label + '" → ' + b.payload) : 'Not found');
        return res.status(200).json({ ok: true });
      }

      await answer();
      return res.status(200).json({ ok: true });
    }

    // ---------- NORMAL MESSAGES ----------
    const msg = (req.body || {}).message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (chatId !== ADMIN_ID) {
      return res.status(200).json({ ok: true });
    }

    // admin is mid-flow typing a custom rejection reason
    if (pendingCustom[chatId]) {
      const flow = pendingCustom[chatId];
      delete pendingCustom[chatId];

      if (typeof flow === 'number') {
        const wid = flow;
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (w && w.status === 'pending') {
          await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', wid);
          await supabase.rpc('add_points', { p_telegram_id: w.user_id, p_amount: w.points });
          const { data: ru } = await supabase.from('users')
            .select('ads_used, refs_used, spins_used').eq('telegram_id', w.user_id).maybeSingle();
          if (ru) {
            await supabase.from('users').update({
              ads_used: Math.max(0, (ru.ads_used || 0) - (w.ads_c || 0)),
              refs_used: Math.max(0, (ru.refs_used || 0) - (w.refs_c || 0)),
              spins_used: Math.max(0, (ru.spins_used || 0) - (w.spins_c || 0))
            }).eq('telegram_id', w.user_id);
          }
          try {
            await tg('sendMessage', { chat_id: w.user_id, text: '❌ Your withdrawal of ' + w.points + ' ETB was rejected.\n\nReason: ' + text + '\n\nYour ETB and requirements have been refunded.' });
          } catch (e) {}
          await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' rejected: ' + text });
          return res.status(200).json({ ok: true });
        }
        await tg('sendMessage', { chat_id: chatId, text: '⚠️ #' + wid + ' is no longer pending.' });
        return res.status(200).json({ ok: true });
      }

      if (typeof flow === 'string' && flow.startsWith('btn:')) {
        const wid = parseInt(flow.split(':')[1], 10);
        const segs = text.split('|').map(s => s.trim());
        if (!segs[0] || !segs[1]) {
          await tg('sendMessage', { chat_id: chatId, text: '❌ Format: Label | Reason-text' });
          return res.status(200).json({ ok: true });
        }
        await supabase.from('admin_buttons').insert({ label: segs[0], payload: segs[1] });
        const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
        if (w && w.status === 'pending') {
          await tg('sendMessage', { chat_id: chatId, text: '✅ Button added. Here is the updated request:', reply_markup: await wdKeyboard(w) });
        } else {
          await tg('sendMessage', { chat_id: chatId, text: '✅ Button "' + segs[0] + '" saved. It now appears on all pending requests and the reject menu.' });
        }
        return res.status(200).json({ ok: true });
      }
    }

    // ---- commands ----

    if (text === '/start') {
      const { data: extra } = await supabase.from('admin_buttons').select('id, label').eq('active', true).order('id');
      const rows = [
        [ { text: '⏳ Pending', callback_data: 'menu:pending' }, { text: '🔘 Buttons', callback_data: 'menu:buttons' } ],
        [ { text: '📋 Tasks', callback_data: 'menu:tasks' } ]
      ];
      if (extra && extra.length) rows.push(extra.slice(0, 3).map(b => ({ text: b.label, callback_data: 'exbtn:' + b.id })));
      await tg('sendMessage', { chat_id: chatId, text: '👑 ADMIN PANEL', reply_markup: kb(rows) });
      return res.status(200).json({ ok: true });
    }

    if (text === '/pending') {
      const { data: list } = await supabase.from('withdrawals')
        .select('id, user_id, points, method, account').eq('status', 'pending').order('id');
      if (!list || !list.length) {
        await tg('sendMessage', { chat_id: chatId, text: '✅ No pending withdrawals.' });
        return res.status(200).json({ ok: true });
      }
      const rows = list.slice(0, 10).map(w => ([ { text: '#' + w.id + ' — ' + w.points + ' ETB — ' + w.method, callback_data: 'wd:view:' + w.id } ]));
      await tg('sendMessage', { chat_id: chatId, text: '⏳ PENDING (' + list.length + ') — tap to open', reply_markup: kb(rows) });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/paid')) {
      const wid = parseInt(text.split(/\s+/)[1], 10);
      if (!wid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /paid 3' }); return res.status(200).json({ ok: true }); }
      const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
      if (!w) { await tg('sendMessage', { chat_id: chatId, text: '❌ Not found.' }); return res.status(200).json({ ok: true }); }
      if (w.status !== 'pending') { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Already ' + w.status + '.' }); return res.status(200).json({ ok: true }); }
      await supabase.from('withdrawals').update({ status: 'done' }).eq('id', wid);
      try { await tg('sendMessage', { chat_id: w.user_id, text: '🎉 Payment sent!\n\nYour withdrawal of ' + w.points + ' ETB has been PAID to your ' + w.method + ' account:\n' + w.account }); } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '✅ #' + wid + ' PAID.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/reject')) {
      const wid = parseInt(text.split(/\s+/)[1], 10);
      if (!wid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /reject 3' }); return res.status(200).json({ ok: true }); }
      await tg('sendMessage', { chat_id: chatId, text: 'Choose a reason for #' + wid + ':', reply_markup: await buildRejectMenu(wid) });
      return res.status(200).json({ ok: true });
    }

    if (text === '/buttons') {
      const { data: list } = await supabase.from('admin_buttons').select('*').eq('active', true).order('id');
      let out = '🔘 CUSTOM BUTTONS\n\n';
      if (!list || !list.length) out += 'None yet.';
      else for (const b of list) out += '#' + b.id + ' ' + b.label + '\n';
      out += '\nAdd: /addbtn Label | Reason\nRemove: /delbtn ID';
      await tg('sendMessage', { chat_id: chatId, text: out });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/addbtn')) {
      const body = text.slice(7).trim();
      const segs = body.split('|').map(s => s.trim());
      if (!segs[0] || !segs[1]) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage:\n/addbtn Wrong Phone | User entered wrong phone\n\nThe button appears on withdrawal requests (up to 3) and in the reject menu.' });
        return res.status(200).json({ ok: true });
      }
      await supabase.from('admin_buttons').insert({ label: segs[0], payload: segs[1] });
      await tg('sendMessage', { chat_id: chatId, text: '✅ Button "' + segs[0] + '" added. Tap it on any pending withdrawal to reject with that reason.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/delbtn')) {
      const bid = parseInt(text.split(/\s+/)[1], 10);
      if (!bid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /delbtn 2' }); return res.status(200).json({ ok: true }); }
      await supabase.from('admin_buttons').update({ active: false }).eq('id', bid);
      await tg('sendMessage', { chat_id: chatId, text: '🗑 Button #' + bid + ' removed.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/addref')) {
      const parts = text.split(/\s+/);
      const target = parts[1];
      const count = parseInt(parts[2], 10);
      if (!target || !Number.isInteger(count) || count < 1 || count > 100) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage:\n/addref 123456789 5\n/addref @username 5' });
        return res.status(200).json({ ok: true });
      }
      const user = await findUser(target);
      if (!user) { await tg('sendMessage', { chat_id: chatId, text: '❌ User not found.' }); return res.status(200).json({ ok: true }); }
      const rows = Array.from({ length: count }, () => ({ referrer_id: user.telegram_id, referred_id: 0, reward_points: 0 }));
      const { error: insErr } = await supabase.from('referrals').insert(rows);
      if (insErr) { await tg('sendMessage', { chat_id: chatId, text: '❌ ' + insErr.message }); return res.status(200).json({ ok: true }); }
      const { count: newTotal } = await supabase.from('referrals')
        .select('id', { count: 'exact', head: true }).eq('referrer_id', user.telegram_id);
      await tg('sendMessage', { chat_id: chatId, text: '✅ Added ' + count + ' referral(s) to ' + (user.first_name || 'User') + '\n📊 Total: ' + (newTotal || 0) + '\n💸 No ETB given.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/rmref')) {
      const parts = text.split(/\s+/);
      const target = parts[1];
      const count = parseInt(parts[2], 10);
      if (!target || !Number.isInteger(count) || count < 1) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage:\n/rmref 123456789 2' });
        return res.status(200).json({ ok: true });
      }
      const user = await findUser(target);
      if (!user) { await tg('sendMessage', { chat_id: chatId, text: '❌ User not found.' }); return res.status(200).json({ ok: true }); }
      const { data: bonusRows } = await supabase.from('referrals')
        .select('id').eq('referrer_id', user.telegram_id).eq('referred_id', 0).order('id', { ascending: true }).limit(count);
      if (!bonusRows || !bonusRows.length) { await tg('sendMessage', { chat_id: chatId, text: '⚠️ No bonus referrals to remove.' }); return res.status(200).json({ ok: true }); }
      await supabase.from('referrals').delete().in('id', bonusRows.map(r => r.id));
      const { count: newTotal } = await supabase.from('referrals')
        .select('id', { count: 'exact', head: true }).eq('referrer_id', user.telegram_id);
      await tg('sendMessage', { chat_id: chatId, text: '🗑 Removed ' + bonusRows.length + ' bonus referral(s). Total: ' + (newTotal || 0) });
      return res.status(200).json({ ok: true });
    }

    if (text === '/tasks') {
      const { data: list } = await supabase.from('tasks').select('*').order('id');
      if (!list || !list.length) { await tg('sendMessage', { chat_id: chatId, text: 'No tasks yet.' }); return res.status(200).json({ ok: true }); }
      let out = '📋 TASKS\n\n';
      for (const t of list) out += '#' + t.id + ' +' + t.reward + ' ETB — ' + t.title + (t.active ? ' 🟢' : ' ⚪') + '\n';
      await tg('sendMessage', { chat_id: chatId, text: out + '\nHide: /rmtask ID • Restore: /undotask ID' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/addtask')) {
      const body = text.slice(8).trim();
      const segs = body.split('|');
      const left = (segs[0] || '').trim();
      const title = (segs[1] || '').trim();
      if (!left || !title) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage:\n/addtask 50 https://t.me/ebtry0 | Join our Channel' });
        return res.status(200).json({ ok: true });
      }
      const parts = left.split(/\s+/);
      let pts = null, icon2 = null, link = null;
      for (const p of parts) {
        if (/^\d+$/.test(p) && pts === null) { pts = parseInt(p, 10); continue; }
        if (/^https?:\/\//i.test(p) && !link) { link = p; continue; }
        if (/^[a-z]+$/i.test(p) && icon2 === null) { icon2 = p.toLowerCase(); continue; }
      }
      if (!pts || !link) { await tg('sendMessage', { chat_id: chatId, text: '❌ Need: points + link + | + title' }); return res.status(200).json({ ok: true }); }
      if (!icon2) icon2 = guessIcon(link);
      let verify = 'honor';
      let note = '';
      if (link.includes('t.me/')) {
        const uname = link.split('t.me/')[1].split(/[/?#]/)[0];
        if (uname.startsWith('+')) note = '\n⚠️ Private link — honor task.';
        else { verify = 'telegram:@' + uname; note = '\n🤖 Auto-verified (bot must be admin in @' + uname + ')'; }
      }
      const { data: t } = await supabase.from('tasks').insert({ title, icon: icon2, reward: pts, link, verify }).select().single();
      await tg('sendMessage', { chat_id: chatId, text: '✅ Task #' + t.id + ' added:\n\n' + title + '\n+' + pts + ' ETB\n' + link + note });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/rmtask')) {
      const tid = parseInt(text.split(/\s+/)[1], 10);
      if (!tid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /rmtask 4' }); return res.status(200).json({ ok: true }); }
      await supabase.from('tasks').update({ active: false }).eq('id', tid);
      await tg('sendMessage', { chat_id: chatId, text: '⚪ Task #' + tid + ' hidden. Restore: /undotask ' + tid });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/undotask')) {
      const tid = parseInt(text.split(/\s+/)[1], 10);
      if (!tid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /undotask 4' }); return res.status(200).json({ ok: true }); }
      await supabase.from('tasks').update({ active: true }).eq('id', tid);
      await tg('sendMessage', { chat_id: chatId, text: '🟢 Task #' + tid + ' restored.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/review')) {
      const body = text.slice(7).trim();
      const p = body.split('|').map(s => s.trim());
      if (!p[0] || !p[1]) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage:\n/review Abebe | Pays fast! | 5' });
        return res.status(200).json({ ok: true });
      }
      const stars = Math.min(5, Math.max(1, parseInt(p[2], 10) || 5));
      const { data: rv } = await supabase.from('reviews').insert({ name: p[0], message: p[1], stars }).select().single();
      await tg('sendMessage', { chat_id: chatId, text: '✅ Review #' + rv.id + ' added. Delete: /delreview ' + rv.id });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/delreview')) {
      const rid = parseInt(text.split(/\s+/)[1], 10);
      if (!rid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /delreview 3' }); return res.status(200).json({ ok: true }); }
      await supabase.from('reviews').delete().eq('id', rid);
      await tg('sendMessage', { chat_id: chatId, text: '🗑 Review #' + rid + ' deleted.' });
      return res.status(200).json({ ok: true });
    }

    // fallback: show the panel
    const { data: extra } = await supabase.from('admin_buttons').select('id, label').eq('active', true).order('id');
    const rows = [
      [ { text: '⏳ Pending', callback_data: 'menu:pending' }, { text: '🔘 Buttons', callback_data: 'menu:buttons' } ],
      [ { text: '📋 Tasks', callback_data: 'menu:tasks' } ]
    ];
    if (extra && extra.length) rows.push(extra.slice(0, 3).map(b => ({ text: b.label, callback_data: 'exbtn:' + b.id })));
    await tg('sendMessage', { chat_id: chatId, text: '👑 ADMIN PANEL\n\nTap a button:', reply_markup: kb(rows) });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
};
