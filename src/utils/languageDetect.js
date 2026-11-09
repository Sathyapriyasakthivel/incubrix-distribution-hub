/**
 * Lightweight, deterministic language detector for catalogue import.
 * Identifies language from text based on character scripts and common linguistic stop patterns.
 * Never invents, falls back to 'en'.
 *
 * @param {string} text - Text to analyze
 * @returns {string} ISO 639-1 two-letter language code ('en', 'es', 'fr', 'de', 'zh', 'ja', 'ru', 'pt', 'it')
 */
export function detectLanguage(text) {
  if (!text || typeof text !== 'string') {
    return 'en';
  }

  const str = text.trim();
  if (!str) return 'en';

  // Check Unicode character blocks
  if (/[\u4e00-\u9fff]/.test(str)) {
    return 'zh';
  }
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(str)) {
    return 'ja';
  }
  if (/[\u0400-\u04ff]/.test(str)) {
    return 'ru';
  }

  const lower = str.toLowerCase();

  // German markers
  const deWords = /\b(der|die|das|und|f[üu]r|k[üu]nstliche|intelligenz|entwickler|gemeinschaft|nicht)\b/i;
  // French markers
  const frWords = /\b(le|la|les|des|du|dans|pour|communaut[ée]|d[ée]veloppeurs|francophone|avec|une)\b/i;
  // Spanish markers
  const esWords = /\b(el|la|los|las|en|por|para|comunidad|espa[ñn]ol|programadores|inteligencia|desarrollo)\b/i;
  // Portuguese markers
  const ptWords = /\b(comunidade|desenvolvedores|para|com|em|n[ãa]o|uma|sobre|intelig[êe]ncia)\b/i;
  // Italian markers
  const itWords = /\b(della|delle|degli|per|comunit[àa]|sviluppatori|intelligenza|con|nel)\b/i;

  let deScore = (lower.match(new RegExp(deWords, 'g')) || []).length;
  let frScore = (lower.match(new RegExp(frWords, 'g')) || []).length;
  let esScore = (lower.match(new RegExp(esWords, 'g')) || []).length;
  let ptScore = (lower.match(new RegExp(ptWords, 'g')) || []).length;
  let itScore = (lower.match(new RegExp(itWords, 'g')) || []).length;

  if (deScore > 0 && deScore >= Math.max(frScore, esScore, ptScore, itScore)) return 'de';
  if (frScore > 0 && frScore >= Math.max(deScore, esScore, ptScore, itScore)) return 'fr';
  if (esScore > 0 && esScore >= Math.max(deScore, frScore, ptScore, itScore)) return 'es';
  if (ptScore > 0 && ptScore >= Math.max(deScore, frScore, esScore, itScore)) return 'pt';
  if (itScore > 0 && itScore >= Math.max(deScore, frScore, esScore, ptScore)) return 'it';

  return 'en';
}

export default detectLanguage;
