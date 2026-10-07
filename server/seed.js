// Demo data for clicking through every feature: users and roles, courses with every card kind, the public library,
// sharing, groups with assignments, and ~60 days of study history replayed through the real scheduler.
//   npm run seed [-- --for admin@example.com] [-- --reset]
//   docker compose exec -u node flipp node --disable-warning=ExperimentalWarning server/seed.js
// Demo users have @demo.flipp.test emails. --reset deletes them; their courses, progress and memberships cascade,
// and the few SET NULL references (groups, uploads, audit rows) are deleted explicitly.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { db, UPLOAD_DIR } from './db.js';
import { hashPassword, needsSetup } from './auth.js';
import { audit } from './audit.js';
import { now, startOfDay, json } from './util.js';
import { variantsOf } from './study-core.js';
import { schedule, model, normalizeConfig, weakFirst, STATE } from '../public/srs.js';

const DOMAIN = '@demo.flipp.test';
const PASSWORD = 'demo1234'; // demo data only; printed in the summary
const DAY = 86_400_000, MIN = 60_000, HOUR = 3_600_000;
const HISTORY_DAYS = 60;
const DOCKER_HINT = 'docker compose exec -u node flipp node --disable-warning=ExperimentalWarning server/seed.js';

// ---------- People ----------
const USERS = [
  { key: 'rivera', name: 'Ms. Rivera', role: 'teacher', prefs: { tz: 'America/New_York', dailyGoal: 30 } },
  { key: 'lars', name: 'Lars Nilsson', prefs: { tz: 'Europe/Stockholm', dailyGoal: 20 } },
  { key: 'emma', name: 'Emma Johansson', prefs: { tz: 'Europe/Stockholm', dailyGoal: 50 } },
  { key: 'liam', name: 'Liam O’Brien', prefs: { tz: 'Europe/Dublin' } },
  { key: 'sofia', name: 'Sofia Rossi', prefs: { tz: 'Europe/Rome', dailyGoal: 25 } },
  { key: 'kenji', name: 'Kenji Tanaka', prefs: { tz: 'Asia/Tokyo', dailyGoal: 40 } },
  { key: 'priya', name: 'Priya Patel', prefs: { tz: 'Europe/London', dailyGoal: 20 } },
  { key: 'tom', name: 'Tom Becker', prefs: { tz: 'Europe/Berlin' } },
];

// Who studies what. streak = consecutive active days up to today; idle = inactive for the last n days.
// hard: card front -> recall multiplier, so some cards lapse often (teacher insights, leeches).
const SPANISH_TRAPS = { estar: 0.75, saber: 0.7, conocer: 0.75, 'la cuenta': 0.8 };
const PLANS = {
  emma: { skill: 0.92, activity: 0.9, streak: 23, newPerDay: 6, courses: ['spanish', 'swedish', 'capitals', 'french'] },
  liam: { skill: 0.6, activity: 0.45, streak: 2, newPerDay: 5, courses: ['spanish', 'swedish', 'capitals'] },
  sofia: { skill: 0.8, activity: 0.7, streak: 6, newPerDay: 6, courses: ['spanish', 'code'] },
  kenji: { skill: 0.86, activity: 0.8, streak: 11, newPerDay: 7, courses: ['spanish', 'hiragana'], hard: { 'め': 0.6 } },
  priya: { skill: 0.75, activity: 0.6, streak: 0, idle: 4, newPerDay: 5, courses: ['spanish', 'math', 'swedish', 'french'] },
  tom: { skill: 0.7, activity: 0.55, streak: 3, newPerDay: 5, courses: ['biology', 'swedish', 'capitals', 'flags'] },
  // The instance admin the demo is seeded for. Short sessions over the last few days leave a backlog of due cards.
  target: { skill: 0.85, activity: 0.8, streak: 16, newPerDay: 2, behind: 4, reviewCap: 5, todayCap: 6, courses: ['swedish', 'spanish', 'hiragana', 'biology', 'capitals'],
    hard: { 'ぬ': 0.1, saber: 0.1 } },
};

// ---------- Content ----------
// Cards are [front, back, extra?]; extra: { notes, mnemonic, example, tags, color: [r, g, b] (generated swatch image) }.
const COURSES = [
  {
    key: 'swedish', owner: 'lars', library: 'featured', icon: '🇸🇪', lang: 'sv-SE', tags: 'swedish,language,beginner',
    title: 'Swedish for beginners',
    description: 'Your first Swedish words: greetings, numbers, colours, family, food and everyday verbs. Short words, short sentences.',
    sets: [
      { title: 'Hej!', reverse: true, description: 'Greetings and polite words, studied both ways.', cards: [
        ['hej', 'hi / hello', { example: 'Hej! Jag heter Anna.', notes: 'Used all day, with everyone. Swedish is very informal.', tags: 'greeting' }],
        ['tack', 'thanks / thank you', { example: 'Tack för hjälpen!', tags: 'polite' }],
        ['ja', 'yes', { notes: '“Jo” is a yes that contradicts a negative question: “Är du inte hungrig?” – “Jo!”' }],
        ['nej', 'no', { example: 'Nej tack.' }],
        ['hej då', 'goodbye / bye', { notes: 'Literally “hi then”.', tags: 'greeting' }],
        ['god morgon', 'good morning', { mnemonic: 'Looks just like English “good morning”.', tags: 'greeting' }],
        ['god natt', 'good night', { tags: 'greeting' }],
        ['varsågod', 'here you go / you’re welcome', { notes: 'Said when handing something over, inviting someone to eat, or answering “tack”.', example: 'Varsågod, här är ditt kaffe.', tags: 'polite' }],
        ['ursäkta', 'excuse me', { example: 'Ursäkta, var är toaletten?', tags: 'polite' }],
        ['förlåt', 'sorry', { notes: 'A real apology. Use “ursäkta” to get someone’s attention.', tags: 'polite' }],
        ['tack så mycket', 'thank you very much', { tags: 'polite' }],
        ['välkommen', 'welcome', { example: 'Välkommen till Sverige!' }],
      ] },
      { title: 'Numbers 1–10', description: 'Count to ten.', cards: [
        ['ett', 'one / 1', { notes: '“en” before en-words: en katt, ett hus.', tags: 'number' }],
        ['två', 'two / 2', { tags: 'number' }],
        ['tre', 'three / 3', { tags: 'number' }],
        ['fyra', 'four / 4', { tags: 'number' }],
        ['fem', 'five / 5', { tags: 'number' }],
        ['sex', 'six / 6', { mnemonic: 'Yes, really: six is “sex”.', tags: 'number' }],
        ['sju', 'seven / 7', { notes: 'Starts with the famous Swedish sj-sound, a breathy “hw”.', tags: 'number' }],
        ['åtta', 'eight / 8', { mnemonic: 'å sounds like the o in “more”: OT-ta.', tags: 'number' }],
        ['nio', 'nine / 9', { tags: 'number' }],
        ['tio', 'ten / 10', { tags: 'number' }],
      ] },
      { title: 'Colors', description: 'Färger. Each card has a colour swatch.', cards: [
        ['röd', 'red', { example: 'Huset är rött.', notes: 'With ett-words: rött.', color: [220, 38, 38], tags: 'color' }],
        ['blå', 'blue', { mnemonic: 'The Swedish flag is blå and gul.', color: [37, 99, 235], tags: 'color' }],
        ['gul', 'yellow', { mnemonic: 'The Swedish flag is blå and gul.', color: [250, 204, 21], tags: 'color' }],
        ['grön', 'green', { example: 'Gräset är grönt.', color: [22, 163, 74], tags: 'color' }],
        ['svart', 'black', { example: 'En svart katt.', color: [23, 23, 23], tags: 'color' }],
        ['vit', 'white', { example: 'Snön är vit.', color: [245, 245, 245], tags: 'color' }],
        ['orange', 'orange', { notes: 'Same word as in English, but said “o-RANSH”.', color: [249, 115, 22], tags: 'color' }],
        ['rosa', 'pink', { color: [236, 72, 153], tags: 'color' }],
        ['lila', 'purple', { color: [147, 51, 234], tags: 'color' }],
        ['brun', 'brown', { example: 'En brun björn.', color: [120, 72, 32], tags: 'color' }],
        ['grå', 'grey', { example: 'En grå dag.', color: [128, 128, 128], tags: 'color' }],
      ] },
      { title: 'Family', description: 'Familjen.', cards: [
        ['mamma', 'mum / mother', { tags: 'family' }],
        ['pappa', 'dad / father', { tags: 'family' }],
        ['bror', 'brother', { example: 'Jag har en bror.', tags: 'family' }],
        ['syster', 'sister', { tags: 'family' }],
        ['mormor', 'grandma (mum’s mum)', { mnemonic: 'mor = mother, so mor + mor = mother’s mother.', tags: 'family' }],
        ['farmor', 'grandma (dad’s mum)', { mnemonic: 'far = father, so far + mor = father’s mother.', tags: 'family' }],
        ['morfar', 'grandpa (mum’s dad)', { tags: 'family' }],
        ['farfar', 'grandpa (dad’s dad)', { tags: 'family' }],
        ['barn', 'child / children', { notes: 'Same form in singular and plural: ett barn, två barn.', tags: 'family' }],
        ['son', 'son', { tags: 'family' }],
        ['dotter', 'daughter', { tags: 'family' }],
        ['föräldrar', 'parents', { tags: 'family' }],
        ['syskon', 'siblings', { notes: 'Brothers and sisters together.', tags: 'family' }],
      ] },
      { title: 'Food & drink', description: 'Mat och dryck.', cards: [
        ['kaffe', 'coffee', { example: 'En kopp kaffe, tack.', tags: 'food' }],
        ['te', 'tea', { tags: 'food' }],
        ['vatten', 'water', { tags: 'food' }],
        ['mjölk', 'milk', { tags: 'food' }],
        ['bröd', 'bread', { tags: 'food' }],
        ['ost', 'cheese', { tags: 'food' }],
        ['smör', 'butter', { tags: 'food' }],
        ['äpple', 'apple', { tags: 'food' }],
        ['fisk', 'fish', { tags: 'food' }],
        ['kött', 'meat', { tags: 'food' }],
        ['smörgås', 'sandwich', { notes: 'Usually open-faced: one slice of bread with toppings.', tags: 'food' }],
        ['kanelbulle', 'cinnamon bun', { notes: '4 October is Kanelbullens dag, cinnamon bun day.', tags: 'food' }],
        ['fika', 'coffee break', { notes: 'Coffee with something sweet, and a chat. A Swedish institution.', example: 'Ska vi fika?', tags: 'food,culture' }],
      ] },
      { title: 'Basic verbs', description: 'Present tense. The same form for every person: jag är, du är, vi är.', cards: [
        ['är', 'am / is / are', { notes: 'Infinitive: att vara.', example: 'Jag är trött.', tags: 'verb' }],
        ['har', 'have / has', { notes: 'Infinitive: att ha.', example: 'Vi har en hund.', tags: 'verb' }],
        ['äter', 'eat / eats', { notes: 'Infinitive: att äta.', example: 'Jag äter frukost.', tags: 'verb' }],
        ['dricker', 'drink / drinks', { notes: 'Infinitive: att dricka.', example: 'Hon dricker te.', tags: 'verb' }],
        ['går', 'go / walk', { notes: 'Infinitive: att gå. Going on foot.', example: 'Vi går hem.', tags: 'verb' }],
        ['talar', 'speak / speaks', { notes: '“pratar” (talk) is more everyday.', example: 'Talar du engelska?', tags: 'verb' }],
        ['bor', 'live / lives', { notes: 'Where you live, not being alive.', example: 'Jag bor i Göteborg.', tags: 'verb' }],
        ['heter', 'am called / is called', { example: 'Jag heter Erik. Vad heter du?', tags: 'verb' }],
        ['kommer', 'come / comes', { example: 'Jag kommer från Spanien.', tags: 'verb' }],
        ['läser', 'read / reads', { example: 'Han läser en bok.', tags: 'verb' }],
        ['sover', 'sleep / sleeps', { example: 'Katten sover.', tags: 'verb' }],
        ['tycker om', 'like / likes', { example: 'Jag tycker om fika.', tags: 'verb' }],
        ['förstår', 'understand / understands', { example: 'Jag förstår inte.', tags: 'verb' }],
      ] },
    ],
  },
  {
    key: 'spanish', owner: 'rivera', icon: '🇪🇸', lang: 'es-ES', tags: 'spanish,language,class',
    title: 'Spanish basics',
    description: 'Course material for Spanish 101: greetings, food and the verbs you need every day.',
    sets: [
      { title: 'Greetings', description: 'Saludos.', cards: [
        ['hola', 'hello', { tags: 'greeting' }],
        ['buenos días', 'good morning', { tags: 'greeting' }],
        ['buenas tardes', 'good afternoon', { notes: 'From lunch until it gets dark.', tags: 'greeting' }],
        ['buenas noches', 'good evening / good night', { tags: 'greeting' }],
        ['adiós', 'goodbye', { tags: 'greeting' }],
        ['hasta luego', 'see you later', { tags: 'greeting' }],
        ['hasta mañana', 'see you tomorrow', { tags: 'greeting' }],
        ['por favor', 'please', { tags: 'polite' }],
        ['gracias', 'thank you', { tags: 'polite' }],
        ['de nada', 'you’re welcome', { tags: 'polite' }],
        ['¿Cómo estás?', 'How are you? (informal)', { example: '¿Cómo estás? – Bien, gracias.', notes: 'Formal: ¿Cómo está usted?' }],
        ['Me llamo…', 'My name is…', { example: 'Me llamo Lucía.' }],
        ['¿Cómo te llamas?', 'What’s your name? (informal)' ],
        ['mucho gusto', 'nice to meet you', { tags: 'polite' }],
        ['lo siento', 'I’m sorry', { notes: 'A real apology. “Perdón” or “disculpe” to get past someone.', tags: 'polite' }],
        ['perdón', 'excuse me / pardon', { tags: 'polite' }],
      ] },
      { title: 'Food & drink', description: 'La comida y la bebida.', cards: [
        ['el agua', 'water', { notes: 'Feminine, but takes “el” because it starts with a stressed a: el agua fría.', tags: 'food' }],
        ['el pan', 'bread', { tags: 'food' }],
        ['la leche', 'milk', { tags: 'food' }],
        ['el queso', 'cheese', { tags: 'food' }],
        ['la manzana', 'apple', { tags: 'food' }],
        ['el pollo', 'chicken', { tags: 'food' }],
        ['el pescado', 'fish (as food)', { notes: 'A live fish is “el pez”.', tags: 'food' }],
        ['la carne', 'meat', { tags: 'food' }],
        ['el arroz', 'rice', { tags: 'food' }],
        ['los huevos', 'eggs', { tags: 'food' }],
        ['el café', 'coffee', { tags: 'food' }],
        ['la cerveza', 'beer', { tags: 'food' }],
        ['el vino', 'wine', { example: 'Una copa de vino tinto, por favor.', tags: 'food' }],
        ['el desayuno', 'breakfast', { tags: 'meal' }],
        ['el almuerzo', 'lunch', { tags: 'meal' }],
        ['la cena', 'dinner', { tags: 'meal' }],
        ['la cuenta', 'the bill', { example: 'La cuenta, por favor.', tags: 'restaurant' }],
        ['Tengo hambre.', 'I’m hungry.', { notes: 'Literally “I have hunger”.', mnemonic: 'hambre ≈ hunger', tags: 'restaurant' }],
      ] },
      { title: 'Common verbs', reverse: true, description: 'Infinitives, studied both ways.', cards: [
        ['ser', 'to be (permanent)', { notes: 'Identity, origin, time, characteristics.', example: 'Soy de México.', mnemonic: 'DOCTOR: description, occupation, characteristic, time, origin, relationship.', tags: 'verb,irregular' }],
        ['estar', 'to be (state, location)', { notes: 'Feelings, conditions and where something is.', example: 'Estoy cansado. Madrid está en España.', mnemonic: 'How you feel and where you are, you use estar.', tags: 'verb,irregular' }],
        ['tener', 'to have', { example: 'Tengo dos hermanos.', tags: 'verb,irregular' }],
        ['hacer', 'to do / to make', { example: '¿Qué haces?', tags: 'verb,irregular' }],
        ['ir', 'to go', { example: 'Voy al mercado.', tags: 'verb,irregular' }],
        ['poder', 'to be able to / can', { example: '¿Puedo pasar?', tags: 'verb,irregular' }],
        ['querer', 'to want', { example: 'Quiero un café.', tags: 'verb,irregular' }],
        ['decir', 'to say / to tell', { tags: 'verb,irregular' }],
        ['ver', 'to see', { tags: 'verb' }],
        ['dar', 'to give', { tags: 'verb' }],
        ['saber', 'to know (facts, how to)', { notes: 'saber nadar = to know how to swim.', example: 'No sé.', tags: 'verb,irregular' }],
        ['conocer', 'to know (people, places)', { example: 'Conozco a María.', tags: 'verb' }],
        ['hablar', 'to speak', { example: 'Hablo un poco de español.', tags: 'verb,regular' }],
        ['comer', 'to eat', { tags: 'verb,regular' }],
        ['vivir', 'to live', { example: 'Vivo en Sevilla.', tags: 'verb,regular' }],
        ['venir', 'to come', { tags: 'verb,irregular' }],
      ] },
    ],
  },
  {
    key: 'french', owner: 'rivera', library: 'pending', icon: '🇫🇷', lang: 'fr-FR', tags: 'french,language,travel',
    title: 'French phrases',
    description: 'Survival French for a first trip. Submitted to the library and waiting for review.',
    sets: [
      { title: 'Everyday phrases', description: 'Polite basics and a few questions.', cards: [
        ['Bonjour', 'Hello / Good morning', { notes: 'Say it when you walk into a shop. Skipping it is rude.', tags: 'greeting' }],
        ['Bonsoir', 'Good evening', { tags: 'greeting' }],
        ['Salut', 'Hi / Bye (informal)', { tags: 'greeting' }],
        ['Au revoir', 'Goodbye', { tags: 'greeting' }],
        ['À bientôt', 'See you soon', { tags: 'greeting' }],
        ['S’il vous plaît', 'Please (formal)', { notes: 'Informal: s’il te plaît.', tags: 'polite' }],
        ['Merci beaucoup', 'Thank you very much', { tags: 'polite' }],
        ['De rien', 'You’re welcome', { tags: 'polite' }],
        ['Excusez-moi', 'Excuse me', { tags: 'polite' }],
        ['Je ne comprends pas', 'I don’t understand', { tags: 'help' }],
        ['Parlez-vous anglais ?', 'Do you speak English?', { tags: 'help' }],
        ['Je voudrais…', 'I would like…', { example: 'Je voudrais un croissant, s’il vous plaît.', tags: 'restaurant' }],
        ['L’addition, s’il vous plaît', 'The bill, please', { tags: 'restaurant' }],
        ['Où sont les toilettes ?', 'Where is the toilet?', { tags: 'help' }],
        ['Combien ça coûte ?', 'How much does it cost?', { tags: 'shopping' }],
        ['Je m’appelle…', 'My name is…', { example: 'Je m’appelle Claire.' }],
      ] },
    ],
  },
  {
    key: 'hiragana', owner: 'kenji', library: 'public', icon: '🎌', lang: 'ja-JP', tags: 'japanese,writing,beginner',
    title: 'Japanese hiragana',
    description: 'All 46 basic hiragana, kana → romaji, in the order of the gojūon table.',
    sets: [
      { title: 'Vowels, K and S rows', description: 'あ い う え お, か–こ, さ–そ', cards: [
        ['あ', 'a', { mnemonic: 'An “a” with a cross through it: “Ahh!”', tags: 'vowel' }],
        ['い', 'i', { mnemonic: 'Two eels side by side.', tags: 'vowel' }],
        ['う', 'u', { tags: 'vowel' }],
        ['え', 'e', { tags: 'vowel' }],
        ['お', 'o', { tags: 'vowel' }],
        ['か', 'ka', { tags: 'k-row' }],
        ['き', 'ki', { mnemonic: 'Looks like a key.', tags: 'k-row' }],
        ['く', 'ku', { mnemonic: 'A bird’s beak going “coo”.', tags: 'k-row' }],
        ['け', 'ke', { tags: 'k-row' }],
        ['こ', 'ko', { tags: 'k-row' }],
        ['さ', 'sa', { notes: 'Easily confused with ち (chi): さ opens to the left.', tags: 's-row' }],
        ['し', 'shi', { notes: 'Not “si”.', mnemonic: 'A fishing hook: “she” caught a fish.', tags: 's-row' }],
        ['す', 'su', { tags: 's-row' }],
        ['せ', 'se', { tags: 's-row' }],
        ['そ', 'so', { tags: 's-row' }],
      ] },
      { title: 'T, N and H rows', description: 'た–と, な–の, は–ほ', cards: [
        ['た', 'ta', { tags: 't-row' }],
        ['ち', 'chi', { notes: 'Not “ti”.', tags: 't-row' }],
        ['つ', 'tsu', { notes: 'Not “tu”. Small っ doubles the next consonant.', mnemonic: 'A tsunami wave.', tags: 't-row' }],
        ['て', 'te', { tags: 't-row' }],
        ['と', 'to', { tags: 't-row' }],
        ['な', 'na', { tags: 'n-row' }],
        ['に', 'ni', { tags: 'n-row' }],
        ['ぬ', 'nu', { notes: 'Looks like め (me), but ぬ has a loop at the end.', mnemonic: 'Noodles with a loop.', tags: 'n-row' }],
        ['ね', 'ne', { notes: 'Compare れ (re) and わ (wa): ね ends in a loop.', tags: 'n-row' }],
        ['の', 'no', { tags: 'n-row' }],
        ['は', 'ha', { notes: 'Read “wa” when it is the topic particle: わたしは.', tags: 'h-row' }],
        ['ひ', 'hi', { tags: 'h-row' }],
        ['ふ', 'fu', { notes: 'Not “hu”: a soft f made with both lips.', tags: 'h-row' }],
        ['へ', 'he', { notes: 'Read “e” as the direction particle.', tags: 'h-row' }],
        ['ほ', 'ho', { tags: 'h-row' }],
      ] },
      { title: 'M, Y, R, W rows and ん', description: 'ま–も, や ゆ よ, ら–ろ, わ を ん', cards: [
        ['ま', 'ma', { tags: 'm-row' }],
        ['み', 'mi', { tags: 'm-row' }],
        ['む', 'mu', { tags: 'm-row' }],
        ['め', 'me', { notes: 'Like ぬ (nu) without the loop.', mnemonic: 'An eye (“me” is eye in Japanese).', tags: 'm-row' }],
        ['も', 'mo', { tags: 'm-row' }],
        ['や', 'ya', { tags: 'y-row' }],
        ['ゆ', 'yu', { tags: 'y-row' }],
        ['よ', 'yo', { tags: 'y-row' }],
        ['ら', 'ra', { tags: 'r-row' }],
        ['り', 'ri', { tags: 'r-row' }],
        ['る', 'ru', { tags: 'r-row' }],
        ['れ', 're', { tags: 'r-row' }],
        ['ろ', 'ro', { notes: 'る (ru) has a loop; ろ does not.', tags: 'r-row' }],
        ['わ', 'wa', { tags: 'w-row' }],
        ['を', 'wo / o', { notes: 'Only used as the object particle, pronounced “o”.', tags: 'w-row' }],
        ['ん', 'n', { notes: 'The only kana that is a lone consonant.', tags: 'n' }],
      ] },
    ],
  },
  {
    key: 'capitals', owner: 'lars', library: 'public', icon: '🏛️', lang: 'en-US', tags: 'geography,capitals',
    title: 'World capitals',
    description: 'Country → capital city. Europe first, then the rest of the world.',
    sets: [
      { title: 'Europe', description: 'European capitals.', cards: [
        ['France', 'Paris'], ['Germany', 'Berlin'], ['Italy', 'Rome'], ['Spain', 'Madrid'], ['Portugal', 'Lisbon'],
        ['Netherlands', 'Amsterdam', { notes: 'The government sits in The Hague.' }],
        ['Belgium', 'Brussels'], ['Sweden', 'Stockholm'], ['Norway', 'Oslo'], ['Denmark', 'Copenhagen'],
        ['Finland', 'Helsinki'], ['Poland', 'Warsaw'], ['Austria', 'Vienna'],
        ['Switzerland', 'Bern', { notes: 'Officially the “federal city”. Zürich is the largest city.' }],
        ['Greece', 'Athens'], ['Ireland', 'Dublin'], ['Czechia', 'Prague'], ['Hungary', 'Budapest', { mnemonic: 'Buda + Pest, two towns on either side of the Danube.' }],
        ['Iceland', 'Reykjavík'], ['Romania', 'Bucharest'],
      ] },
      { title: 'Rest of the world', description: 'Asia, Oceania, the Americas and Africa.', cards: [
        ['Japan', 'Tokyo'], ['China', 'Beijing'], ['India', 'New Delhi'], ['South Korea', 'Seoul'], ['Thailand', 'Bangkok'],
        ['Vietnam', 'Hanoi', { notes: 'Ho Chi Minh City is the largest city.' }],
        ['Indonesia', 'Jakarta', { notes: 'A new capital, Nusantara, is being built on Borneo.' }],
        ['Australia', 'Canberra', { notes: 'Not Sydney! Canberra was built as a compromise between Sydney and Melbourne.' }],
        ['New Zealand', 'Wellington'], ['Canada', 'Ottawa'], ['United States', 'Washington, D.C.'], ['Mexico', 'Mexico City'],
        ['Brazil', 'Brasília', { notes: 'Purpose-built capital, inaugurated in 1960.' }],
        ['Argentina', 'Buenos Aires'], ['Chile', 'Santiago'], ['Peru', 'Lima'], ['Egypt', 'Cairo'], ['Kenya', 'Nairobi'],
        ['Nigeria', 'Abuja', { notes: 'Lagos is the largest city.' }],
        ['South Africa', 'Pretoria', { notes: 'Executive capital. Cape Town is the legislative and Bloemfontein the judicial capital.' }],
      ] },
    ],
  },
  {
    key: 'flags', owner: 'lars', library: 'public', icon: '🚩', lang: 'en-US', tags: 'geography,flags',
    title: 'Flags of the world',
    description: 'Recognise 26 national flags.',
    sets: [
      { title: 'Flags', description: 'Flag → country.', cards: [
        ['🇸🇪', 'Sweden', { notes: 'Nordic cross, blue and yellow.', tags: 'nordic' }],
        ['🇳🇴', 'Norway', { tags: 'nordic' }],
        ['🇩🇰', 'Denmark', { notes: 'The Dannebrog, the oldest national flag still in use.', tags: 'nordic' }],
        ['🇫🇮', 'Finland', { tags: 'nordic' }],
        ['🇮🇸', 'Iceland', { notes: 'Norway’s colours inverted.', tags: 'nordic' }],
        ['🇩🇪', 'Germany', { tags: 'europe' }],
        ['🇫🇷', 'France', { tags: 'europe' }],
        ['🇮🇹', 'Italy', { notes: 'Green, white, red. Ireland is green, white, orange.', tags: 'europe' }],
        ['🇮🇪', 'Ireland', { tags: 'europe' }],
        ['🇪🇸', 'Spain', { tags: 'europe' }],
        ['🇵🇹', 'Portugal', { tags: 'europe' }],
        ['🇬🇧', 'United Kingdom', { tags: 'europe' }],
        ['🇳🇱', 'Netherlands', { notes: 'Luxembourg’s flag is almost identical, with a lighter blue.', tags: 'europe' }],
        ['🇧🇪', 'Belgium', { tags: 'europe' }],
        ['🇨🇭', 'Switzerland', { notes: 'One of only two square national flags (the other is Vatican City).', tags: 'europe' }],
        ['🇯🇵', 'Japan', { tags: 'asia' }],
        ['🇰🇷', 'South Korea', { tags: 'asia' }],
        ['🇨🇳', 'China', { tags: 'asia' }],
        ['🇮🇳', 'India', { tags: 'asia' }],
        ['🇧🇷', 'Brazil', { tags: 'americas' }],
        ['🇦🇷', 'Argentina', { tags: 'americas' }],
        ['🇨🇦', 'Canada', { tags: 'americas' }],
        ['🇺🇸', 'United States', { notes: '50 stars for the states, 13 stripes for the original colonies.', tags: 'americas' }],
        ['🇲🇽', 'Mexico', { tags: 'americas' }],
        ['🇿🇦', 'South Africa', { tags: 'africa' }],
        ['🇰🇪', 'Kenya', { tags: 'africa' }],
      ] },
    ],
  },
  {
    key: 'math', owner: 'priya', icon: '∑', tags: 'math,algebra,calculus',
    title: 'Algebra & calculus',
    description: 'Identities, laws of logarithms, derivatives and integrals. Written in LaTeX.',
    sets: [
      { title: 'Algebra', description: 'Identities and rules worth knowing by heart.', cards: [
        [String.raw`Solve $ax^2 + bx + c = 0$`, String.raw`$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$`, { tags: 'quadratic' }],
        [String.raw`Discriminant of $ax^2 + bx + c$`, String.raw`$\Delta = b^2 - 4ac$`, { notes: String.raw`$\Delta > 0$: two real roots, $\Delta = 0$: one, $\Delta < 0$: two complex roots.`, tags: 'quadratic' }],
        [String.raw`$(a + b)^2$`, String.raw`$a^2 + 2ab + b^2$`, { tags: 'identity' }],
        [String.raw`$(a - b)^2$`, String.raw`$a^2 - 2ab + b^2$`, { tags: 'identity' }],
        [String.raw`$a^2 - b^2$`, String.raw`$(a + b)(a - b)$`, { notes: 'Difference of squares.', tags: 'identity' }],
        [String.raw`$(a + b)^3$`, String.raw`$a^3 + 3a^2b + 3ab^2 + b^3$`, { mnemonic: 'Coefficients 1 3 3 1: a row of Pascal’s triangle.', tags: 'identity' }],
        [String.raw`$x^a \cdot x^b$`, String.raw`$x^{a+b}$`, { tags: 'exponent' }],
        [String.raw`$(x^a)^b$`, String.raw`$x^{ab}$`, { tags: 'exponent' }],
        [String.raw`$x^{-n}$`, String.raw`$\dfrac{1}{x^n}$`, { tags: 'exponent' }],
        [String.raw`$x^{1/n}$`, String.raw`$\sqrt[n]{x}$`, { tags: 'exponent' }],
        [String.raw`$\log_b(xy)$`, String.raw`$\log_b x + \log_b y$`, { tags: 'log' }],
        [String.raw`$\log_b(x^k)$`, String.raw`$k \log_b x$`, { tags: 'log' }],
        [String.raw`Change of base: $\log_b x$`, String.raw`$\dfrac{\ln x}{\ln b}$`, { tags: 'log' }],
        [String.raw`Slope through $(x_1, y_1)$ and $(x_2, y_2)$`, String.raw`$m = \dfrac{y_2 - y_1}{x_2 - x_1}$`, { tags: 'line' }],
        [String.raw`Arithmetic series $a_1 + a_2 + \dots + a_n$`, String.raw`$S_n = \dfrac{n(a_1 + a_n)}{2}$`, { example: String.raw`$1 + 2 + \dots + 100 = \frac{100 \cdot 101}{2} = 5050$`, tags: 'series' }],
        [String.raw`Geometric series $\sum_{k=0}^{n-1} a r^k$, $r \ne 1$`, String.raw`$a \, \dfrac{1 - r^n}{1 - r}$`, { tags: 'series' }],
      ] },
      { title: 'Derivatives & integrals', description: 'The rules behind most of first-year calculus.', cards: [
        [String.raw`$\dfrac{d}{dx}\, x^n$`, String.raw`$n x^{n-1}$`, { notes: 'The power rule.', tags: 'derivative' }],
        [String.raw`$\dfrac{d}{dx}\, \sin x$`, String.raw`$\cos x$`, { tags: 'derivative,trig' }],
        [String.raw`$\dfrac{d}{dx}\, \cos x$`, String.raw`$-\sin x$`, { tags: 'derivative,trig' }],
        [String.raw`$\dfrac{d}{dx}\, \tan x$`, String.raw`$\sec^2 x = \dfrac{1}{\cos^2 x}$`, { tags: 'derivative,trig' }],
        [String.raw`$\dfrac{d}{dx}\, e^x$`, String.raw`$e^x$`, { tags: 'derivative' }],
        [String.raw`$\dfrac{d}{dx}\, a^x$`, String.raw`$a^x \ln a$`, { tags: 'derivative' }],
        [String.raw`$\dfrac{d}{dx}\, \ln x$`, String.raw`$\dfrac{1}{x}$`, { tags: 'derivative' }],
        ['Product rule', String.raw`$(fg)' = f'g + fg'$`, { tags: 'derivative,rule' }],
        ['Quotient rule', String.raw`$\left(\dfrac{f}{g}\right)' = \dfrac{f'g - fg'}{g^2}$`, { mnemonic: '“Low d-high minus high d-low, over the square of what’s below.”', tags: 'derivative,rule' }],
        ['Chain rule', String.raw`$\big(f(g(x))\big)' = f'(g(x)) \cdot g'(x)$`, { example: String.raw`$\frac{d}{dx} \sin(x^2) = 2x \cos(x^2)$`, tags: 'derivative,rule' }],
        [String.raw`$\displaystyle\int x^n \, dx$ ($n \ne -1$)`, String.raw`$\dfrac{x^{n+1}}{n+1} + C$`, { tags: 'integral' }],
        [String.raw`$\displaystyle\int \frac{1}{x} \, dx$`, String.raw`$\ln|x| + C$`, { tags: 'integral' }],
        [String.raw`$\displaystyle\int e^x \, dx$`, String.raw`$e^x + C$`, { tags: 'integral' }],
        [String.raw`$\displaystyle\int \cos x \, dx$`, String.raw`$\sin x + C$`, { tags: 'integral,trig' }],
        [String.raw`$\displaystyle\int \sin x \, dx$`, String.raw`$-\cos x + C$`, { tags: 'integral,trig' }],
        ['Fundamental theorem of calculus', String.raw`$$\int_a^b f'(x)\, dx = f(b) - f(a)$$`, { tags: 'integral,theorem' }],
      ] },
    ],
  },
  {
    key: 'biology', owner: 'tom', icon: '🫀', lang: 'en-US', tags: 'biology,science,anatomy',
    title: 'Human biology',
    description: 'Cloze cards on cells, organs and the nervous system.',
    sets: [
      { title: 'Cells & organs', description: 'Cloze deletions: each gap is its own card.', cards: [
        ['The {{c1::mitochondria}} produce most of the cell’s {{c2::ATP}}.', 'Through cellular respiration.', { tags: 'cell' }],
        ['The human heart has {{c1::four}} chambers: two {{c2::atria}} and two {{c3::ventricles}}.', '', { tags: 'heart' }],
        ['Red blood cells carry oxygen bound to {{c1::hemoglobin}}.', 'British spelling: haemoglobin.', { tags: 'blood' }],
        ['The adult human skeleton has {{c1::206}} bones.', 'Babies are born with around 270; many fuse.', { tags: 'skeleton' }],
        ['The largest organ of the human body is the {{c1::skin::organ}}.', '', { tags: 'organ' }],
        ['Insulin is produced by the {{c1::pancreas}}.', 'By the β-cells in the islets of Langerhans.', { tags: 'organ,hormone' }],
        ['Gas exchange in the lungs happens in tiny air sacs called {{c1::alveoli}}.', '', { tags: 'lungs' }],
        ['The {{c1::nephron}} is the functional unit of the kidney.', '', { tags: 'kidney' }],
        ['In DNA, adenine pairs with {{c1::thymine}} and guanine pairs with {{c2::cytosine}}.', 'In RNA, uracil replaces thymine.', { tags: 'dna' }],
        ['{{c1::Platelets::cell fragments}} help the blood to clot.', '', { tags: 'blood' }],
        ['The {{c1::femur}} is the longest bone in the body.', 'The thigh bone.', { tags: 'skeleton' }],
        ['Arteries carry blood {{c1::away from::direction}} the heart; veins carry it {{c2::towards::direction}} it.', 'Exception: the pulmonary artery carries deoxygenated blood.', { tags: 'blood,heart' }],
        ['The small intestine absorbs nutrients through finger-like projections called {{c1::villi}}.', '', { tags: 'digestion' }],
        ['Bile is made by the {{c1::liver}} and stored in the {{c2::gallbladder}}.', '', { tags: 'digestion,organ' }],
        ['A normal resting heart rate for adults is {{c1::60–100}} beats per minute.', '', { tags: 'heart' }],
      ] },
      { title: 'Nervous system & senses', description: 'Neurons, brain regions and sense organs.', cards: [
        ['The {{c1::neuron}} is the basic cell of the nervous system.', '', { tags: 'nerve' }],
        ['The central nervous system consists of the {{c1::brain}} and the {{c2::spinal cord}}.', '', { tags: 'nerve' }],
        ['Signals cross the gap between neurons, the {{c1::synapse}}, by means of {{c2::neurotransmitters}}.', 'Examples: dopamine, serotonin, acetylcholine.', { tags: 'nerve' }],
        ['The {{c1::cerebellum}} coordinates balance and fine movement.', '', { tags: 'brain' }],
        ['The {{c1::myelin sheath}} insulates axons and speeds up conduction.', '', { tags: 'nerve' }],
        ['Light-sensitive cells in the retina: {{c1::rods}} for dim light and {{c2::cones}} for colour.', '', { tags: 'eye' }],
        ['The {{c1::cochlea}} in the inner ear turns sound vibrations into nerve signals.', '', { tags: 'ear' }],
        ['The {{c1::hypothalamus}} links the nervous system to the endocrine system via the pituitary gland.', '', { tags: 'brain,hormone' }],
        ['The {{c1::medulla oblongata}} controls breathing and heart rate.', 'Part of the brainstem.', { tags: 'brain' }],
        ['Reflexes are routed through the {{c1::spinal cord}}, not the brain, which makes them fast.', '', { tags: 'nerve' }],
        ['The {{c1::frontal lobe}} handles planning, decisions and voluntary movement.', '', { tags: 'brain' }],
        ['The three bones of the middle ear are the {{c1::malleus}}, {{c2::incus}} and {{c3::stapes}}.', 'Hammer, anvil and stirrup. The stapes is the smallest bone in the body.', { tags: 'ear' }],
        ['The {{c1::sympathetic}} nervous system triggers “fight or flight”; the {{c2::parasympathetic}} triggers “rest and digest”.', '', { tags: 'nerve' }],
        ['Taste buds detect five basic tastes: sweet, sour, salty, bitter and {{c1::umami}}.', '', { tags: 'taste' }],
        ['The blind spot is where the {{c1::optic nerve}} leaves the eye.', '', { tags: 'eye' }],
      ] },
    ],
  },
  {
    key: 'history', owner: 'lars', library: 'public', icon: '📜', lang: 'en-US', tags: 'history,dates',
    title: 'World history dates',
    description: 'Twenty-one dates that anchor the timeline, from Rome to the end of the Cold War.',
    sets: [
      { title: 'Key dates', description: 'Event → year.', cards: [
        ['Fall of the Western Roman Empire', '476', { notes: 'Romulus Augustulus is deposed by Odoacer.', tags: 'ancient' }],
        ['Charlemagne crowned emperor', '800', { notes: 'On Christmas Day, by Pope Leo III.', tags: 'medieval' }],
        ['Battle of Hastings', '1066', { notes: 'The Norman conquest of England.', tags: 'medieval' }],
        ['Magna Carta sealed', '1215', { tags: 'medieval' }],
        ['Gutenberg’s printing press', 'c. 1440', { tags: 'medieval' }],
        ['Fall of Constantinople', '1453', { notes: 'Taken by the Ottomans; end of the Byzantine Empire.', tags: 'medieval' }],
        ['Columbus reaches the Americas', '1492', { mnemonic: '“In fourteen hundred ninety-two, Columbus sailed the ocean blue.”', tags: 'early-modern' }],
        ['Luther’s Ninety-five Theses', '1517', { notes: 'Start of the Reformation.', tags: 'early-modern' }],
        ['US Declaration of Independence', '1776', { tags: 'modern' }],
        ['Storming of the Bastille', '1789', { notes: '14 July, start of the French Revolution.', tags: 'modern' }],
        ['Battle of Waterloo', '1815', { tags: 'modern' }],
        ['Start of the First World War', '1914', { tags: '20th-century' }],
        ['Russian Revolution', '1917', { tags: '20th-century' }],
        ['End of the First World War', '1918', { notes: 'Armistice on 11 November.', tags: '20th-century' }],
        ['Wall Street Crash', '1929', { tags: '20th-century' }],
        ['Start of the Second World War', '1939', { tags: '20th-century' }],
        ['End of the Second World War', '1945', { tags: '20th-century' }],
        ['Founding of the United Nations', '1945', { tags: '20th-century' }],
        ['First Moon landing', '1969', { notes: 'Apollo 11, 20 July.', tags: '20th-century' }],
        ['Fall of the Berlin Wall', '1989', { tags: '20th-century' }],
        ['Dissolution of the Soviet Union', '1991', { tags: '20th-century' }],
      ] },
    ],
  },
  {
    key: 'code', owner: 'sofia', icon: '💻', tags: 'programming,javascript,python',
    title: 'JavaScript & Python',
    description: 'Language gotchas and idioms. Mostly “what does this print?”.',
    sets: [
      { title: 'JavaScript', description: 'Run the snippet in your head.', cards: [
        ['```js\nconsole.log(typeof null);\n```', '`"object"`, a historical bug kept for compatibility.', { tags: 'types' }],
        ['```js\nconsole.log(0.1 + 0.2 === 0.3);\n```', '`false`: the sum is `0.30000000000000004` (binary floating point).', { tags: 'numbers' }],
        ['```js\nconsole.log([1, 2, 3].map((n) => n * 2));\n```', '`[2, 4, 6]`', { tags: 'arrays' }],
        ['```js\nconsole.log(\'5\' + 3, \'5\' - 3);\n```', '`53 2`: `+` concatenates when either side is a string, `-` converts to numbers.', { tags: 'types' }],
        ['`==` vs `===`', '`===` compares without type coercion; `==` coerces first, so `0 == \'\'` is `true`.', { tags: 'types' }],
        ['```js\nconst a = [3, 1, 10];\na.sort();\nconsole.log(a);\n```', '`[1, 10, 3]`: the default sort compares strings.', { example: '```js\na.sort((x, y) => x - y); // [1, 3, 10]\n```', tags: 'arrays' }],
        ['`let` vs `var`', '`let` is block-scoped and unusable before its declaration; `var` is function-scoped and hoisted.', { tags: 'scope' }],
        ['```js\nconst { a, ...rest } = { a: 1, b: 2, c: 3 };\nconsole.log(rest);\n```', '`{ b: 2, c: 3 }`', { tags: 'objects' }],
        ['What does `??` do?', 'Nullish coalescing: `x ?? y` gives `y` only when `x` is `null` or `undefined`. Unlike `||`, it keeps `0` and `\'\'`.', { tags: 'operators' }],
        ['```js\nsetTimeout(() => console.log(\'a\'), 0);\nPromise.resolve().then(() => console.log(\'b\'));\nconsole.log(\'c\');\n```', '`c`, `b`, `a`: synchronous code first, then microtasks (promises), then timers.', { tags: 'async' }],
        ['```js\nconsole.log(Number.isNaN(NaN), NaN === NaN);\n```', '`true false`: NaN is not equal to itself.', { tags: 'numbers' }],
        ['```js\nconst f = (x = 2) => x * 3;\nconsole.log(f(), f(5));\n```', '`6 15`', { tags: 'functions' }],
        ['```js\nconsole.log([1, 2, 3].reduce((sum, n) => sum + n, 0));\n```', '`6`', { tags: 'arrays' }],
        ['Optional chaining `a?.b`', 'Gives `undefined` instead of throwing when `a` is `null` or `undefined`.', { tags: 'operators' }],
        ['Copy an array without mutating it', '`[...arr]` or `arr.slice()` for a shallow copy; `structuredClone(arr)` for a deep one.', { tags: 'arrays' }],
      ] },
      { title: 'Python', description: 'Python 3.', cards: [
        ['```python\nprint(7 // 2, 7 % 2, 7 / 2)\n```', '`3 1 3.5`', { tags: 'numbers' }],
        ['```python\nprint([x * x for x in range(4)])\n```', '`[0, 1, 4, 9]`', { tags: 'lists' }],
        ['```python\nprint(\'flipp\'[::-1])\n```', '`ppilf`: a slice with step −1 reverses.', { tags: 'strings' }],
        ['```python\na = [1, 2]\nb = a\nb.append(3)\nprint(a)\n```', '`[1, 2, 3]`: `b` is the same list object.', { tags: 'lists' }],
        ['```python\ndef add(x, items=[]):\n    items.append(x)\n    return items\n\nadd(1)\nprint(add(2))\n```', '`[1, 2]`: the default list is created once, when the function is defined.', { example: '```python\ndef add(x, items=None):\n    items = [] if items is None else items\n```', tags: 'functions' }],
        ['`is` vs `==`', '`==` compares values; `is` checks identity (the same object). Use `is` for `None`.', { tags: 'types' }],
        ['```python\nprint(len({1, 2, 2, 3}))\n```', '`3`: sets drop duplicates.', { tags: 'sets' }],
        ['```python\nd = {\'a\': 1}\nprint(d.get(\'b\', 0))\n```', '`0`', { tags: 'dicts' }],
        ['Open a file so it is closed automatically', '```python\nwith open(\'notes.txt\') as f:\n    text = f.read()\n```', { tags: 'files' }],
        ['```python\nprint(bool([]), bool([0]))\n```', '`False True`: only empty containers are falsy.', { tags: 'types' }],
        ['```python\nx, *rest = [1, 2, 3]\nprint(rest)\n```', '`[2, 3]`', { tags: 'lists' }],
        ['What does `enumerate` yield?', 'Pairs `(index, item)`.', { example: '```python\nfor i, name in enumerate(names):\n    print(i, name)\n```', tags: 'loops' }],
        ['```python\nprint(sorted([\'b\', \'A\', \'c\']))\n```', '`[\'A\', \'b\', \'c\']`: uppercase letters sort before lowercase.', { tags: 'strings' }],
        ['```python\nprint(round(2.5), round(3.5))\n```', '`2 4`: round half to even (“banker’s rounding”).', { tags: 'numbers' }],
        ['A tuple with one element', '`(1,)`: the comma makes the tuple, not the parentheses.', { tags: 'types' }],
      ] },
    ],
  },
  {
    key: 'elements', owner: 'lars', library: 'public', icon: '⚗️', lang: 'en-US', tags: 'chemistry,science',
    title: 'Periodic table',
    description: 'Element symbols, both ways.',
    sets: [
      { title: 'First 20 elements', reverse: true, description: 'Hydrogen to calcium.', cards: [
        ['H', 'Hydrogen', { notes: 'Atomic number 1.' }], ['He', 'Helium', { notes: 'Atomic number 2. A noble gas.' }],
        ['Li', 'Lithium', { notes: 'Atomic number 3.' }], ['Be', 'Beryllium', { notes: 'Atomic number 4.' }],
        ['B', 'Boron', { notes: 'Atomic number 5.' }], ['C', 'Carbon', { notes: 'Atomic number 6.' }],
        ['N', 'Nitrogen', { notes: 'Atomic number 7. About 78% of air.' }], ['O', 'Oxygen', { notes: 'Atomic number 8.' }],
        ['F', 'Fluorine', { notes: 'Atomic number 9. The most electronegative element.' }], ['Ne', 'Neon', { notes: 'Atomic number 10.' }],
        ['Na', 'Sodium', { notes: 'Atomic number 11.', mnemonic: 'From Latin natrium.' }], ['Mg', 'Magnesium', { notes: 'Atomic number 12.' }],
        ['Al', 'Aluminium', { notes: 'Atomic number 13. US spelling: aluminum.' }], ['Si', 'Silicon', { notes: 'Atomic number 14.' }],
        ['P', 'Phosphorus', { notes: 'Atomic number 15.' }], ['S', 'Sulfur', { notes: 'Atomic number 16.' }],
        ['Cl', 'Chlorine', { notes: 'Atomic number 17.' }], ['Ar', 'Argon', { notes: 'Atomic number 18.' }],
        ['K', 'Potassium', { notes: 'Atomic number 19.', mnemonic: 'From Latin kalium.' }], ['Ca', 'Calcium', { notes: 'Atomic number 20.' }],
      ] },
      { title: 'Tricky symbols', description: 'Symbols that come from Latin (or German) names.', cards: [
        ['Fe', 'Iron', { mnemonic: 'Latin ferrum.' }], ['Cu', 'Copper', { mnemonic: 'Latin cuprum.' }],
        ['Ag', 'Silver', { mnemonic: 'Latin argentum, as in Argentina.' }], ['Au', 'Gold', { mnemonic: 'Latin aurum: “Ay, you! Give me back my gold.”' }],
        ['Sn', 'Tin', { mnemonic: 'Latin stannum.' }], ['Pb', 'Lead', { mnemonic: 'Latin plumbum, as in plumber.' }],
        ['Hg', 'Mercury', { mnemonic: 'Latin hydrargyrum, “water silver”.' }], ['W', 'Tungsten', { mnemonic: 'German Wolfram.' }],
        ['Sb', 'Antimony', { mnemonic: 'Latin stibium.' }], ['Zn', 'Zinc'], ['Ni', 'Nickel'], ['Pt', 'Platinum'],
        ['I', 'Iodine'], ['Kr', 'Krypton'], ['U', 'Uranium', { notes: 'Atomic number 92.' }],
      ] },
    ],
  },
];

// ---------- Helpers ----------
// Deterministic randomness so every seed produces the same history shape.
const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Solid-colour PNG (8-bit RGB), so card images go through the same files + ownership rows as real uploads.
export function png([r, g, b], size = 96) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, colour type RGB
  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then pixels
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

const m = model();

// Replays a learner's history through the real scheduler, day by day, so progress rows always match the review log.
function simulate(plan, items, { tz, configs, rng, t0 }) {
  const prog = new Map(), reviews = [];
  const today = startOfDay(t0, tz);
  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const active = d < (plan.idle || 0) ? false : d < plan.streak ? true : d === plan.streak ? false : rng() < plan.activity;
    if (!active) continue;
    const start = d ? today - d * DAY + Math.round((8 + rng() * 12) * HOUR) : Math.max(today + MIN, t0 - 50 * MIN);
    const end = d ? start + 2 * HOUR : t0 - MIN;
    const cap = !d ? plan.todayCap ?? 60 : d <= (plan.behind || 0) ? plan.reviewCap : 120;
    const due = items.filter((i) => { const p = prog.get(i.key); return p && !p.suspended && p.next_due <= start; })
      .sort((a, b) => weakFirst(prog.get(a.key), prog.get(b.key))).slice(0, cap); // same order as the study queue
    const left = new Map(), fresh = [];
    for (const i of items) {
      const n = left.get(i.course) ?? plan.newPerDay;
      if (!prog.has(i.key) && n > 0) { fresh.push(i); left.set(i.course, n - 1); }
    }
    const queue = [...due, ...(d ? fresh : fresh.slice(0, 3))];
    const later = []; // learning steps coming back later in the same session
    const tries = new Map();
    let t = start;
    while (t < end) {
      let item;
      later.sort((a, b) => a.at - b.at);
      // Today the learner walks away instead of waiting for learning steps, which leaves some cards in learning.
      if (later.length && (later[0].at <= t || (!queue.length && d))) { const l = later.shift(); t = Math.max(t, l.at); item = l.item; }
      else if (queue.length) item = queue.shift();
      else break;
      if (t >= end) break;
      const p = prog.get(item.key) || null;
      const hard = plan.hard?.[item.front] ?? SPANISH_TRAPS[item.front] ?? 1;
      const learning = !p || p.state !== STATE.REVIEW;
      const pass = learning ? (0.65 + 0.3 * plan.skill) * (0.6 + 0.4 * hard)
        : (1 - (1 - m.retrievability((t - p.last_reviewed) / DAY, p.stability)) * (1.6 - plan.skill)) * hard;
      const x = rng();
      const rating = rng() > pass ? 1 : x < 0.12 ? 2 : x > 0.9 && hard === 1 ? 4 : 3;
      const cfg = configs[item.course];
      const next = schedule(p, rating, t, { config: cfg });
      // Same leech rule as applyReview in routes/study.js.
      let { leech = 0, suspended = 0 } = p || {};
      if (next.lapsed && next.lapses >= cfg.leechThreshold && (next.lapses - cfg.leechThreshold) % Math.max(1, Math.floor(cfg.leechThreshold / 2)) === 0) {
        leech = 1;
        if (cfg.leechAction === 'suspend') suspended = 1;
      }
      reviews.push({ item, rating, ts: t, prev: p, was_new: p ? 0 : 1, state: p ? p.state : 0 });
      const { lapsed, ...row } = next;
      prog.set(item.key, { ...row, next_due: Math.round(row.next_due), suspended, leech });
      const n = (tries.get(item.key) || 0) + 1;
      tries.set(item.key, n);
      if (!suspended && (row.state === STATE.LEARNING || row.state === STATE.RELEARNING) && n < 4) later.push({ item, at: Math.round(row.next_due) });
      t += Math.round(5_000 + rng() * 15_000);
    }
  }
  return { prog, reviews };
}

const demoLike = `%${DOMAIN}`;

// Deletes everything the demo created. Returns upload file names to remove once the transaction commits.
async function wipe(t) {
  const record = json((await t.get("SELECT value FROM settings WHERE key = 'demo_seed'"))?.value, {});
  const DEMO = 'SELECT id FROM users WHERE email LIKE ?';
  const files = (await t.all(`SELECT name FROM uploads WHERE user_id IN (${DEMO})`, demoLike)).map((r) => r.name);
  await t.run(`DELETE FROM study_groups WHERE owner_id IN (${DEMO}) OR id = ?`, demoLike, Number(record.group) || 0);
  await t.run(`DELETE FROM audit_log WHERE user_id IN (${DEMO})`, demoLike);
  await t.run(`DELETE FROM uploads WHERE user_id IN (${DEMO})`, demoLike);
  await t.run('DELETE FROM users WHERE email LIKE ?', demoLike);
  await t.run("DELETE FROM settings WHERE key = 'demo_seed'");
  return files;
}

// ---------- Seed ----------
export async function seed({ forEmail, reset = false } = {}) {
  if (await needsSetup()) throw new Error('Finish instance setup first (create the admin account in the browser), then run the seed again.');
  const target = forEmail
    ? await db.get('SELECT id, email, name, prefs FROM users WHERE email = ?', String(forEmail).trim().toLowerCase())
    : await db.get("SELECT id, email, name, prefs FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!target) throw new Error(forEmail ? `No user with email ${forEmail}` : 'No admin account found');
  if (target.email.endsWith(DOMAIN)) throw new Error('Seed for a real account, not a demo user');
  const existing = Number((await db.get('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', demoLike)).n);
  if (existing && !reset) return { skipped: true };

  // Slow or file-system work happens before the transaction, which stays DB-only.
  const hashes = new Map();
  for (const u of USERS) hashes.set(u.key, await hashPassword(PASSWORD));
  const images = new Map();
  for (const c of COURSES) for (const s of c.sets) for (const [, , x] of s.cards) {
    if (!x?.color) continue;
    const buf = png(x.color);
    const name = `${crypto.randomBytes(16).toString('hex')}.png`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    images.set(x.color, { name, size: buf.length });
  }

  const t0 = now();
  const targetTz = json(target.prefs, {}).tz || process.env.TZ || 'UTC';
  let old = [];
  let result;
  try {
    result = await db.tx(async (t) => {
      if (reset) old = await wipe(t);
      else if (Number((await t.get('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', demoLike)).n)) throw new Error('Demo data appeared while seeding; run again');
      const counts = { users: 0, courses: 0, sets: 0, cards: 0, reviews: 0, groups: 0, uploads: images.size };
      const ids = { target: target.id };
      const users = {};
      for (const [i, u] of USERS.entries()) {
        const row = await t.get(`INSERT INTO users (email, name, password_hash, role, email_verified, prefs, created_at) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id`,
          `${u.key}${DOMAIN}`, u.name, hashes.get(u.key), u.role || 'user', JSON.stringify(u.prefs || {}), t0 - (95 - i) * DAY);
        users[u.key] = { ...u, id: row.id, email: `${u.key}${DOMAIN}` };
        ids[u.key] = row.id;
        counts.users++;
      }
      for (const img of images.values()) {
        await t.run('INSERT INTO uploads (name, user_id, size, kind, created_at) VALUES (?, ?, ?, ?, ?)', img.name, ids.lars, img.size, 'image', t0 - 85 * DAY);
      }

      // Courses, sets and cards. `course.items` = schedulable (card, variant) pairs in study order.
      const courses = {};
      const addCourse = async (def, ownerId, created, { title = def.title, visibility = 'private', status = 'none', featured = 0, clonedFrom = null, sets = def.sets } = {}) => {
        const c = await t.get(`INSERT INTO courses (owner_id, title, description, icon, tags, lang, visibility, publish_status, featured, cloned_from, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          ownerId, title, def.description, def.icon, def.tags, def.lang || '', visibility, status, featured, clonedFrom, created);
        const course = { id: c.id, key: def.key, sets: [], items: [], cards: new Map() };
        counts.courses++;
        for (const s of sets) {
          const row = await t.get('INSERT INTO sets (course_id, title, description, reverse, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
            c.id, s.title, s.description || '', s.reverse ? 1 : 0, created);
          const set = { id: row.id, title: s.title, reverse: !!s.reverse };
          course.sets.push(set);
          counts.sets++;
          for (const [pos, [front, back, x = {}]] of s.cards.entries()) {
            const type = front.includes('{{c1::') ? 'cloze' : 'basic';
            const img = x.color ? `/uploads/${images.get(x.color).name}` : null;
            const k = await t.get(`INSERT INTO cards (set_id, type, front, back, notes, mnemonic, example, image, tags, position, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
              set.id, type, front, back, x.notes || '', x.mnemonic || '', x.example || '', img, x.tags || '', pos, created);
            counts.cards++;
            course.cards.set(front, k.id);
            for (const v of variantsOf({ type, front }, set)) course.items.push({ key: `${k.id}:${v}`, card: k.id, variant: v, course: def.key, front });
          }
        }
        return course;
      };
      for (const [i, def] of COURSES.entries()) {
        const pub = def.library === 'public' || def.library === 'featured';
        courses[def.key] = await addCourse(def, ids[def.owner], t0 - (88 - i) * DAY, {
          visibility: pub ? 'public' : 'private', status: pub ? 'approved' : def.library === 'pending' ? 'pending' : 'none', featured: def.library === 'featured' ? 1 : 0,
        });
      }
      // Emma's private copy of the European capitals, cloned from the library.
      const capitals = COURSES.find((c) => c.key === 'capitals');
      courses.clone = await addCourse(capitals, ids.emma, t0 - 40 * DAY, { clonedFrom: courses.capitals.id, sets: capitals.sets.slice(0, 1) });

      // Sharing: co-editor and viewers.
      const share = (course, user, role, ago) => t.run('INSERT INTO course_members (course_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', courses[course].id, ids[user], role, t0 - ago * DAY);
      await share('math', 'target', 'editor', 50);
      await share('biology', 'target', 'viewer', 58);
      await share('code', 'target', 'viewer', 30);
      await share('biology', 'priya', 'editor', 45);
      await share('code', 'kenji', 'viewer', 20);

      // Groups: the teacher's class (target admin is a member) and the target admin's own club (target is its teacher).
      const addGroup = async (name, description, owner, created, members, courseKeys, assignments) => {
        const g = await t.get('INSERT INTO study_groups (name, description, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
          name, description, ids[owner], crypto.randomBytes(9).toString('base64url'), created);
        counts.groups++;
        for (const [user, role] of [[owner, 'teacher'], ...members.map((u) => [u, 'member'])]) {
          await t.run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', g.id, ids[user], role, created + DAY);
        }
        for (const key of courseKeys) await t.run('INSERT INTO group_courses (group_id, course_id, added_at) VALUES (?, ?, ?)', g.id, courses[key].id, created + DAY);
        for (const [title, key, setIndex, goal, dueDays] of assignments) {
          await t.run('INSERT INTO assignments (group_id, course_id, set_id, title, goal, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            g.id, courses[key].id, setIndex === null ? null : courses[key].sets[setIndex].id, title, goal, dueDays === null ? null : startOfDay(t0, targetTz) + dueDays * DAY + 23 * HOUR,
            ids[owner], created + 2 * DAY);
        }
        return g.id;
      };
      ids.class = await addGroup('Spanish 101 — Period 3', 'Tuesdays and Thursdays, room 204. Practise a little every day!', 'rivera', t0 - 62 * DAY,
        ['emma', 'liam', 'sofia', 'kenji', 'priya', 'target'], ['spanish', 'french'], [
          ['Learn the greetings', 'spanish', 0, 'study', -10],
          ['Master food & drink', 'spanish', 1, 'master', 5],
          ['Common verbs', 'spanish', 2, 'study', 12],
          ['French taster: everyday phrases', 'french', null, 'study', null],
        ]);
      ids.club = await addGroup('Swedish study club', 'Fika-powered Swedish practice. New sets every week.', 'target', t0 - 61 * DAY,
        ['emma', 'tom', 'liam', 'priya'], ['swedish', 'capitals'], [
          ['Numbers 1–10', 'swedish', 1, 'master', -4],
          ['Hej! Greetings both ways', 'swedish', 0, 'study', 3],
          ['Whole course', 'swedish', null, 'study', 21],
          ['European capitals', 'capitals', 0, 'study', null],
        ]);

      // Personal course settings: the target tags leeches in Spanish instead of suspending them.
      const prefs = { target: { spanish: { leechAction: 'tag', leechThreshold: 6 }, swedish: { newPerDay: 10 } }, emma: { spanish: { retention: 0.92 } } };
      for (const [user, byCourse] of Object.entries(prefs)) for (const [key, p] of Object.entries(byCourse)) {
        await t.run('INSERT INTO course_prefs (user_id, course_id, prefs) VALUES (?, ?, ?)', ids[user], courses[key].id, JSON.stringify(normalizeConfig(p)));
      }

      // Study history.
      const rng = mulberry32(20241007);
      const saved = new Set();
      for (const [who, plan] of Object.entries(PLANS)) {
        const uid = ids[who];
        const tz = who === 'target' ? targetTz : users[who].prefs?.tz || 'UTC';
        const configs = Object.fromEntries(plan.courses.map((k) => [k, normalizeConfig(prefs[who]?.[k])]));
        const items = plan.courses.flatMap((k) => courses[k].items);
        const { prog, reviews } = simulate(plan, items, { tz, configs, rng, t0 });
        for (const r of reviews) {
          const prev = r.prev && { user_id: uid, card_id: r.item.card, variant: r.item.variant, ...r.prev, buried_until: null };
          await t.run('INSERT INTO reviews (user_id, card_id, variant, rating, prev, ts, was_new, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            uid, r.item.card, r.item.variant, r.rating, prev ? JSON.stringify(prev) : null, r.ts, r.was_new, r.state);
        }
        counts.reviews += reviews.length;
        // Bury two due reviews for the target so "buried" shows up (as if skipped earlier today).
        const bury = who === 'target'
          ? new Set(items.filter((i) => { const p = prog.get(i.key); return p && p.state === STATE.REVIEW && !p.suspended && p.next_due <= t0; }).slice(-2).map((i) => i.key))
          : new Set();
        for (const i of items) {
          const p = prog.get(i.key);
          if (!p) continue;
          await t.run(`INSERT INTO progress (user_id, card_id, variant, state, step, stability, difficulty, lapses, reps, last_reviewed, next_due, suspended, leech, buried_until)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            uid, i.card, i.variant, p.state, p.step, p.stability, p.difficulty, p.lapses, p.reps, p.last_reviewed, p.next_due, p.suspended, p.leech,
            bury.has(i.key) ? startOfDay(t0, tz) + DAY : null);
        }
        // Studying a public course you don't own saves it to your home screen, like routes/study.js does.
        for (const k of plan.courses) {
          const def = COURSES.find((c) => c.key === k);
          const first = reviews.find((r) => r.item.course === k);
          if (first && def.library && def.library !== 'pending' && ids[def.owner] !== uid) saved.add(`${uid}:${courses[k].id}:${first.ts}`);
        }
      }
      for (const [user, key] of [['target', 'flags'], ['target', 'history'], ['tom', 'elements'], ['sofia', 'history'], ['liam', 'flags'], ['emma', 'hiragana']]) {
        saved.add(`${ids[user]}:${courses[key].id}:${t0 - 20 * DAY}`);
      }
      for (const s of saved) {
        const [uid, cid, ts] = s.split(':').map(Number);
        await t.run('INSERT INTO saved_courses (user_id, course_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, course_id) DO NOTHING', uid, cid, ts);
      }

      // Stars.
      const stars = { target: [['swedish', 'förlåt'], ['swedish', 'varsågod'], ['swedish', 'sju'], ['hiragana', 'ぬ'], ['hiragana', 'め'], ['spanish', 'saber'], ['biology', 'The {{c1::femur}} is the longest bone in the body.']],
        emma: [['spanish', 'estar'], ['swedish', 'kanelbulle']], kenji: [['hiragana', 'を']] };
      for (const [user, list] of Object.entries(stars)) for (const [key, front] of list) {
        await t.run('INSERT INTO stars (user_id, card_id) VALUES (?, ?)', ids[user], courses[key].cards.get(front));
      }

      // Match game leaderboards.
      const matches = [['swedish', 0, 'emma', 19_870, 3], ['swedish', 0, 'target', 24_310, 1], ['swedish', 0, 'tom', 33_050, 6], ['swedish', 0, 'liam', 41_200, 9],
        ['swedish', 0, 'target', 28_940, 12], ['flags', 0, 'tom', 28_400, 4], ['flags', 0, 'target', 35_900, 2], ['hiragana', 0, 'kenji', 15_200, 5],
        ['hiragana', 0, 'target', 47_800, 1], ['spanish', 0, 'emma', 22_500, 8], ['spanish', 0, 'sofia', 26_100, 7], ['spanish', 0, 'target', 31_700, 2]];
      for (const [key, set, user, ms, ago] of matches) {
        await t.run('INSERT INTO match_scores (set_id, user_id, ms, created_at) VALUES (?, ?, ?, ?)', courses[key].sets[set].id, ids[user], ms, t0 - ago * DAY - 5 * HOUR);
      }

      await t.run("INSERT INTO settings (key, value) VALUES ('demo_seed', ?)", JSON.stringify({ group: ids.club, target: target.id, at: t0 }));
      return { counts, ids, courses };
    });
  } catch (e) {
    for (const { name } of images.values()) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
    throw e;
  }
  for (const name of old) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });

  // Audit after commit: audit() writes through the global handle, outside the transaction.
  const { ids, courses } = result;
  const as = (key) => ({ id: ids[key], email: `${key}${DOMAIN}` });
  await audit(null, 'auth.login', { user: as('rivera') });
  await audit(null, 'group.created', { user: as('rivera'), target: `group:${ids.class}` });
  await audit(null, 'group.joined', { user: as('emma'), target: `group:${ids.class}` });
  await audit(null, 'course.publish_requested', { user: as('rivera'), target: `course:${courses.french.id}` });
  await audit(null, 'course.cloned', { user: as('emma'), target: `course:${courses.capitals.id}`, details: { into: courses.clone.id } });
  await audit(null, 'course.shared', { user: as('priya'), target: `course:${courses.math.id}`, details: { with: target.email, role: 'editor' } });
  await audit(null, 'demo.seeded', { user: target, details: { ...result.counts, reset } });

  return {
    counts: result.counts, target: target.email, password: PASSWORD,
    logins: USERS.map((u) => ({ email: `${u.key}${DOMAIN}`, name: u.name, role: u.role || 'user' })),
  };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--for');
  try {
    const r = await seed({ forEmail: at >= 0 ? args[at + 1] : undefined, reset: args.includes('--reset') });
    if (r.skipped) console.log('Demo data is already seeded (use --reset to delete and recreate it).');
    else {
      const c = r.counts;
      console.log(`Seeded demo data for ${r.target}: ${c.users} users, ${c.courses} courses, ${c.sets} sets, ${c.cards} cards, ${c.reviews} reviews, ${c.groups} groups, ${c.uploads} images.`);
      console.log(`\nDemo logins (password for all: ${r.password}):`);
      for (const u of r.logins) console.log(`  ${u.email.padEnd(28)} ${u.name} (${u.role})`);
      console.log(`\nRecreate with --reset. In Docker: ${DOCKER_HINT} --reset`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`[flipp] seed failed: ${e.message}`);
    if (/setup/.test(e.message)) console.error(`Then run: ${DOCKER_HINT}`);
    process.exit(1);
  }
}
