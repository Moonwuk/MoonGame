// Tiny prototype i18n. ONE LOCALE = ONE FILE (see ./locale/*): the msgid is the
// CANONICAL RUSSIAN source string (so call sites stay readable), and a locale file
// is a flat msgid→translation map. A missing entry falls back to the msgid itself —
// an untranslated string shows up in Russian instead of as a broken key, which is
// honest and immediately visible during playtests.
//
//   t('Сообщение…')                       → per-locale button/label text
//   t('ещё {n}ч', { n: 3 })               → '{x}' placeholders for live values
//   tData('Metal Mine')                   → game-DATA names (data/*.json is authored
//                                           in English → ru.ts translates them; the
//                                           EN locale shows them as-is)
//
// The choice persists in localStorage ('vd.locale'); switching reloads the page —
// every renderer rebuilds from scratch, so no stale-language DOM can survive.
import { ru } from './locale/ru';
import { en } from './locale/en';

export type LocaleId = 'ru' | 'en';
const LOCALES: Record<LocaleId, Record<string, string>> = { ru, en };
export const LOCALE_LABEL: Record<LocaleId, string> = { ru: 'РУССКИЙ', en: 'ENGLISH' };
const STORE_KEY = 'vd.locale';

function detect(): LocaleId {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    /* storage disabled — fall through to the browser language */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'ru';
  return nav?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export let LOCALE: LocaleId = detect();

/** Persist the new locale. The caller reloads the page (see the picker wiring). */
export function setLocale(id: LocaleId): void {
  LOCALE = id;
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage disabled — the choice lives for this page only */
  }
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** UI string: msgid is the canonical Russian source; falls back to it untranslated. */
export function t(msg: string, vars?: Record<string, string | number>): string {
  return interpolate(LOCALES[LOCALE][msg] ?? msg, vars);
}

/** Game-DATA name (units/buildings/techs/sectors… from data/*.json, authored in
 *  English): the RU locale translates it, EN (and a miss) shows the source name. */
export function tData(name: string): string {
  return LOCALES[LOCALE][`data:${name}`] ?? name;
}

/** Boot pass over static HTML: every [data-i18n] element's text (and the title /
 *  placeholder / aria-label attributes via data-i18n-title / -ph / -aria) is treated
 *  as a msgid and replaced with its translation. Static markup stays canonical-Russian.
 *  Also stamps <html lang> so assistive tech and the browser agree with the UI language. */
export function localizeStaticDom(): void {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  if (document.documentElement) document.documentElement.lang = LOCALE;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const cur = el.textContent?.trim();
    if (cur) el.textContent = t(cur);
  }
  const attr = (sel: string, name: string) => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const cur = el.getAttribute(name);
      if (cur) el.setAttribute(name, t(cur));
    }
  };
  attr('[data-i18n-title]', 'title');
  attr('[data-i18n-ph]', 'placeholder');
  attr('[data-i18n-aria]', 'aria-label');
}
