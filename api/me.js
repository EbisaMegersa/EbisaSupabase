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

    const { data: user } = await supabase.from('users')
      .select('points, streak, last_checkin, first_name, referral_code, photo_url, ads_watched, last_ad_date, ads_total, ads_used, refs_used, spins_total, spins_used')
      .eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Not found' });

    const { data: refs } = await supabase.from('referrals')
      .select('referred_id, reward_points, created_at').eq('referrer_id', id).order('created_at', { ascending: false });

    let referrals = [];
    if (refs && refs.length) {
      const ids = refs.map(r => r.referred_id).filter(x => x !== 0);
      let us = [];
      if (ids.length) {
        const { data: urows } = await supabase.from('users')
          .select('telegram_id, first_name, photo_url').in('telegram_id', ids);
        us = urows || [];
      }
      referrals = refs.map(r => ({
        first_name: r.referred_id === 0 ? 'Bonus Referral' : ((us.find(x => x.telegram_id === r.referred_id) || {}).first_name || null),
        photo_url: r.referred_id === 0 ? null : ((us.find(x => x.telegram_id === r.referred_id) || {}).photo_url || null),
        reward: r.reward_points || 0
      }));
    }

    let pending = 0;
    const { data: invited } = await supabase.from('users').select('telegram_id').eq('referred_by', id);
    if (invited && invited.length) {
      const paidSet = new Set((refs || []).map(r => r.referred_id));
      pending = invited.filter(p => !paidSet.has(p.telegram_id)).length;
    }

    const { count: refsTotal } = await supabase.from('referrals')
      .select('id', { count: 'exact', head: true }).eq('referrer_id', id);

    const { data: activeTasks } = await supabase.from('tasks')
      .select('id, title, icon, reward, link').eq('active', true).order('id');

    const { data: tdone } = await supabase.from('task_completions').select('task_key').eq('user_id', id);

    const { data: hist } = await supabase.from('withdrawals')
      .select('points, method, status, created_at').eq('user_id', id)
      .order('created_at', { ascending: false }).limit(10);

    const { data: acts } = await supabase.from('activities')
      .select('icon, title, points, created_at').eq('user_id', id)
      .order('created_at', { ascending: false }).limit(20);

    const { data: lb } = await supabase.from('users')
      .select('telegram_id, first_name, photo_url, points')
      .order('points', { ascending: false }).limit(15);

    const { data: rev } = await supabase.from('reviews')
      .select('name, message, stars, created_at')
      .order('created_at', { ascending: false }).limit(12);

    const todayISO = new Date().toISOString().slice(0, 10);

    return res.status(200).json({
      tg_id: id,
      points: user.points,
      streak: user.streak || 0,
      last_checkin: user.last_checkin,
      first_name: user.first_name,
      referral_code: user.referral_code,
      photo_url: user.photo_url,
      ads: { watched: user.last_ad_date === todayISO ? (user.ads_watched || 0) : 0, limit: 25 },
      wd: {
        ads_total: user.ads_total || 0,
        ads_used: user.ads_used || 0,
        refs_total: refsTotal || 0,
        refs_used: user.refs_used || 0,
        spins_total: user.spins_total || 0,
        spins_used: user.spins_used || 0
      },
      tasks: activeTasks || [],
      tasks_done: (tdone || []).map(t => t.task_key),
      referrals,
      pending,
      withdrawals: hist || [],
      activities: acts || [],
      leaderboard: lb || [],
      reviews: rev || []
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
