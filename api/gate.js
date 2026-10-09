const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const GATE_CHATS = { channel: '@ebtry0', group: '@ebatest' };
const REF_REWARD = 50;

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
    const { initData, step } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const chat = GATE_CHATS[step];
    if (!chat) return res.status(400).json({ error: 'Unknown step' });

    const { data: user } = await supabase.from('users')
      .select('referred_by, gate_done').eq('telegram_id', id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const key = 'gate_' + step;

    // verify membership (or accept previous completion)
    const { data: already } = await supabase.from('task_completions')
      .select('id').eq('user_id', id).eq('task_key', key).maybeSingle();

    if (!already) {
      const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN +
        '/getChatMember?chat_id=' + encodeURIComponent(chat) + '&user_id=' + id);
      const j = await r.json();
      const status = j.ok ? j.result.status : null;
      const joined = ['creator', 'administrator', 'member', 'restricted'].includes(status);
      if (!joined) return res.status(400).json({ error: 'You must join first! Tap Join, join, then Verify.' });
      await supabase.from('task_completions').insert({ user_id: id, task_key: key, reward: 0 });
    }

    // recompute both steps
    const { data: comps } = await supabase.from('task_completions')
      .select('task_key').eq('user_id', id).in('task_key', ['gate_channel', 'gate_group']);
    const channelDone = (comps || []).some(c => c.task_key === 'gate_channel');
    const groupDone = (comps || []).some(c => c.task_key === 'gate_group');
    const gateDone = channelDone && groupDone;

    if (gateDone && !user.gate_done) {
      await supabase.from('users').update({ gate_done: true }).eq('telegram_id', id);

      // 🎉 referral counts NOW (no 3-task rule anymore)
      if (user.referred_by) {
        const { data: alreadyRef } = await supabase.from('referrals')
          .select('id').eq('referred_id', id).maybeSingle();
        if (!alreadyRef) {
          await supabase.from('referrals').insert({
            referrer_id: user.referred_by, referred_id: id, reward_points: REF_REWARD
          });
          await supabase.rpc('add_points', { p_telegram_id: user.referred_by, p_amount: REF_REWARD });
          try { await supabase.from('activities').insert({
            user_id: user.referred_by, icon: 'userplus', title: 'Friend Invite Bonus', points: REF_REWARD
          }); } catch (e) {}
          try {
            await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: user.referred_by,
                text: '🎉 Your friend joined & verified!\n💰 Your +' + REF_REWARD + ' ETB referral reward has been added.'
              })
            });
          } catch (e) {}
        }
      }
    }

    return res.status(200).json({ ok: true, gateDone, channel: channelDone, group: groupDone });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
