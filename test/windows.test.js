'use strict';
const assert = require('assert');
const { parseX11 } = require('../src/windows');

assert.deepStrictEqual(parseX11(''), []);
assert.deepStrictEqual(parseX11('42,10,20,800,600,1;7,-5,0,1920,1080,0'), [
  { id: '42', x: 10, y: 20, w: 800, h: 600, fg: true },
  { id: '7', x: -5, y: 0, w: 1920, h: 1080, fg: false },
]);
console.log('windows: all tests passed');
