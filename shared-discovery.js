(function (root) {
  'use strict';

  function normalizeUrl(value, baseUrl) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, baseUrl);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function mediaKind(url, type) {
    if (/mpegurl/i.test(type || '') || /\.m3u8(?:[?#]|$)/i.test(url || '')) return 'hls';
    if (/^video\/mp4$/i.test(type || '') || /\.mp4(?:[?#]|$)/i.test(url || '')) return 'mp4';
    return null;
  }

  function deriveGarpfHls(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/pinaytg\/([A-Za-z0-9_-]+)\/?$/);
      if (url.hostname !== 'garpf.com' || !match) return null;
      return 'https://cdn.pinaytg.com/' + match[1] + '/master.m3u8';
    } catch {
      return null;
    }
  }

  function isCleanTubeFrame(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:'
        && (url.hostname === 'lootedpinay.com' || url.hostname.endsWith('.lootedpinay.com'))
        && url.pathname === '/wp-content/plugins/clean-tube-player/public/player-x.php';
    } catch { return false; }
  }

  function cleanTubeSources(value) {
    if (!isCleanTubeFrame(value)) return [];
    const url = new URL(value);
    const encoded = url.searchParams.get('q');
    if (!encoded || encoded.length > 60_000) return [];
    let markup;
    try {
      const metadata = atob(encoded.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/'));
      markup = new URLSearchParams(metadata).get('tag') || '';
    } catch { return []; }

    // Read the embedded player descriptor as data. Never insert it into the page.
    return [...markup.matchAll(/<(?:video|source)\b([^>]*)>/gi)].flatMap(([, tag]) => {
      const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g)]
        .map(([, key, double, single, bare]) => [key.toLowerCase(), double ?? single ?? bare]));
      const source = normalizeUrl(attributes.src?.replace(/&amp;|&#38;/gi, '&'), url.href);
      const kind = mediaKind(source, attributes.type);
      return source && kind ? [{ url: source, kind }] : [];
    });
  }

  function parseSources(scriptText) {
    const push = scriptText.match(/self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/);
    let content = scriptText;
    if (push) {
      try { content = JSON.parse(push[1])[1]; }
      catch { return []; }
    }
    if (typeof content !== 'string') return [];
    return Array.from(content.matchAll(/"sources"\s*:\s*(\[\s*\{[^\[\]]*\}\s*\])/g)).flatMap(match => {
      try {
        const sources = JSON.parse(match[1]);
        if (!sources.some(source => source && /^Player \d+$/.test(source.label || '') && source.embedUrl)) return [];
        return [sources.filter(source => source && typeof source.embedUrl === 'string')];
      } catch {
        return [];
      }
    });
  }

  function chooseMainVideo(document) {
    const videos = Array.from(document.querySelectorAll('video')).filter(video => {
      return !video.closest('[data-streamlift-ui], [data-ad], .advertisement, .video-ad, #ad-player, .fluid_ad_video');
    });
    return videos.sort((left, right) => {
      const score = video => {
        const bounds = video.getBoundingClientRect();
        const area = bounds.width * bounds.height || Number(video.width || 0) * Number(video.height || 0);
        return (video.closest('#player') ? 100000000 : 0) + area;
      };
      return score(right) - score(left);
    })[0] || null;
  }

  function discover(document, location) {
    const pageUrl = location.href;
    const sources = [];
    const frames = Array.from(document.querySelectorAll('iframe[src]'));
    const playerFrame = frames.find(frame => deriveGarpfHls(frame.src)) || null;
    const cleanTubeFrames = frames.filter(frame => isCleanTubeFrame(frame.src));
    const cleanTubeFrame = cleanTubeFrames[0];
    const mainVideo = chooseMainVideo(document);
    const videoUrls = mainVideo ? [mainVideo.currentSrc, mainVideo.src,
      ...Array.from(mainVideo.querySelectorAll('source[src]'), source => source.src)] : [];
    const groups = Array.from(document.scripts || []).flatMap(script => parseSources(script.textContent || ''));
    const matchingGroups = groups.filter(group => group.some(source => {
      const url = normalizeUrl(source.embedUrl, pageUrl);
      return url === playerFrame?.src || videoUrls.includes(url);
    }));
    const group = matchingGroups.at(-1) || groups.at(-1) || [];

    function add(value, kind, label, embedUrl) {
      const url = normalizeUrl(value, pageUrl);
      if (!url || !kind) return;
      const existing = sources.find(source => source.url === url);
      if (existing) {
        if (/^Player \d+$/.test(label || '')) existing.label = label;
        return;
      }
      sources.push({ url, kind, label: label || (kind === 'mp4' ? 'MP4 video' : 'HLS video'), sourcePageUrl: pageUrl,
        ...(embedUrl ? { embedUrl } : {}) });
    }

    for (const source of group) {
      const embedUrl = normalizeUrl(source.embedUrl, pageUrl);
      const hls = deriveGarpfHls(embedUrl);
      if (hls) add(hls, 'hls', source.label, embedUrl);
      else add(embedUrl, mediaKind(embedUrl, source.type === 'mp4' ? 'video/mp4' : ''), source.label);
    }

    if (playerFrame) add(deriveGarpfHls(playerFrame.src), 'hls', 'Current player', playerFrame.src);
    for (const [index, frame] of cleanTubeFrames.entries()) {
      for (const source of cleanTubeSources(frame.src)) {
        add(source.url, source.kind, 'Player ' + (index + 1), frame.src);
      }
    }
    for (const source of cleanTubeSources(pageUrl)) add(source.url, source.kind, 'Player 1', pageUrl);
    const ownHls = deriveGarpfHls(pageUrl);
    if (ownHls) add(ownHls, 'hls', 'Player 1', pageUrl);

    if (mainVideo) {
      for (const source of mainVideo.querySelectorAll('source[src]')) {
        add(source.src, mediaKind(source.src, source.type), 'Current player');
      }
      add(mainVideo.currentSrc || mainVideo.src, mediaKind(mainVideo.currentSrc || mainVideo.src), 'Current player');
    }

    const directFrame = frames.find(frame => mediaKind(frame.src));
    if (directFrame) add(directFrame.src, mediaKind(directFrame.src), 'Current player');
    const title = (document.querySelector('h1')?.textContent || document.title || 'video').trim();
    const frameUrls = [...new Set(frames.map(frame => normalizeUrl(frame.src, pageUrl)).filter(Boolean))].slice(0, 30);
    const embed = playerFrame || cleanTubeFrame || directFrame;
    return { sources, title, frameUrls, selectedEmbedUrl: embed?.src || null,
      anchor: embed || mainVideo };
  }

  const api = { normalizeUrl, mediaKind, deriveGarpfHls, cleanTubeSources, parseSources, chooseMainVideo, discover };
  root.VideoDiscovery = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
