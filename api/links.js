const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const LINK_URL = process.env.AD_LINK_URL || 'https://t.me/';
const LIMIT = 50;
const LOCK_HOURS = 12;
const LINK_REWARD = 2;

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
    const initData = req.method === 'GET' ? req.headers['x-init-data'] : (req.body || {}).initData;
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const { data: u } = await supabase.from('users')
      .select('links_watched, links_locked_until').eq('telegram_id', id).maybeSingle();
    if (!u) return res.status(404).json({ error: 'User not found' });

    let watched = u.links_watched || 0;
    let lockedUntil = u.links_locked_until || null;
    const now = Date.now();

    if (lockedUntil && new Date(lockedUntil).getTime() <= now && watched >= LIMIT) {
      watched = 0;
      lockedUntil = null;
      await supabase.from('users')
        .update({ links_watched: 0, links_locked_until: null }).eq('telegram_id', id);
    }

    if (req.method === 'GET') {
      return res.status(200).json({ watched, limit: LIMIT, lockedUntil, link: LINK_URL, reward: LINK_REWARD });
    }

    if (lockedUntil && new Date(lockedUntil).getTime() > now) {
      return res.status(400).json({ error: 'Locked — come back later', lockedUntil, watched, limit: LIMIT });
    }
    if (watched >= LIMIT) {
      lockedUntil = new Date(now + LOCK_HOURS * 3600000).toISOString();
      await supabase.from('users').update({ links_locked_until: lockedUntil }).eq('telegram_id', id);
      return res.status(400).json({ error: 'All 50 done — locked for 12 hours', lockedUntil, watched, limit: LIMIT });
    }

    watched++;
    let allDone = false;
    if (watched >= LIMIT) {
      lockedUntil = new Date(now + LOCK_HOURS * 3600000).toISOString();
      allDone = true;
    }
    await supabase.from('users')
      .update({ links_watched: watched, links_locked_until: lockedUntil }).eq('telegram_id', id);

    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: LINK_REWARD });
    try { await supabase.from('activities').insert({ user_id: id, icon: 'link', title: 'Link Task #' + watched, points: LINK_REWARD }); } catch (e) {}

    const { data: u2 } = await supabase.from('users').select('points').eq('telegram_id', id).maybeSingle();

    return res.status(200).json({
      ok: true, reward: LINK_REWARD, watched, limit: LIMIT, lockedUntil, allDone,
      link: LINK_URL, balance: (u2 && typeof u2.points === 'number') ? u2.points : null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
