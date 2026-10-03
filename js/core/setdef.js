// set.def / box.def の解析(DTXManiaAI SetDef.cs = NX CSetDef 移植)。
// 1 つの set.def は複数のブロック(曲)を持ち、各曲は最大 5 難易度(#LxFILE / #LxLABEL)を持つ。

import { splitLines } from './encoding.js';

const DEFAULT_LABELS = ['NOVICE', 'REGULAR', 'EXPERT', 'MASTER', 'DTXMania'];

function newBlock() {
  return { inUse: false, title: '', genre: '', fontColor: '', files: ['', '', '', '', ''], labels: ['', '', '', '', ''] };
}

function finish(block) {
  for (let i = 0; i < 5; i++) {
    if (block.files[i] && !block.labels[i]) block.labels[i] = DEFAULT_LABELS[i];
    if (block.labels[i] && !block.files[i]) block.labels[i] = '';
  }
  return block;
}

function trimParam(s) {
  return s.replace(/^[:\s]+/, '').replace(/\s+$/, '');
}

/**
 * @param {string} text
 * @returns {{title:string, genre:string, fontColor:string, files:string[], labels:string[]}[]}
 */
export function parseSetDef(text) {
  const blocks = [];
  let block = newBlock();
  for (const rawLine of splitLines(text)) {
    let s = rawLine.replace(/^[ \t]+/, '');
    if (!s.startsWith('#')) continue;
    const semi = s.indexOf(';');
    if (semi !== -1) s = s.slice(0, semi);
    const up = s.toUpperCase();
    if (up.startsWith('#TITLE')) {
      if (block.inUse) {
        blocks.push(finish(block));
        block = newBlock();
      }
      block.title = trimParam(s.slice(6));
      block.inUse = true;
    } else if (up.startsWith('#GENRE')) {
      block.genre = trimParam(s.slice(6));
      block.inUse = true;
    } else if (up.startsWith('#FONTCOLOR')) {
      block.fontColor = trimParam(s.slice(10)).replace(/^#/, '');
      block.inUse = true;
    } else {
      const m = /^#L([1-5])(FILE|LABEL)/.exec(up);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        const val = trimParam(s.slice(m[0].length));
        if (m[2] === 'FILE') block.files[idx] = val;
        else block.labels[idx] = val;
        block.inUse = true;
      }
    }
  }
  if (block.inUse) blocks.push(finish(block));
  return blocks;
}

/**
 * box.def(フォルダの表示名)。#TITLE / #GENRE / #ARTIST / #COMMENT だけを拾う。
 * @param {string} text
 */
export function parseBoxDef(text) {
  const out = { title: '', genre: '', artist: '', comment: '' };
  for (const rawLine of splitLines(text)) {
    let s = rawLine.replace(/^[ \t]+/, '');
    if (!s.startsWith('#')) continue;
    const semi = s.indexOf(';');
    if (semi !== -1) s = s.slice(0, semi);
    const up = s.toUpperCase();
    for (const key of ['TITLE', 'GENRE', 'ARTIST', 'COMMENT']) {
      if (up.startsWith('#' + key)) {
        out[key.toLowerCase()] = trimParam(s.slice(key.length + 1));
      }
    }
  }
  return out;
}
