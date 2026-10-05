const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const AD_REWARD = 15;
const DAILY_LIMIT = 10;

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
      .select('ads_watched, last_ad_date').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = new Date().toISOString().slice(0, 10);
    const watched = (user.last_ad_date === today) ? (user.ads_watched || 0) : 0;

    if (watched >= DAILY_LIMIT) {
      return res.status(400).json({ error: 'Daily limit reached — come back tomorrow', watched, limit: DAILY_LIMIT });
    }

    const newWatched = watched + 1;
    await supabase.from('users')
      .update({ ads_watched: newWatched, last_ad_date: today }).eq('telegram_id', id);
    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: AD_REWARD });

    const { data: u2 } = await supabase.from('users').select('points').eq('telegram_id', id).maybeSingle();

    return res.status(200).json({ ok: true, reward: AD_REWARD, watched: newWatched, limit: DAILY_LIMIT, balance: u2.points });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
