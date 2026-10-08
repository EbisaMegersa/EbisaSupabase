const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Sends Amharic TTS as an audio message. Falls back to a text message if TTS fails.
async function announceVoice(chatId, amText) {
  try {
    const q = encodeURIComponent(amText);
    const ttsUrl = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=am&q=' + q;
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendAudio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, audio: ttsUrl, title: 'ማስታወቂያ', performer: 'EarnApp' })
    });
    const j = await r.json();
    if (j.ok) return true;
  } catch (e) {}
  try {
    await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '🔊 ' + amText })
    });
  } catch (e) {}
  return false;
}

module.exports = { announceVoice };
