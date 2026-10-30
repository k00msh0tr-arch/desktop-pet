'use strict';
const assert = require('assert');
const { POSES, KEYS, RULES, templatePrompts, claudeRequest, parseReply } = require('../src/studio/prompts');

assert.strictEqual(KEYS.length, 17);
assert.deepStrictEqual(KEYS, ['idle', 'blink', 'thinking', 'working', 'waiting', 'happy', 'thanks', 'oops', 'sleeping', 'held', 'fall', 'jump', 'sit', 'walk', 'walk2', 'climb', 'climb2']);

// templates: every pose, the rules on every one, the personality in, and left-facing poses say so
const t = templatePrompts({ personality: 'cheerful but clumsy', style: 'soft anime' });
assert.deepStrictEqual(Object.keys(t), KEYS);
for (const key of KEYS) {
  assert(t[key].includes(RULES), `${key} carries the rules`);
  assert(t[key].includes('cheerful but clumsy') && t[key].includes('soft anime'), `${key} carries the personality and style`);
}
for (const [key, , , left] of POSES) assert.strictEqual(t[key].endsWith('Side view, facing left.'), left, `${key} facing`);
assert(!templatePrompts()[KEYS[3]].includes('Her personality'), 'no personality, no personality sentence');

// the request lists every pose and the personality
const req = claudeRequest({ name: 'Mia', personality: 'shy, loves tea' });
assert(req.includes('Mia') && req.includes('shy, loves tea'));
for (const key of KEYS) assert(req.includes(`- ${key} (`), `request lists ${key}`);

// Claude's answer, in the shapes it comes in
const reply = JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, `She does the ${k} thing shyly.`])));
for (const wrapped of [reply, `\`\`\`json\n${reply}\n\`\`\``, `Sure! Here you go:\n${reply}\nAnything else?`]) {
  const r = parseReply(wrapped, { personality: 'shy' });
  assert.strictEqual(r.used, 17);
  assert(r.prompts.walk.startsWith('She does the walk thing shyly.') && r.prompts.walk.includes(RULES) && r.prompts.walk.endsWith('facing left.'));
}

// missing, empty and wrong-typed poses fall back to the template; unusable answers are refused
const partial = parseReply(JSON.stringify({ idle: 'Stands tall.', blink: '', thinking: 42, nonsense: 'x' }), { personality: 'shy' });
assert.strictEqual(partial.used, 1);
assert(partial.prompts.idle.startsWith('Stands tall.'));
assert(partial.prompts.thinking.includes('Her personality: shy'), 'a bad entry becomes the template');
assert.deepStrictEqual(Object.keys(partial.prompts), KEYS);
assert.throws(() => parseReply('no json here'), /could not find the JSON/);
assert.throws(() => parseReply('{ broken'), /could not find the JSON/);
assert.throws(() => parseReply('["a", "b"]'), /could not find the JSON/);
assert.throws(() => parseReply('{ "nothing": "useful" }'), /none of the poses/);
assert(parseReply(JSON.stringify({ idle: 'x'.repeat(5000) })).prompts.idle.length < 1400, 'a runaway prompt is cut');

console.log('studio: all tests passed');
