/** ISO 639-2/T tags accepted by the muxer. Unknown BCP47 tags remain undetermined,
 * not a guessed language; the original tag is retained in the selected track DTO. */
const ISO_639_2: Readonly<Record<string, string>> = {
  ar: 'ara', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'ces', cy: 'cym', da: 'dan', de: 'deu',
  el: 'ell', en: 'eng', es: 'spa', et: 'est', eu: 'eus', fa: 'fas', fi: 'fin', fr: 'fra',
  ga: 'gle', gl: 'glg', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', hy: 'hye', id: 'ind',
  is: 'isl', it: 'ita', ja: 'jpn', ka: 'kat', kk: 'kaz', ko: 'kor', lt: 'lit', lv: 'lav',
  mk: 'mkd', ms: 'msa', mt: 'mlt', nb: 'nob', nl: 'nld', nn: 'nno', no: 'nor', pl: 'pol',
  pt: 'por', ro: 'ron', ru: 'rus', sk: 'slk', sl: 'slv', sq: 'sqi', sr: 'srp', sv: 'swe',
  ta: 'tam', te: 'tel', th: 'tha', tr: 'tur', uk: 'ukr', ur: 'urd', uz: 'uzb', vi: 'vie',
  zh: 'zho',
};
export function muxLanguage(tag: string | undefined): string {
  const primary = tag?.toLowerCase().split('-')[0] ?? '';
  return ISO_639_2[primary] ?? (/^[a-z]{3}$/.test(primary) ? primary : 'und');
}
