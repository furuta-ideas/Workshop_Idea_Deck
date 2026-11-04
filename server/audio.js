export function extractTranscript(value, depth = 0) {
  if (depth > 12 || value == null) return '';
  if (typeof value === 'string') {
    const v = value.trim();
    if (v.startsWith('{') || v.startsWith('[')) {
      try {
        return extractTranscript(JSON.parse(v), depth + 1);
      } catch {}
    }
    return '';
  }
  if (Array.isArray(value))
    return value
      .map((v) => extractTranscript(v, depth + 1))
      .filter(Boolean)
      .join('\n');
  if (typeof value !== 'object') return '';
  if (value.error) return '';
  if (['error', 'failed', 'failure'].includes(value.status)) return '';
  for (const key of ['full_text', 'fullText', 'transcript', 'transcription_text', 'text']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const key of ['segments', 'utterances'])
    if (Array.isArray(value[key]) && value[key].length) {
      const s = value[key]
        .map((v) => extractTranscript(v, depth + 1))
        .filter(Boolean)
        .join('');
      if (s) return s;
    }
  for (const key of [
    'transcription',
    'result',
    'results',
    'transcriptions',
    'data',
    'content',
    'output',
    'audio_transcriptions',
  ]) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) {
      const parsed = extractTranscript(v, depth + 1);
      if (parsed) return parsed;
      if (['transcription', 'result', 'output'].includes(key) && !/^[{[]/.test(v.trim()))
        return v.trim();
    } else {
      const s = extractTranscript(v, depth + 1);
      if (s) return s;
    }
  }
  return Object.values(value)
    .filter((v) => v && typeof v === 'object')
    .map((v) => extractTranscript(v, depth + 1))
    .filter(Boolean)
    .join('\n');
}
export function audioType(mimeType) {
  const type = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return {
    type,
    extension: {
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mp4': 'm4a',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
    }[type],
  };
}
