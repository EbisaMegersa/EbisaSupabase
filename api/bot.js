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

module.exports = async (req, res) => {
  try {
    const msg = (req.body || {}).message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // ---- regular users ----
    if (chatId !== ADMIN_ID) {
      if (text.startsWith('/start')) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '👋 Welcome!\n\nTap the 📋 Menu button (bottom-left) to open the app and start earning!'
        });
      }
      return res.status(200).json({ ok: true });
    }

    // ---- ADMIN ONLY below ----

    if (text === '/pending') {
      const { data: list } = await supabase.from('withdrawals')
        .select('id, user_id, points, method, account').eq('status', 'pending').order('id');
      if (!list || !list.length) {
        await tg('sendMessage', { chat_id: chatId, text: '✅ No pending withdrawals.' });
        return res.status(200).json({ ok: true });
      }
      let out = '⏳ PENDING WITHDRAWALS\n\n';
      for (const w of list) {
        const { data: u } = await supabase.from('users')
          .select('first_name, username').eq('telegram_id', w.user_id).maybeSingle();
        out += '#' + w.id + ' — ' + w.points + ' pts\n👤 ' +
          (u && u.first_name ? u.first_name : 'User') +
          (u && u.username ? ' (@' + u.username + ')' : '') +
          '\n💳 ' + w.method + ': ' + w.account +
          '\n✅ /paid ' + w.id + '   •   ❌ /reject ' + w.id + '\n\n';
      }
      await tg('sendMessage', { chat_id: chatId, text: out });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/paid')) {
      const wid = parseInt(text.split(/\s+/)[1], 10);
      if (!wid) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: /paid 3' });
        return res.status(200).json({ ok: true });
      }
      const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
      if (!w) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Withdrawal #' + wid + ' not found.' });
        return res.status(200).json({ ok: true });
      }
      if (w.status !== 'pending') {
        await tg('sendMessage', { chat_id: chatId, text: '⚠️ #' + wid + ' is already ' + w.status + '.' });
        return res.status(200).json({ ok: true });
      }

      await supabase.from('withdrawals').update({ status: 'done' }).eq('id', wid);
      try {
        await tg('sendMessage', {
          chat_id: w.user_id,
          text: '🎉 Payment sent!\n\nYour withdrawal of ' + w.points + ' pts has been PAID to your ' + w.method + ' account:\n' + w.account + '\n\nThanks for using our app! 💜'
        });
      } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '✅ #' + wid + ' marked as PAID. User notified.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/reject')) {
      const wid = parseInt(text.split(/\s+/)[1], 10);
      if (!wid) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: /reject 3' });
        return res.status(200).json({ ok: true });
      }
      const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
      if (!w) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Withdrawal #' + wid + ' not found.' });
        return res.status(200).json({ ok: true });
      }
      if (w.status !== 'pending') {
        await tg('sendMessage', { chat_id: chatId, text: '⚠️ #' + wid + ' is already ' + w.status + '.' });
        return res.status(200).json({ ok: true });
      }

      await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', wid);
      await supabase.rpc('add_points', { p_telegram_id: w.user_id, p_amount: w.points });
      try {
        await tg('sendMessage', {
          chat_id: w.user_id,
          text: '❌ Your withdrawal of ' + w.points + ' pts was rejected.\n\nYour points have been refunded to your balance.'
        });
      } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' rejected. Points refunded to user.' });
      return res.status(200).json({ ok: true });
    }

    await tg('sendMessage', { chat_id: chatId,
      text: '👑 ADMIN COMMANDS\n\n/pending — list pending withdrawals\n/paid 3 — approve #3 & notify user\n/reject 3 — reject #3 & refund points' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
};
