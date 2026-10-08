const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { announceVoice } = require('../lib/voice');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MAX_PER_IP = 2;      // ⬅️ max accounts allowed per IP/device (raise to 3-4 if innocent users get locked)

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

function tgUser(initData) {
  return JSON.parse(new URLSearchParams(initData).get('user') || 'null');
}

module.exports = async (req, res) => {
  try {
    const { initData, startParam, deviceId } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });

    const u = tgUser(initData);
    if (!u || !u.id) return res.status(400).json({ error: 'No user' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const did = deviceId ? String(deviceId).slice(0, 64) : null;

    let { data: user } = await supabase.from('users').select('*').eq('telegram_id', u.id).maybeSingle();

    if (user) {
      await supabase.from('users').update({
        photo_url: u.photo_url || null,
        first_name: u.first_name || 'Friend',
        username: u.username || null,
        last_ip: ip,
        device_id: did || user.device_id
      }).eq('telegram_id', u.id);
      return res.status(200).json({ user, isNew: false });
    }

    // ---- NEW registration: enforce IP + device limits ----
    const { count: ipCount } = await supabase.from('users')
      .select('id', { count: 'exact', head: true }).eq('last_ip', ip);
    const { count: devCount } = did
      ? await supabase.from('users').select('id', { count: 'exact', head: true }).eq('device_id', did)
      : { count: 0 };

    if (ipCount >= MAX_PER_IP || devCount >= MAX_PER_IP) {
      return res.status(403).json({
        error: 'MULTI_ACCOUNT',
        message: 'Multiple accounts detected by IP. This device or network already has the maximum number of registered accounts (' + MAX_PER_IP + ').'
      });
    }

    const { data: newUser, error } = await supabase.from('users').insert({
      telegram_id: u.id,
      first_name: u.first_name || 'Friend',
      username: u.username || null,
      photo_url: u.photo_url || null,
      referral_code: crypto.randomBytes(4).toString('hex'),
      points: 25,
      last_ip: ip,
      device_id: did
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    user = newUser;

    try { await supabase.from('activities').insert({ user_id: u.id, icon: 'star', title: 'Welcome Bonus', points: 25 }); } catch (e) {}

    // 🔊 Amharic voice welcome
    try { await announceVoice(u.id, 'እንኳን ደህና መጡ, 25 ብር ስጦታ ወደ ባላንሶ ገብቷል'); } catch (e) {}

    if (startParam) {
      const { data: referrer } = await supabase.from('users')
        .select('telegram_id').eq('referral_code', startParam).maybeSingle();
      if (referrer && referrer.telegram_id !== u.id) {
        await supabase.from('users').update({ referred_by: referrer.telegram_id }).eq('telegram_id', u.id);
      }
    }

    return res.status(200).json({ user, isNew: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
