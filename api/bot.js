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
  if (l.includes('facebook.com')) return 'globe';
  return 'star';
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

    // ---- ADMIN ONLY ----

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
        out += '#' + w.id + ' — ' + w.points + ' ETB\n👤 ' +
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
      if (w.status !== 'pending') { await tg('sendMessage', { chat_id: chatId, text: '⚠️ #' + wid + ' is already ' + w.status + '.' }); return res.status(200).json({ ok: true }); }
      await supabase.from('withdrawals').update({ status: 'done' }).eq('id', wid);
      try {
        await tg('sendMessage', { chat_id: w.user_id, text: '🎉 Payment sent!\n\nYour withdrawal of ' + w.points + ' ETB has been PAID to your ' + w.method + ' account:\n' + w.account });
      } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '✅ #' + wid + ' marked PAID. User notified.' });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/reject')) {
      const wid = parseInt(text.split(/\s+/)[1], 10);
      if (!wid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /reject 3' }); return res.status(200).json({ ok: true }); }
      const { data: w } = await supabase.from('withdrawals').select('*').eq('id', wid).maybeSingle();
      if (!w) { await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' not found.' }); return res.status(200).json({ ok: true }); }
      if (w.status !== 'pending') { await tg('sendMessage', { chat_id: chatId, text: '⚠️ #' + wid + ' is already ' + w.status + '.' }); return res.status(200).json({ ok: true }); }
      await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', wid);
      await supabase.rpc('add_points', { p_telegram_id: w.user_id, p_amount: w.points });
      // refund consumed withdrawal requirements (ads + friends)
      const { data: ru } = await supabase.from('users')
        .select('ads_used, refs_used').eq('telegram_id', w.user_id).maybeSingle();
      if (ru) {
        await supabase.from('users').update({
          ads_used: Math.max(0, (ru.ads_used || 0) - (w.ads_c || 0)),
          refs_used: Math.max(0, (ru.refs_used || 0) - (w.refs_c || 0))
        }).eq('telegram_id', w.user_id);
      }
      try {
        await tg('sendMessage', { chat_id: w.user_id, text: '❌ Your withdrawal of ' + w.points + ' ETB was rejected.\n\nYour ETB and withdrawal requirements (ads + friends) have been refunded.' });
      } catch (e) {}
      await tg('sendMessage', { chat_id: chatId, text: '❌ #' + wid + ' rejected. ETB + requirements refunded.' });
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
        out += '#' + t.id + ' +' + t.reward + ' ETB — ' + t.title +
          '\n   ' + (t.active ? '🟢 active' : '⚪ hidden') + ' • ' + t.verify + '\n   ' + t.link + '\n\n';
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
          text: 'Usage:\n/addtask 50 https://t.me/ebtry0 | Join our Channel\n\n• t.me links = auto-verified join check\n• other links = honor system (user taps Verify)\n• optional icon: /addtask 50 star https://… | Title\nIcons: star tg mega chat x yt camera note globe heart bell gift zap coin' });
        return res.status(200).json({ ok: true });
      }
      const parts = left.split(/\s+/);
      let pts = null, icon2 = null, link = null;
      for (const p of parts) {
        if (/^\d+$/.test(p) && pts === null) { pts = parseInt(p, 10); continue; }
        if (/^https?:\/\//i.test(p) && !link) { link = p; continue; }
        if (/^[a-z]+$/i.test(p) && icon2 === null) { icon2 = p.toLowerCase(); continue; }
      }
      if (!pts || !link) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Could not parse. Need at least: points + link + | + title' });
        return res.status(200).json({ ok: true });
      }
      if (!icon2) icon2 = guessIcon(link);
      let verify = 'honor';
      let note = '';
      if (link.includes('t.me/')) {
        const uname = link.split('t.me/')[1].split(/[/?#]/)[0];
        if (uname.startsWith('+')) {
          note = '\n⚠️ Private invite link — cannot auto-verify, set as honor task.';
        } else {
          verify = 'telegram:@' + uname;
          note = '\n🤖 Auto-verified: bot must be ADMIN in @' + uname;
        }
      }
      const { data: t } = await supabase.from('tasks')
        .insert({ title, icon: icon2, reward: pts, link, verify }).select().single();
      await tg('sendMessage', { chat_id: chatId,
        text: '✅ Task #' + t.id + ' added:\n\n' + title + '\n+' + pts + ' ETB • icon: ' + icon2 + '\n' + link + note });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/rmtask')) {
      const tid = parseInt(text.split(/\s+/)[1], 10);
      if (!tid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /rmtask 4' }); return res.status(200).json({ ok: true }); }
      await supabase.from('tasks').update({ active: false }).eq('id', tid);
      await tg('sendMessage', { chat_id: chatId, text: '⚪ Task #' + tid + ' hidden from the app. Restore: /undotask ' + tid });
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
        await tg('sendMessage', { chat_id: chatId, text: 'Usage:\n/review Abebe | Pays fast, love it! | 5\n(stars 1–5, optional, default 5)' });
        return res.status(200).json({ ok: true });
      }
      const stars = Math.min(5, Math.max(1, parseInt(p[2], 10) || 5));
      const { data: rv } = await supabase.from('reviews')
        .insert({ name: p[0], message: p[1], stars }).select().single();
      await tg('sendMessage', { chat_id: chatId, text: '✅ Review #' + rv.id + ' added:\n\n' + p[0] + ' — ' + '★'.repeat(stars) + '\n"' + p[1] + '"\n\nNow showing in the app. Delete: /delreview ' + rv.id });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/delreview')) {
      const rid = parseInt(text.split(/\s+/)[1], 10);
      if (!rid) { await tg('sendMessage', { chat_id: chatId, text: 'Usage: /delreview 3' }); return res.status(200).json({ ok: true }); }
      await supabase.from('reviews').delete().eq('id', rid);
      await tg('sendMessage', { chat_id: chatId, text: '🗑 Review #' + rid + ' deleted.' });
      return res.status(200).json({ ok: true });
    }

    await tg('sendMessage', { chat_id: chatId,
      text: '👑 ADMIN COMMANDS\n\n/pending — pending withdrawals\n/paid 3 — approve & notify\n/reject 3 — reject & refund (ETB + requirements)\n\n/tasks — list tasks\n/addtask 50 https://t.me/ebtry0 | Title\n/rmtask 4 — hide task\n/undotask 4 — restore task\n\n/review Name | Message | 5 — add review\n/delreview 3 — delete review' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
};
