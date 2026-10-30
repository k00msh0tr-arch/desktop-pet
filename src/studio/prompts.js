'use strict';
// The words of the sprite studio: what each pose is, the prompts for an image model (Gemini) that make them, and the
// request that gets Claude to write better ones from a personality. No electron in here, so it runs in the page, in the
// main process and in node tests alike.

// [key, what it is for, what she does, faces left]
const POSES = [
  ['idle', 'standing still', 'standing relaxed and facing the viewer, arms at her sides, a calm friendly expression', false],
  ['blink', 'eyes closed', 'exactly like the idle picture but with her eyes closed in a blink; nothing else changes', false],
  ['thinking', 'Claude is thinking', 'one hand at her chin, eyes looking up and to the side, a thoughtful expression', false],
  ['working', 'Claude is working', 'typing on an invisible keyboard in front of her, both hands forward, focused, a small determined smile', false],
  ['waiting', 'Claude needs you', 'waving one hand high to get attention, a hopeful, slightly impatient expression', false],
  ['happy', 'Claude is done', 'celebrating: a peace sign beside her face, a big happy smile, eyes closed with joy', false],
  ['thanks', 'you approved something', 'a small grateful bow or a hand over her heart, a warm smile', false],
  ['oops', 'a tool failed', 'embarrassed: one hand behind her head, an awkward laugh, a sweat drop', false],
  ['sleeping', 'nothing for 5 minutes', 'asleep on her feet, eyes closed, head tilted, relaxed; a small "z" is allowed', false],
  ['held', 'picked up', 'being lifted by the back of her clothes: dangling, arms and legs hanging limp, a surprised expression', false],
  ['fall', 'in the air', 'falling through the air: arms up, legs apart, hair and clothes flying upward, a startled expression', false],
  ['jump', 'between windows', 'mid-leap: knees bent, body stretched forward, one arm reaching ahead', true],
  ['sit', 'sitting down', 'sitting on the ground with her legs crossed, hands in her lap, relaxed, facing the viewer', false],
  ['walk', 'walking', 'walking in a side view, mid-stride, her near foot forward', true],
  ['walk2', 'second walking step', 'the same walk in side view, the other foot forward (the second step of the cycle)', true],
  ['climb', 'climbing', 'climbing a wall in a side view, one hand reaching up, one foot against the wall', true],
  ['climb2', 'second climbing grip', 'the same climb in side view, the other hand and foot up (the second grip of the cycle)', true],
];
const KEYS = POSES.map((p) => p[0]);
const MAX_PROMPT = 900;

// the rules every picture has to follow so the art tool can line the poses up; added to every prompt by code, so
// Claude's prompts never have to repeat them and a pose never forgets them
const RULES = 'Use the attached reference picture of the character: keep exactly the same face, hair, outfit, colours and art style. '
  + 'Full body from head to feet, centred, at the same size and camera distance as the reference, with her feet at the same height. '
  + 'A flat, solid green background (#00b140): no ground, no shadow, no gradient, no text, no border, no other characters or objects.';
const LEFT = ' Side view, facing left.';

const poseOf = (key) => POSES.find((p) => p[0] === key);

// what a pose is, written for the model; personality (optional) shows in the expression and body language
function describe(key, personality) {
  const [, , does] = poseOf(key);
  const first = key === 'idle'
    ? `Redraw the character from the attached picture as a clean game sprite: ${does}.`
    : `The same character, ${does}.`;
  return personality && personality.trim() ? `${first} Her personality: ${personality.trim()}. Let it show in her expression and body language, without changing her design.` : first;
}

// the full prompt for a pose: the pose part (Claude's or the template) plus the rules
function withRules(key, posePart) {
  return `${posePart.trim()} ${RULES}${poseOf(key)[3] ? LEFT : ''}`;
}

// { pose: prompt } for every pose, with no Claude involved
function templatePrompts({ personality = '', style = '' } = {}) {
  const out = {};
  for (const key of KEYS) out[key] = withRules(key, describe(key, personality) + (style.trim() ? ` Art style: ${style.trim()}.` : ''));
  return out;
}

// the request to paste into Claude; the answer goes back through parseReply
function claudeRequest({ name = 'her', personality = '', style = '' } = {}) {
  const list = POSES.map(([key, use, does]) => `- ${key} (${use}): ${does}${poseOf(key)[3] ? ' (side view, facing left)' : ''}`).join('\n');
  return `I am making sprites for a desktop pet character with an AI image model. The model will be given a reference picture of the character and one prompt per pose.

Character: ${name}
Personality: ${personality.trim() || '(not given: make her friendly)'}
Art style: ${style.trim() || '(whatever the reference picture looks like)'}

Write one prompt for each pose below. Each is 2 to 3 sentences describing ONLY the pose, expression and body language, in a way that shows her personality (what she does with her hands, how her face looks, small habits). Keep her design exactly as in the reference: never describe her hair, outfit or colours. Do not write about the background, size or framing: those rules are added to every prompt automatically.

Poses (a rough idea of each is given; improve on it with her personality):
${list}

Answer with ONLY a JSON object, no markdown fences and no other text, with exactly these keys: ${KEYS.join(', ')}. Every value is that pose's prompt as a string.`;
}

// Claude's answer -> { pose: prompt } with the rules added. Anything missing or unusable falls back to the template.
function parseReply(text, { personality = '', style = '' } = {}) {
  const fallback = templatePrompts({ personality, style });
  const start = String(text).indexOf('{'), end = String(text).lastIndexOf('}');
  let obj = null;
  if (start >= 0 && end > start) { try { obj = JSON.parse(String(text).slice(start, end + 1)); } catch { /* not JSON */ } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('I could not find the JSON in that answer. Ask Claude to answer with only the JSON object.');
  const out = {};
  let used = 0;
  for (const key of KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) { out[key] = withRules(key, v.trim().slice(0, MAX_PROMPT)); used++; } else out[key] = fallback[key];
  }
  if (!used) throw new Error('That answer has none of the poses in it.');
  return { prompts: out, used };
}

const api = { POSES, KEYS, RULES, templatePrompts, claudeRequest, parseReply };
if (typeof module !== 'undefined') module.exports = api; else window.StudioPrompts = api;
