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
    const initData = req.headers['x-init-data'];
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const { data: user } = await supabase.from('users').select('points').eq('telegram_id', id).maybeSingle();
    const { data: refs } = await supabase.from('referrals')
      .select('referred_id, created_at').eq('referrer_id', id).order('created_at', { ascending: false });

    let referrals = [];
    if (refs && refs.length) {
      const ids = refs.map(r => r.referred_id);
      const { data: us } = await supabase.from('users').select('telegram_id, first_name').in('telegram_id', ids);
      referrals = refs.map(r => {
        const u = (us || []).find(x => x.telegram_id === r.referred_id);
        return { first_name: u ? u.first_name : null };
      });
    }
    return res.status(200).json({ points: user ? user.points : 0, referrals });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
