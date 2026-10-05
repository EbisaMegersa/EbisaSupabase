const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

    const { data: user } = await supabase.from('users').select('points').eq('telegram_id', id).maybeSingle();
    if (!user || user.points < 500) return res.status(400).json({ error: 'You need 500 points to withdraw' });

    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: -500 });
    await supabase.from('withdrawals').insert({ user_id: id, points: 500 });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
