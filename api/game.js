const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MIN_BET = 50;
const MAX_BET = 5000;
const TABLE = [
  { m: 0,   w: 52 },
  { m: 1.5, w: 20 },
  { m: 2,   w: 18 },
  { m: 3,   w: 10 }
];

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
    const { initData, bet } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const amt = Number(bet);
    if (!Number.isInteger(amt) || amt < MIN_BET) return res.status(400).json({ error: 'Minimum bet is ' + MIN_BET + ' ETB' });
    if (amt > MAX_BET) return res.status(400).json({ error: 'Maximum bet is ' + MAX_BET + ' ETB' });

    const { data: user } = await supabase.from('users')
      .select('points, spins_total').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (amt > user.points) return res.status(400).json({ error: 'Not enough balance' });

    let r = Math.random() * 100;
    let mult = 0;
    for (const o of TABLE) {
      if (r < o.w) { mult = o.m; break; }
      r -= o.w;
    }

    const win = Math.floor(amt * mult);
    const net = win - amt;
    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: net });

    // count every spin toward the withdrawal requirement
    await supabase.from('users').update({ spins_total: (user.spins_total || 0) + 1 }).eq('telegram_id', id);

    return res.status(200).json({ mult, win, balance: user.points + net });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
