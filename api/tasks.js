const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TASKS = {
  channel: { chat: '@ebtry0', reward: 50, verify: 'telegram' },
  group:   { chat: '@ebatest', reward: 50, verify: 'telegram' },
  x:       { reward: 50, verify: 'honor' } // X API costs $100+/mo, so trust-based
};

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

    const conf = TASKS[task];
    if (!conf) return res.status(400).json({ error: 'Unknown task' });

    const { data: done } = await supabase.from('task_completions')
      .select('id').eq('user_id', id).eq('task_key', task).maybeSingle();
    if (done) return res.status(400).json({ error: 'Task already completed' });

    if (conf.verify === 'telegram') {
      const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN +
        '/getChatMember?chat_id=' + encodeURIComponent(conf.chat) + '&user_id=' + id);
      const j = await r.json();
      const status = j.ok ? j.result.status : null;
      const joined = ['creator', 'administrator', 'member', 'restricted'].includes(status);
      if (!joined) return res.status(400).json({ error: 'You must join first! Tap Start, join, then Verify.' });
    }

    await supabase.from('task_completions').insert({ user_id: id, task_key: task, reward: conf.reward });
    await supabase.rpc('add_points', { p_telegram_id: id, p_amount: conf.reward });
    return res.status(200).json({ ok: true, reward: conf.reward });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
