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

function guessIcon(link) {
  const l = link.toLowerCase();
  if (l.includes('x.com') || l.includes('twitter.com')) return 'x';
  if (l.includes('t.me')) return 'tg';
  if (l.includes('youtube.com') || l.includes('youtu.be')) return 'yt';
  if (l.includes('instagram.com')) return 'camera';
  if (l.includes('tiktok.com')) return 'note';
  return 'star';
}

module.exports = async (req, res) => {
  try {
    const msg = (req.body || {}).message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (chatId !== ADMIN_ID) {
      if (text.startsWith('/start')) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '👋 Welcome!\n\nTap the Menu button (bottom-left) to open the app and start earning!'
        });
      }
      return res.status(200).json({ ok: true });
    }

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
      if (!wid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /paid 3' }); return res.status(200).json({ ok: true }); }
      const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
      if (!w) { await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' not found.' }); return res.status(200).json({ ok: true }); }
      if (w.status !== 'pending') { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Already ' + w.status + '.' }); return res.status(200).json({ ok: true }); }
      await supabase.from('withdrawals').update({ status: 'done' }).eq('id', wid);
      try {
        await tg('sendMessage', { chat_id: w.user_id, text: '🎉 Payment sent!\n\nYour withdrawal of ' + w.points + ' pts has been PAID to your ' + w.method + ' account:\n' + w.account });
      } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '✅ #' + wid + ' marked PAID. User notified.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/reject')) {
      const wid = parseInt(text.split(/\s+/)[1], 10);
      if (!wid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /reject 3' }); return res.status(200).json({ ok: true }); }
      const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
      if (!w) { await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' not found.' }); return res.status(200).json({ ok: true }); }
      if (w.status !== 'pending') { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Already ' + w.status + '.' }); return res.status(200).json({ ok: true }); }
      await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', wid);
      await supabase.rpc('add_points', { p_telegram_id: w.user_id, p_amount: w.points });
      try {
        await tg('sendMessage', { chat_id: w.user_id, text: '❌ Your withdrawal of ' + w.points + ' pts was rejected.\n\nYour points have been refunded.' });
      } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' rejected. Points refunded.' });
      return res.status(200).json({ ok: true });
    }

    if (text === '/tasks') {
      const { data: list } = await supabase.from('tasks').select('*').order('id');
      if (!list || !list.length) {
        await tg('sendMessage', { chat_id: chatId, text: 'No tasks yet. Add one:\n\n/addtask 50 https://t.me/ebtry0 | Join our Channel' });
        return res.status(200).json({ ok: true });
      }
      let out = '📋 TASKS\n\n';
      for (const t of list) {
        out += '#' + t.id + ' +' + t.reward + ' pts — ' + t.title +
          '\n   ' + (t.active ? '🟢 active' : '⚪ hidden') + '\n   ' + t.link + '\n\n';
      }
      out += 'Hide: /rmtask ID • Restore: /undotask ID';
      await tg('sendMessage', { chat_id: chatId, text: out });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/addtask')) {
      const body = text.slice(8).trim();
      const segs = body.split('|');
      const left = (segs[0] || '').trim();
      const title = (segs[1] || '').trim();
      if (!left || !title) {
        await tg('sendMessage', { chat_id: chatId,
          text: 'Usage:\n/addtask 50 https://t.me/ebtry0 | Join our Channel' });
        return res.status(200).json({ ok: true });
      }
      const parts = left.split(/\s+/);
      let pts = null, icon = null, link = null;
      for (const p of parts) {
        if (/^\d+$/.test(p) && pts === null) { pts = parseInt(p, 10); continue; }
        if (/^https?:\/\//i.test(p) && !link) { link = p; continue; }
        if (/^[a-z]+$/i.test(p) && icon === null) { icon = p.toLowerCase(); continue; }
      }
      if (!pts || !link) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Could not parse. Need: points + link + | + title' });
        return res.status(200).json({ ok: true });
      }
      if (!icon) icon = guessIcon(link);
      let verify = 'honor';
      let note = '';
      if (link.includes('t.me/')) {
        const uname = link.split('t.me/')[1].split(/[/?#]/)[0];
        if (uname.startsWith('+')) {
          note = '\n⚠️ Private link — set as honor task.';
        } else {
          verify = 'telegram:@' + uname;
          note = '\n🤖 Auto-verified (bot must be admin in @' + uname + ')';
        }
      }
      const { data: t } = await supabase.from('tasks')
        .insert({ title, icon, reward: pts, link, verify }).select().single();
      await tg('sendMessage', { chat_id: chatId,
        text: '✅ Task #' + t.id + ' added:\n\n' + title + '\n+' + pts + ' pts\n' + link + note });
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

    await tg('sendMessage', { chat_id: chatId,
      text: '👑 ADMIN COMMANDS\n\n/pending\n/paid 3\n/reject 3\n\n/tasks\n/addtask 50 https://t.me/ebtry0 | Title\n/rmtask 4\n/undotask 4' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
};
