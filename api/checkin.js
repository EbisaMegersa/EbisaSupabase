const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { announceVoice } = require('../lib/voice');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const REWARDS = [10, 30, 40, 60, 70, 80, 100];

function valid(initData) {
  if (!initData) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const str = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const t = Number(params.get('auth_date'));
  return calc === hash && t && Date.now() / 1000 - t < 86400;
}

function tgId(initData) {
  return JSON.parse(new URLSearchParams(initData).get('user') || 'null')?.id;
}

module.exports = async (req, res) => {
  try {
    const { initData } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const { data: user, error: ue } = await supabase.from('users')
      .select('last_checkin, streak').eq('telegram_id', id).maybeSingle();
    if (ue) return res.status(500).json({ error: ue.message });
    if (!user) return res.status(404).json({ error: 'User not found — reopen the app' });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    if (user.last_checkin === today) {
      return res.status(200).json({ already: true, streak: user.streak || 0 });
    }

    const streak = (user.last_checkin === yesterday) ? (user.streak || 0) + 1 : 1;
    const reward = REWARDS[Math.min(streak - 1, REWARDS.length - 1)];

    const { error: upErr } = await supabase.from('users')
      .update({ last_checkin: today, streak }).eq('telegram_id', id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    const { error: ptErr } = await supabase.rpc('add_points', { p_telegram_id: id, p_amount: reward });
    if (ptErr) return res.status(500).json({ error: ptErr.message });

    try { await supabase.from('activities').insert({ user_id: id, icon: 'check', title: 'Daily Check-in', points: reward }); } catch (e) {}

    // 🔊 Amharic voice announcement
    try { await announceVoice(id, reward + ' ብር የዕለት ሽልማት አግኝተዋል, ' + reward + ' ብር ወደ ባላንሶ ገብቷል'); } catch (e) {}

    return res.status(200).json({ ok: true, reward, streak });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
