// Voice announcements moved INTO the mini-app (client-side Amharic TTS).
// Kept as a no-op so existing requires in api files never crash
// and the bot stays completely silent — no voice or text messages.

module.exports = { announceVoice: async () => true };
