/** Parse and download unencrypted, complete HLS video streams. */
export class HlsError extends Error {
  constructor(message, code = 'HLS_UNSUPPORTED') {
    super(message);
    this.name = 'HlsError';
    this.code = code;
  }
}

function attributes(value) {
  return Object.fromEntries(
    [...value.matchAll(/(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, key, item]) => [
      key,
      item.startsWith('"') ? item.slice(1, -1) : item,
    ]),
  );
}

function mediaUrl(value, base) {
  if (value.includes('{$')) {
    throw new HlsError('This playlist uses URL variables that are not supported.');
  }
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new HlsError('The playlist contains an unsupported media address.');
  }
  return url.href;
}

function byteRange(value, previousEnd) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value || '');
  if (!match) throw new HlsError('The playlist contains an invalid byte range.', 'HLS_INVALID');
  const length = Number(match[1]);
  const start = match[2] === undefined ? previousEnd : Number(match[2]);
  const end = start + length - 1;
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start)
      || start < 0 || !Number.isSafeInteger(end)) {
    throw new HlsError('The playlist contains an invalid byte range offset.', 'HLS_INVALID');
  }
  return { start, end, length };
}

/** Parse a master or media playlist. Relative addresses use its final response URL. */
export function parsePlaylist(text, url) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') {
    throw new HlsError('The server returned a page instead of an HLS playlist.', 'HLS_INVALID');
  }
  const result = { url, variants: [], renditions: [], segments: [], map: null,
    endList: false, encrypted: false, discontinuity: false, gap: false, changingMap: false };
  let pendingVariant;
  let pendingRange;
  let duration;
  let previousSegment;
  let previousMap;

  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pendingVariant) throw new HlsError('A video quality is missing its playlist URL.', 'HLS_INVALID');
      pendingVariant = attributes(line.slice(line.indexOf(':') + 1));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const rendition = attributes(line.slice(line.indexOf(':') + 1));
      if (rendition.URI) rendition.url = mediaUrl(rendition.URI, url);
      result.renditions.push(rendition);
    } else if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
      const key = attributes(line.slice(line.indexOf(':') + 1));
      if (key.METHOD !== 'NONE') result.encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const map = attributes(line.slice(line.indexOf(':') + 1));
      if (!map.URI) throw new HlsError('The MP4 initialization segment has no URL.', 'HLS_INVALID');
      const mapUrl = mediaUrl(map.URI, url);
      const range = map.BYTERANGE
        ? byteRange(map.BYTERANGE, previousMap?.url === mapUrl ? previousMap.range?.end + 1 : undefined)
        : null;
      const nextMap = { url: mapUrl, range };
      if (result.map && JSON.stringify(result.map) !== JSON.stringify(nextMap)) result.changingMap = true;
      result.map = nextMap;
      previousMap = nextMap;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingRange) throw new HlsError('A media byte range has no segment.', 'HLS_INVALID');
      pendingRange = line.slice(line.indexOf(':') + 1);
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(line.indexOf(':') + 1));
    } else if (line === '#EXT-X-ENDLIST') {
      result.endList = true;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      result.discontinuity = true;
    } else if (line === '#EXT-X-GAP') {
      result.gap = true;
    } else if (!line.startsWith('#')) {
      const segmentUrl = mediaUrl(line, url);
      if (pendingVariant) {
        const [width = 0, height = 0] = (pendingVariant.RESOLUTION || '').split('x').map(Number);
        result.variants.push({ url: segmentUrl, attributes: pendingVariant,
          pixels: (width || 0) * (height || 0),
          bandwidth: Number(pendingVariant['AVERAGE-BANDWIDTH'] || pendingVariant.BANDWIDTH) || 0,
          resolution: pendingVariant.RESOLUTION || null });
        pendingVariant = undefined;
      } else {
        const range = pendingRange
          ? byteRange(pendingRange, previousSegment?.url === segmentUrl ? previousSegment.range?.end + 1 : undefined)
          : null;
        const segment = { url: segmentUrl, range, duration: Number.isFinite(duration) ? duration : null };
        result.segments.push(segment);
        previousSegment = segment;
        pendingRange = undefined;
        duration = undefined;
      }
    }
  }
  if (pendingVariant || pendingRange) {
    throw new HlsError('The playlist ends before a media URL.', 'HLS_INVALID');
  }
  if (result.variants.length && result.segments.length) {
    throw new HlsError('The server returned an invalid mixed HLS playlist.', 'HLS_INVALID');
  }
  return result;
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Download cancelled.', 'AbortError');
}

async function getBytes(item, fetcher, signal) {
  checkAbort(signal);
  const headers = item.range ? { Range: `bytes=${item.range.start}-${item.range.end}` } : {};
  const response = await fetcher(item.url, { signal, headers });
  const data = new Uint8Array(await response.arrayBuffer());
  checkAbort(signal);
  if (!item.range) {
    if (response.status !== 200) {
      throw new HlsError(`A video segment returned HTTP ${response.status}.`, 'HLS_HTTP');
    }
    return data;
  }
  const { start, end, length } = item.range;
  if (response.status === 200 && data.byteLength > end) return data.slice(start, end + 1);
  if (response.status !== 206 || data.byteLength !== length) {
    throw new HlsError('The server did not return the requested video byte range.', 'HLS_HTTP');
  }
  const rangeHeader = response.headers.get('content-range');
  const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(rangeHeader || '');
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end) {
    throw new HlsError('The server returned a different video byte range.', 'HLS_HTTP');
  }
  return data;
}

function boxType(data) {
  return String.fromCharCode(...data.subarray(4, 8));
}

function validateSegment(data, fragmentedMp4) {
  if (fragmentedMp4) {
    if (data.byteLength < 8 || !['styp', 'sidx', 'moof', 'emsg', 'prft', 'free'].includes(boxType(data))) {
      throw new HlsError('The server returned an invalid MP4 video segment.', 'HLS_INVALID');
    }
  } else if (data.byteLength < 188 || data[0] !== 0x47 || (data.byteLength > 188 && data[188] !== 0x47)) {
    throw new HlsError('The server returned an invalid MPEG-TS video segment.', 'HLS_INVALID');
  }
}

/** Download the best complete video rendition, emitting its original bytes in order. */
export async function downloadHls(url, {
  fetcher = fetch,
  signal,
  onProgress = () => {},
  onChunk = () => {},
} = {}) {
  let selectedUrl = url;
  let resolution = null;
  let playlist;
  const visited = new Set();
  for (let depth = 0; depth < 5; depth += 1) {
    checkAbort(signal);
    if (visited.has(selectedUrl)) throw new HlsError('The playlist contains a circular video reference.');
    visited.add(selectedUrl);
    await onProgress({ phase: 'playlist', completed: 0, total: 0, bytes: 0, resolution });
    const response = await fetcher(selectedUrl, { signal, headers: {} });
    if (response.status !== 200) throw new HlsError(`The playlist returned HTTP ${response.status}.`, 'HLS_HTTP');
    const text = await response.text();
    checkAbort(signal);
    playlist = parsePlaylist(text, response.url || selectedUrl);
    if (playlist.encrypted) throw new HlsError('This video uses encrypted HLS. Choose a direct MP4 source.');
    if (!playlist.variants.length) break;
    const best = [...playlist.variants].sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth)[0];
    const hasExternalAudio = playlist.renditions.some(track => track.TYPE === 'AUDIO'
      && track['GROUP-ID'] === best.attributes.AUDIO && track.url);
    if (hasExternalAudio) {
      throw new HlsError('This stream stores audio separately. Choose a direct MP4 source.');
    }
    selectedUrl = best.url;
    resolution = best.resolution || resolution;
    playlist = undefined;
  }
  if (!playlist || playlist.variants.length) throw new HlsError('The HLS playlist has too many nested quality lists.');
  if (!playlist.endList || !playlist.segments.length) {
    throw new HlsError('This stream is live or incomplete. A complete video is required.');
  }
  if (playlist.discontinuity || playlist.gap || playlist.changingMap) {
    throw new HlsError('This stream changes format or has missing segments. Choose another player.');
  }

  const fragmentedMp4 = Boolean(playlist.map);
  let bytes = 0;
  const total = playlist.segments.length;
  if (playlist.map) {
    const init = await getBytes(playlist.map, fetcher, signal);
    if (init.byteLength < 8 || boxType(init) !== 'ftyp') {
      throw new HlsError('The server returned an invalid MP4 initialization segment.', 'HLS_INVALID');
    }
    checkAbort(signal);
    await onChunk(init);
    bytes += init.byteLength;
  }
  await onProgress({ phase: 'download', completed: 0, total, bytes, resolution });
  for (const [index, segment] of playlist.segments.entries()) {
    const data = await getBytes(segment, fetcher, signal);
    validateSegment(data, fragmentedMp4);
    checkAbort(signal);
    await onChunk(data);
    bytes += data.byteLength;
    await onProgress({ phase: 'download', completed: index + 1, total, bytes, resolution });
  }
  checkAbort(signal);
  return {
    extension: fragmentedMp4 ? 'mp4' : 'ts',
    mimeType: fragmentedMp4 ? 'video/mp4' : 'video/mp2t',
    resolution,
    segments: total,
    bytes,
  };
}
