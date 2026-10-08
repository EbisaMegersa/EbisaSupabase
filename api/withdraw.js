const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const METHODS = ['telebirr', 'mpesa', 'cbe', 'coop', 'abyssinia', 'awash', 'dashen', 'crypto', 'binance'];
const MIN_WD = 1000;
const ADS_REQUIRED = 25;
const FRIENDS_REQUIRED = 15;
const SPINS_REQUIRED = 10;

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
    const { initData, amount, method, account } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const { data: user, error: uErr } = await supabase.from('users')
      .select('points, first_name, username, ads_total, ads_used, refs_used, spins_total, spins_used')
      .eq('telegram_id', id).maybeSingle();
    if (uErr) return res.status(500).json({ error: uErr.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { count: refsTotal, error: refErr } = await supabase.from('referrals')
      .select('id', { count: 'exact', head: true }).eq('referrer_id', id);
    if (refErr) return res.status(500).json({ error: refErr.message });

    const availAds = (user.ads_total || 0) - (user.ads_used || 0);
    const availRefs = (refsTotal || 0) - (user.refs_used || 0);
    const availSpins = (user.spins_total || 0) - (user.spins_used || 0);

    if (availAds < ADS_REQUIRED) {
      return res.status(400).json({ error: 'Withdrawal locked: watch ' + (ADS_REQUIRED - availAds) + ' more ads (' + availAds + '/' + ADS_REQUIRED + ')' });
    }
    if (availRefs < FRIENDS_REQUIRED) {
      return res.status(400).json({ error: 'Withdrawal locked: invite ' + (FRIENDS_REQUIRED - availRefs) + ' more friends who finish 3 tasks (' + availRefs + '/' + FRIENDS_REQUIRED + ')' });
    }
    if (availSpins < SPINS_REQUIRED) {
      return res.status(400).json({ error: 'Withdrawal locked: spin the wheel ' + (SPINS_REQUIRED - availSpins) + ' more times (' + availSpins + '/' + SPINS_REQUIRED + ')' });
    }

    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < MIN_WD) return res.status(400).json({ error: 'Minimum withdrawal is ' + MIN_WD + ' ETB' });
    if (amt > user.points) return res.status(400).json({ error: 'Amount exceeds your balance' });
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'Choose a valid method' });
    if (!account || String(account).trim().length < 5) return res.status(400).json({ error: 'Enter your account details' });

    // ---- 1) create the withdrawal record FIRST.
    // if this fails, we stop here: no points lost, user sees the real reason.
    const { data: wd, error: insErr } = await supabase.from('withdrawals')
      .insert({
        user_id: id, points: amt, method, account: String(account).trim(),
        ads_c: ADS_REQUIRED, refs_c: FRIENDS_REQUIRED, spins_c: SPINS_REQUIRED
      })
      .select().single();

    if (insErr || !wd) {
      return res.status(500).json({ error: 'Could not save your request: ' + (insErr ? insErr.message : 'unknown error') });
    }

    // ---- 2) deduct points. if this somehow fails, undo the record so nothing is stuck.
    const { error: ptErr } = await supabase.rpc('add_points', { p_telegram_id: id, p_amount: -amt });
    if (ptErr) {
      await supabase.from('withdrawals').delete().eq('id', wd.id);
      return res.status(500).json({ error: ptErr.message });
    }

    // ---- 3) consume the requirements
    await supabase.from('users').update({
      ads_used: (user.ads_used || 0) + ADS_REQUIRED,
      refs_used: (user.refs_used || 0) + FRIENDS_REQUIRED,
      spins_used: (user.spins_used || 0) + SPINS_REQUIRED
    }).eq('telegram_id', id);

    // ---- 4) activity log — must never break the flow
    try { await supabase.from('activities').insert({ user_id: id, icon: 'dollar', title: 'Withdrawal Request', points: -amt }); } catch (e) {}

    // ---- 5) notify admin — report honestly if it failed
    let adminNotified = false;
    let adminNote = '';
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!adminId || !/^-?\d+$/.test(String(adminId).trim())) {
      adminNote = 'ADMIN_TELEGRAM_ID missing or not numeric in Vercel env vars';
    } else {
      try {
        const resp = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: Number(String(adminId).trim()),
            text: '🔔 NEW WITHDRAWAL REQUEST\n\nID: #' + wd.id +
              '\n👤 ' + (user.first_name || 'User') + (user.username ? ' (@' + user.username + ')' : '') +
              '\n💰 ' + amt + ' ETB' +
              '\n💳 ' + method + ': ' + wd.account +
              '\n📌 Used: ' + ADS_REQUIRED + ' ads + ' + FRIENDS_REQUIRED + ' friends + ' + SPINS_REQUIRED + ' spins' +
              '\n\n✅ Approve: /paid ' + wd.id + '\n❌ Reject: /reject ' + wd.id
          })
        });
        const j = await resp.json();
        adminNotified = j.ok === true;
        if (!adminNotified) adminNote = 'Telegram said: ' + ((j.description || '').slice(0, 120));
      } catch (e) {
        adminNote = 'Network error contacting Telegram';
      }
    }

    return res.status(200).json({
      ok: true,
      balance: user.points - amt,
      wdId: wd.id,
      adminNotified,
      adminNote
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
