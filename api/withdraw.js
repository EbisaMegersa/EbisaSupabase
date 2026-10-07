const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const METHODS = ['telebirr', 'mpesa', 'cbe', 'coop', 'abyssinia', 'awash', 'dashen', 'crypto', 'binance'];
const MIN_WD = 1000;
const ADS_REQUIRED = 25;        // lifetime ads consumed per withdrawal
const FRIENDS_REQUIRED = 15;    // qualified friends consumed per withdrawal

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

    const { data: user } = await supabase.from('users')
      .select('points, first_name, username, ads_total, ads_used, refs_used').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ---- withdrawal requirements: 25 ads + 15 qualified friends (consumed on request) ----
    const { count: refsTotal } = await supabase.from('referrals')
      .select('id', { count: 'exact', head: true }).eq('referrer_id', id);

    const availAds = (user.ads_total || 0) - (user.ads_used || 0);
    const availRefs = (refsTotal || 0) - (user.refs_used || 0);

    if (availAds < ADS_REQUIRED) {
      return res.status(400).json({ error: 'Withdrawal locked: watch ' + (ADS_REQUIRED - availAds) + ' more ads (' + availAds + '/' + ADS_REQUIRED + ')' });
    }
    if (availRefs < FRIENDS_REQUIRED) {
      return res.status(400).json({ error: 'Withdrawal locked: invite ' + (FRIENDS_REQUIRED - availRefs) + ' more friends who finish 3 tasks (' + availRefs + '/' + FRIENDS_REQUIRED + ')' });
    }

    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < MIN_WD) return res.status(400).json({ error: 'Minimum withdrawal is ' + MIN_WD + ' ETB' });
    if (amt > user.points) return res.status(400).json({ error: 'Amount exceeds your balance' });
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'Choose a valid method' });
    if (!account || String(account).trim().length < 5) return res.status(400).json({ error: 'Enter your account details' });

    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: -amt });
    const { data: wd } = await supabase.from('withdrawals')
      .insert({ user_id: id, points: amt, method, account: String(account).trim(), ads_c: ADS_REQUIRED, refs_c: FRIENDS_REQUIRED })
      .select().single();

    // consume the requirements
    await supabase.from('users').update({
      ads_used: (user.ads_used || 0) + ADS_REQUIRED,
      refs_used: (user.refs_used || 0) + FRIENDS_REQUIRED
    }).eq('telegram_id', id);

    await supabase.from('activities').insert({ user_id: id, icon: 'dollar', title: 'Withdrawal Request', points: -amt });

    try {
      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.ADMIN_TELEGRAM_ID,
          text: '🔔 NEW WITHDRAWAL REQUEST\n\nID: #' + wd.id +
            '\n👤 ' + (user.first_name || 'User') + (user.username ? ' (@' + user.username + ')' : '') +
            '\n💰 ' + amt + ' ETB' +
            '\n💳 ' + method + ': ' + wd.account +
            '\n📌 Used: ' + ADS_REQUIRED + ' ads + ' + FRIENDS_REQUIRED + ' friends' +
            '\n\n✅ Approve: /paid ' + wd.id + '\n❌ Reject: /reject ' + wd.id
        })
      });
    } catch (e) {}

    return res.status(200).json({ ok: true, balance: user.points - amt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
