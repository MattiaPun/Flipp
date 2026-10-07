// Browser flows: setup, content creation, every study mode, settings (2FA + passkey), admin console, palette.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const errors = [];
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|401|403|404|409|Failed to load resource/.test(m.text())) errors.push(m.text()); });
});
test.afterAll(() => expect(errors, errors.join('\n')).toEqual([]));

test('first-run setup with token', async () => {
  await page.goto('/#/setup?token=e2e-token');
  await expect(page.getByRole('heading', { name: 'Welcome to Flipp' })).toBeVisible();
  await page.fill('input[name=name]', 'Ada');
  await page.fill('input[name=email]', 'ada@example.com');
  await page.fill('input[name=password]', 'password123');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await expect(page.getByText('Your courses')).toBeVisible();
});

test('create course, set and cards (basic + cloze), import, bulk tag', async () => {
  await page.getByRole('button', { name: '+ New course' }).click();
  await page.fill('input[name=title]', 'Swedish');
  await page.getByRole('button', { name: 'Create course' }).click();
  await expect(page.getByRole('heading', { name: 'Swedish' })).toBeVisible();
  await page.getByRole('button', { name: '+ New set' }).click();
  await page.fill('input[name=title]', 'Verbs');
  await page.getByRole('button', { name: 'Create set' }).click();
  await expect(page.getByRole('heading', { name: 'Verbs' })).toBeVisible();

  await page.getByRole('button', { name: 'Import' }).click();
  await page.locator('textarea').fill('äta\tto eat\ndricka\tto drink\nsova\tto sleep\ngå\tto walk\nläsa\tto read');
  await expect(page.getByText('5 cards detected')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  await expect(page.locator('.cardrow[data-card]')).toHaveCount(5);

  await page.getByRole('button', { name: '+ Add card' }).click();
  await page.getByRole('radio', { name: 'Cloze' }).click();
  await page.locator('.card-editor textarea').first().fill('{{c1::Jag}} äter {{c2::äpplen::fruit}}');
  await page.getByRole('button', { name: /Add card/ }).last().click();
  await expect(page.locator('.cardrow[data-card]')).toHaveCount(6);
  // Duplicate warning
  await page.getByRole('radio', { name: 'Basic' }).click();
  await page.locator('.card-editor textarea').first().fill('äta');
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: /Add card/ }).last().click();
  await expect(page.locator('.cardrow[data-card]')).toHaveCount(6);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByLabel('Select all').check();
  await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toContainText('6 selected');
  page.once('dialog', (d) => d.accept('verbs'));
  await page.getByRole('button', { name: '+ Tag' }).click();
  await expect(page.locator('.tag', { hasText: '#verbs' })).toHaveCount(6);
});

test('learn mode: interval previews, keyboard rating, undo, summary', async () => {
  await page.locator('a.mode', { hasText: 'Learn' }).click();
  await expect(page.locator('.face.front').first()).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('.rate .btn').nth(2)).toContainText('10m');
  await page.keyboard.press('1');
  await page.keyboard.press('z');
  for (let i = 0; i < 40 && !(await page.getByText('Session complete').isVisible()); i++) {
    await page.keyboard.press('Space');
    await page.keyboard.press('4');
    await page.waitForTimeout(30);
  }
  await expect(page.getByText('Session complete')).toBeVisible();
});

test('write mode: hints, diff, multiple choice, test, cram, match', async () => {
  await page.goto('/#/');
  await page.getByRole('link', { name: /Swedish/ }).first().click();
  await page.getByRole('link', { name: /Verbs/ }).click();
  await page.locator('a.mode', { hasText: 'Write' }).click();
  await page.getByRole('button', { name: /Hint/ }).click();
  await page.getByLabel('Your answer').fill(((await page.getByLabel('Your answer').inputValue()) || 'x') + 'zz');
  await page.keyboard.press('Enter');
  await expect(page.locator('.result')).toBeVisible();
  await page.keyboard.press('Enter');

  await page.goto(page.url().replace('mode=write', 'mode=choice'));
  await expect(page.locator('.choice')).toHaveCount(4);
  await page.keyboard.press('1');
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();

  await page.goto(page.url().replace('mode=choice', 'mode=test'));
  await page.getByRole('button', { name: /Submit test/ }).click();
  await expect(page.locator('h1', { hasText: '%' })).toBeVisible();

  await page.goto(page.url().replace('mode=test', 'mode=cram'));
  await expect(page.locator('.face.front').first()).toBeVisible();

  await page.goto(page.url().replace('mode=cram', 'mode=match'));
  await expect(page.locator('.mtile')).toHaveCount(12);
});

test('survival, listening, lesson, XP and daily quests', async () => {
  await page.goto('/#/');
  await page.getByRole('link', { name: /Swedish/ }).first().click();
  await page.getByRole('link', { name: /Verbs/ }).click();
  await page.locator('a.mode', { hasText: 'Survival' }).click();
  await expect(page.locator('.lives .on')).toHaveCount(3);
  // Answer "1" on choices and submit typed questions empty until the lives run out.
  for (let i = 0; i < 60 && !(await page.locator('h1', { hasText: 'Game over' }).isVisible()); i++) {
    if (await page.locator('.choice').first().isVisible()) await page.keyboard.press('1');
    else if (await page.getByLabel('Your answer').isVisible()) await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Continue/ }).click();
  }
  await expect(page.locator('h1', { hasText: 'Game over' })).toBeVisible();
  await expect(page.locator('.xp-gain')).toBeVisible();

  await page.goto(page.url().replace('mode=survival', 'mode=listen'));
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible();
  await page.getByLabel('Your answer').fill('nope');
  await page.keyboard.press('Enter');
  await expect(page.locator('.result')).toContainText('Meaning');

  await page.goto(page.url().replace('mode=listen', 'mode=lesson') + '&unit=0');
  await expect(page.getByText(/Lesson · 0 \//)).toBeVisible();

  await page.goto('/#/');
  await expect(page.getByText('Daily quests')).toBeVisible();
  await expect(page.locator('.stat.xp b')).not.toHaveText('0');
});

test('stats, library, tags, leeches, groups pages render', async () => {
  for (const [hash, text] of [['#/stats', 'Activity'], ['#/library', 'Library'], ['#/tags', '#verbs'], ['#/leeches', 'No leeches'], ['#/groups', 'Groups']]) {
    await page.goto(`/${hash}`);
    await expect(page.getByText(text).first()).toBeVisible();
  }
});

test('command palette finds a card', async () => {
  await page.goto('/#/');
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search' }).fill('drick');
  await expect(page.locator('.palette-item', { hasText: 'dricka' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.locator('.palette-item', { hasText: 'dricka' }).click();
  await expect(page.getByRole('heading', { name: 'Verbs' })).toBeVisible();
});

test('course menu opens the Anki import dialog', async () => {
  await page.goto('/#/');
  await page.getByRole('link', { name: /Swedish/ }).first().click();
  await page.locator('details.menu summary').first().click();
  await page.getByRole('button', { name: 'Import Anki deck…' }).click();
  await expect(page.getByRole('dialog')).toContainText('Import Anki deck');
  await page.keyboard.press('Escape');
});

test('settings: 2FA setup shows QR; passkey register + sign in', async () => {
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Set up' }).click();
  await expect(page.locator('img.qr')).toBeVisible();
  await page.keyboard.press('Escape');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  page.once('dialog', (d) => d.accept('Test key'));
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByText('Test key')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).last().click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('Your courses')).toBeVisible();
});

test('admin console tabs', async () => {
  for (const tab of ['overview', 'users', 'access', 'library', 'storage', 'backups', 'branding', 'audit']) {
    await page.goto(`/#/admin?tab=${tab}`);
    await expect(page.locator('.tab.on')).toBeVisible();
  }
  await page.goto('/#/admin?tab=backups');
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.locator('code', { hasText: 'flipp-manual-' })).toBeVisible();
  await page.goto('/#/admin?tab=audit');
  await expect(page.locator('code', { hasText: 'auth.login' }).first()).toBeVisible();
});

test('mobile: swipe right marks a flashcard as mastered', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, storageState: await page.context().storageState() });
  const m = await ctx.newPage();
  await m.goto('/#/');
  await m.getByRole('link', { name: /Swedish/ }).first().click();
  await m.getByRole('link', { name: /Verbs/ }).click();
  await m.locator('a.mode', { hasText: 'Flashcards' }).click();
  const before = await m.locator('.study .small.muted').first().textContent();
  const box = await m.locator('.swipe').boundingBox();
  const y = box.y + box.height / 2;
  await m.mouse.move(box.x + 60, y);
  await m.mouse.down();
  for (let i = 1; i <= 12; i++) await m.mouse.move(box.x + 60 + i * 15, y);
  await m.mouse.up();
  await expect(m.locator('.study .small.muted').first()).not.toHaveText(before);
  await ctx.close();
});
