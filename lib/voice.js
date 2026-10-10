// lib/voice.js — safe stub. Voice welcome disabled for now.
// Never throws — auth must never break because of voice.
module.exports = {
  announceVoice: async function announceVoice(userId, text) {
    try {
      console.log('[voice] skipped for', userId, ':', text);
      return false;
    } catch (e) { return false; }
  }
};
