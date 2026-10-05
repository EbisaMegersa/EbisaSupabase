const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const METHODS = ['telebirr', 'cbe', 'paypal', 'usdt'];
const MIN_WD = 500;

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
      .select('points, first_name, username').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < MIN_WD) return res.status(400).json({ error: 'Minimum withdrawal is ' + MIN_WD + ' pts' });
    if (amt > user.points) return res.status(400).json({ error: 'Amount exceeds your balance' });
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'Choose a valid method' });
    if (!account || String(account).trim().length < 5) return res.status(400).json({ error: 'Enter your account details' });

    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: -amt });
    const { data: wd } = await supabase.from('withdrawals')
      .insert({ user_id: id, points: amt, method, account: String(account).trim() })
      .select().single();

    // 🔔 instant notification to admin
    try {
      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.ADMIN_TELEGRAM_ID,
          text: '🔔 NEW WITHDRAWAL REQUEST\n\nID: #' + wd.id +
            '\n👤 ' + (user.first_name || 'User') + (user.username ? ' (@' + user.username + ')' : '') +
            '\n💰 ' + amt + ' pts' +
            '\n💳 ' + method + ': ' + wd.account +
            '\n\n✅ Approve: /paid ' + wd.id + '\n❌ Reject: /reject ' + wd.id
        })
      });
    } catch (e) {}

    return res.status(200).json({ ok: true, balance: user.points - amt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
