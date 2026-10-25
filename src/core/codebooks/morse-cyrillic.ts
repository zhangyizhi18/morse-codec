import type { Codebook } from '../types';
import { buildCodebook } from '../codebook';

/**
 * 俄语摩斯电码（西里尔字母）
 * 依据 ГОСТ 2.619-72 / 国际通用的俄语摩斯码表。
 * 部分字母与拉丁共用码字，故西里尔表为独立码表以保证解码正确性。
 */
export const MORSE_CYRILLIC = buildCodebook({
  id: 'ru',
  name: 'Russian Morse (Cyrillic)',
  displayName: '俄语摩斯电码（西里尔）',
  system: 'morse',
  direction: 'bidirectional',
  version: '1.0.0',
  source: 'ГОСТ 2.619-72 / ITU-R M.1677-1 (Cyrillic)',
  license: 'public-domain',
  entries: {
    А: '.-', Б: '-...', В: '.--', Г: '--.', Д: '-..', Е: '.', Ж: '...-',
    З: '--..', И: '..', Й: '.---', К: '-.-', Л: '.-..', М: '--', Н: '-.',
    О: '---', П: '.--.', Р: '.-.', С: '...', Т: '-', У: '..-', Ф: '..-.',
    Х: '....', Ц: '-.-.', Ч: '---.', Ш: '----', Щ: '--.-', Ъ: '--.--',
    Ы: '-.--', Ь: '-..-', Э: '..-..', Ю: '..--', Я: '.-.-',
  },
});
