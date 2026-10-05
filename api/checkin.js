const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const REWARDS = [10, 15, 20, 25, 30, 35, 50];

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

    const { data: user } = await supabase.from('users')
      .select('last_checkin, streak').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    if (user.last_checkin === today) {
      return res.status(200).json({ already: true, streak: user.streak || 0 });
    }

    const streak = (user.last_checkin === yesterday) ? (user.streak || 0) + 1 : 1;
    const reward = REWARDS[Math.min(streak - 1, REWARDS.length - 1)];

    await supabase.from('users').update({ last_checkin: today, streak }).eq('telegram_id', id);
    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: reward });

    return res.status(200).json({ already: false, reward, streak });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
