export function ownerJid(number = process.env.WHATSAPP_OWNER_NUMBER) {
  if (typeof number !== 'string' || !/^\+?[1-9]\d{7,14}$/.test(number)) {
    throw new Error('Set WHATSAPP_OWNER_NUMBER to your sender number with country code (digits only, optional +).');
  }
  return `${number.replace(/^\+/, '')}@s.whatsapp.net`;
}

export function isOwnerMessage(message, allowedJid) {
  const key = message?.key;
  if (!allowedJid || key?.fromMe || !key?.remoteJid || !message.message) return false;
  // Reject group, broadcast and newsletter JIDs before considering alternate IDs.
  if (!/^[0-9]+(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.test(key.remoteJid)) return false;
  const normalize = (jid) => typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : '';
  return normalize(key.remoteJid) === allowedJid ||
    (key.remoteJid.endsWith('@lid') && normalize(key.remoteJidAlt) === allowedJid);
}
