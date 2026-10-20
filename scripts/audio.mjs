/** Portable byte inspection: also embedded in the client script by the builder. */
export function sniffAudio(bytes) {
  if (!bytes || bytes.length < 4) return null
  const text = (offset, size) => String.fromCharCode(...Array.prototype.slice.call(bytes, offset, offset + size))
  if (bytes.length >= 10 && text(0, 3) === 'ID3' && bytes[3] >= 2 && bytes[3] < 5 && bytes[4] < 255 &&
    [6, 7, 8, 9].every(i => bytes[i] < 128)) return 'mp3(ID3)'
  if (bytes[0] === 255 && (bytes[1] & 246) === 240 && bytes.length >= 7 &&
    (bytes[2] >> 2 & 15) < 13) return 'aac'
  if (bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] >> 3 & 3) !== 1 &&
    (bytes[1] >> 1 & 3) !== 0 && (bytes[2] >> 4) !== 15 && (bytes[2] >> 4) !== 0 &&
    (bytes[2] >> 2 & 3) !== 3) return 'mp3(frame)'
  if (text(0, 4) === 'fLaC') return 'flac'
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') return 'wav'
  if (bytes.length >= 16 && text(4, 4) === 'ftyp') {
    const brands = []
    const boxSize = (bytes[0] * 16777216) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]
    for (let i = 8; i + 4 <= Math.min(boxSize, bytes.length); i += 4) {
      if (i !== 12) brands.push(text(i, 4))
    }
    if (brands.some(b => ['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B '].includes(b))) return 'm4a'
  }
  if (bytes.length >= 28 && text(0, 4) === 'OggS') {
    const offset = 27 + bytes[26]
    if (text(offset, 8) === 'OpusHead' || text(offset + 1, 6) === 'vorbis' ||
      text(offset, 8) === 'Speex   ' || text(offset + 1, 4) === 'FLAC') return 'ogg'
  }
  return null
}

export function qualityMatchesAudio(quality, magic, bytes) {
  if (quality !== 'flac' && quality !== 'flac24bit') return true
  if (magic !== 'flac' || bytes.length < 42 || (bytes[4] & 127) !== 0 ||
    bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 34) return false
  const bitsPerSample = (((bytes[20] & 1) << 4) | (bytes[21] >> 4)) + 1
  return quality === 'flac' || bitsPerSample >= 24
}

export function audioContentTypeAllowed(contentType) {
  return !/(?:^|\W)(?:text\/|video\/|application\/(?:json|[^;]*\+json|xml|[^;]*\+xml|javascript))/.test(contentType)
}
