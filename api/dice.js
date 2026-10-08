const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { announceVoice } = require('../lib/voice');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MIN_BET = 50;
const MAX_BET = 5000;
const DICE_MULT = 5; // match pays 5x (change to 6 for fully fair odds)

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
    const { initData, bet, pick } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const p = Number(pick);
    if (!Number.isInteger(p) || p < 1 || p > 6) return res.status(400).json({ error: 'Pick a number 1–6' });

    const amt = Number(bet);
    if (!Number.isInteger(amt) || amt < MIN_BET) return res.status(400).json({ error: 'Minimum bet is ' + MIN_BET + ' ETB' });
    if (amt > MAX_BET) return res.status(400).json({ error: 'Maximum bet is ' + MAX_BET + ' ETB' });

    const { data: user } = await supabase.from('users').select('points').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (amt > user.points) return res.status(400).json({ error: 'Not enough balance' });

    const roll = 1 + Math.floor(Math.random() * 6);
    const match = roll === p;
    const win = match ? amt * DICE_MULT : 0;
    const net = win - amt;

    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: net });

    if (match) {
      try { await announceVoice(id, win + ' ብር አሸነፉ, ' + win + ' ብር ወደ ባላንሶ ገብቷል'); } catch (e) {}
      try { await supabase.from('activities').insert({ user_id: id, icon: 'star', title: 'Dice Win', points: net }); } catch (e) {}
    }

    return res.status(200).json({ roll, match, win, balance: user.points + net });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
