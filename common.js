export const busyStates = new Set(['starting', 'downloading', 'saving']);

export function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 16000) throw new Error('Invalid video address.');
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host === '[::1]' || host === '[::]' || host.startsWith('[fc') || host.startsWith('[fd')
      || host.startsWith('[fe80:') || host.startsWith('[::ffff:')
      || /^(?:0|10|127)\./.test(host) || /^169\.254\./.test(host)
      || /^192\.168\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('This video address is unsupported.');
  }
  return url.href;
}

export function supportedPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'garpf.com'
      || ['pinaytg.com', 'lootedpinay.com'].some(domain => url.hostname === domain
        || url.hostname.endsWith('.' + domain)));
  } catch { return false; }
}

export function filenameFor(title, extension) {
  const name = String(title || 'video').normalize('NFC')
    .replace(/\s*-\s*(?:PinayTG|LootedPinay).*$/i, '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 140) || 'video';
  const safe = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
  return safe + '.' + extension;
}

export function originPattern(value) {
  return new URL(publicUrl(value)).origin + '/*';
}
