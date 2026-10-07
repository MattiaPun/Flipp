// Instance branding (name, accent color, welcome message, logo), editable by admins.
import { getJsonSetting, setSetting } from './db.js';
import { httpError, str, image } from './util.js';

export const DEFAULT_BRANDING = { name: 'Flipp', accent: '', welcome: '', logo: null };

let cache = null;
export async function branding() {
  cache ??= { ...DEFAULT_BRANDING, ...(await getJsonSetting('branding', {})) };
  return cache;
}

export async function saveBranding(body) {
  const accent = str(body.accent ?? '', 7);
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw httpError(400, 'Accent must be a hex color like #4f7cff');
  const next = {
    name: str(body.name ?? DEFAULT_BRANDING.name, 40, { min: 1 }),
    accent,
    welcome: str(body.welcome ?? '', 1000),
    logo: image(body.logo || null),
  };
  await setSetting('branding', JSON.stringify(next));
  cache = next;
  return next;
}

export const resetBrandingCache = () => { cache = null; };
