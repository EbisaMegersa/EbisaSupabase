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
    const { initData, startParam } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);
    if (!id) return res.status(400).json({ error: 'No user' });

    let { data: user } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
    if (user) return res.status(200).json({ user });

    const { data: newUser, error } = await supabase.from('users').insert({
      telegram_id: id,
      first_name: 'Friend',
      referral_code: crypto.randomBytes(4).toString('hex'),
      points: 25
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    user = newUser;

    if (startParam) {
      const { data: referrer } = await supabase.from('users')
        .select('telegram_id').eq('referral_code', startParam).maybeSingle();
      if (referrer && referrer.telegram_id !== id) {
        await supabase.from('users').update({ referred_by: referrer.telegram_id }).eq('telegram_id', id);
        await supabase.rpc('add_points', { p_telegram_id: referrer.telegram_id, p_amount: 100 });
        await supabase.from('referrals').insert({
          referrer_id: referrer.telegram_id, referred_id: id, reward_points: 100
        });
      }
    }
    return res.status(200).json({ user });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
