const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { announceVoice } = require('../lib/voice');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const REQUIRED_TASKS = 3;   // invitee must complete ANY 3 tasks
const REF_REWARD = 50;      // referrer earns 50 ETB per qualified friend

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
    const { initData, task } = req.body || {};
    if (!valid(initData)) return res.status(401).json({ error: 'Unauthorized' });
    const id = tgId(initData);

    const { data: taskRow } = await supabase.from('tasks')
      .select('*').eq('id', Number(task)).eq('active', true).maybeSingle();
    if (!taskRow) return res.status(400).json({ error: 'Unknown task' });

    const { data: done } = await supabase.from('task_completions')
      .select('id').eq('user_id', id).eq('task_key', String(taskRow.id)).maybeSingle();
    if (done) return res.status(400).json({ error: 'Task already completed' });

    if (taskRow.verify && taskRow.verify.startsWith('telegram:')) {
      const chat = taskRow.verify.split(':')[1];
      const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN +
        '/getChatMember?chat_id=' + encodeURIComponent(chat) + '&user_id=' + id);
      const j = await r.json();
      const status = j.ok ? j.result.status : null;
      const joined = ['creator', 'administrator', 'member', 'restricted'].includes(status);
      if (!joined) return res.status(400).json({ error: 'You must join first! Tap Start, join, then Verify.' });
    }

    await supabase.from('task_completions').insert({
      user_id: id, task_key: String(taskRow.id), reward: taskRow.reward
    });
    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: taskRow.reward });
    try { await supabase.from('activities').insert({ user_id: id, icon: 'check', title: taskRow.title, points: taskRow.reward }); } catch (e) {}

    // 🔊 Amharic voice for the task reward itself
    try { await announceVoice(id, taskRow.reward + ' ብር መስራት ችለዋል, ' + taskRow.reward + ' ብር ወደ ባላንሶ ገብቷል'); } catch (e) {}

    // ---- qualified referral: ANY 3 tasks completed ----
    const { count: doneCount } = await supabase.from('task_completions')
      .select('id', { count: 'exact', head: true }).eq('user_id', id);

    if (doneCount >= REQUIRED_TASKS) {
      const { data: me2 } = await supabase.from('users')
        .select('referred_by, first_name').eq('telegram_id', id).maybeSingle();

      if (me2 && me2.referred_by) {
        const { data: already } = await supabase.from('referrals')
          .select('id').eq('referred_id', id).maybeSingle();

        if (!already) {
          await supabase.from('referrals').insert({
            referrer_id: me2.referred_by, referred_id: id, reward_points: REF_REWARD
          });
          await supabase.rpc('add_points', { p_telegram_id: me2.referred_by, p_amount: REF_REWARD });
          try { await supabase.from('activities').insert({
            user_id: me2.referred_by, icon: 'userplus', title: 'Friend Invite Bonus', points: REF_REWARD
          }); } catch (e) {}

          // 🔊 Amharic voice for the referrer
          try { await announceVoice(me2.referred_by, 'ጓደኛዎ 3 ተግባራትን አጠናቋል, 50 ብር ወደ ባላንሶ ገብቷል'); } catch (e) {}

          try {
            await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: me2.referred_by,
                text: '🎉 ' + (me2.first_name || 'Your friend') + ' completed 3 tasks!\n💰 Your +' + REF_REWARD + ' ETB referral reward has been added.'
              })
            });
          } catch (e) {}
        }
      }
    }

    return res.status(200).json({ ok: true, reward: taskRow.reward });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
