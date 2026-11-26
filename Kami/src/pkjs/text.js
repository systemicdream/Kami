/**
 * Kami - text preparation: cleanup, chunking and Project Gutenberg handling.
 * Pure functions, so they can be tested under Node.
 */

// Pebble system fonts cover ASCII and Latin-1 but not typographic
// punctuation, so swap those for plain equivalents.
var REPLACEMENTS = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[​﻿]/g, '']
];

function normalizeText(text) {
  for (var i = 0; i < REPLACEMENTS.length; i++) {
    text = text.replace(REPLACEMENTS[i][0], REPLACEMENTS[i][1]);
  }
  text = text.replace(/\r\n?/g, '\n');
  // Paragraphs: blank-line separated blocks; single newlines inside are wraps
  var paragraphs = text.split(/\n\s*\n/);
  var out = [];
  for (var p = 0; p < paragraphs.length; p++) {
    var para = paragraphs[p].replace(/\s+/g, ' ').trim();
    if (para) out.push(para);
  }
  return out.join('\n');
}

function utf8Length(ch) {
  var code = ch.charCodeAt(0);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xD800 && code <= 0xDBFF) return 4; // surrogate pair (counted on high half)
  if (code >= 0xDC00 && code <= 0xDFFF) return 0;
  return 3;
}

// Split text into chunks of at most maxBytes UTF-8 bytes, breaking after
// whitespace so words and multi-byte characters are never split.
function chunkText(text, maxBytes) {
  var chunks = [];
  var start = 0;
  while (start < text.length) {
    var bytes = 0;
    var i = start;
    var lastBreak = -1;
    while (i < text.length) {
      var b = utf8Length(text[i]);
      if (bytes + b > maxBytes) break;
      bytes += b;
      i++;
      if (text[i - 1] === ' ' || text[i - 1] === '\n') lastBreak = i;
    }
    var end = i;
    if (i < text.length && lastBreak > start) end = lastBreak;
    // Never end between surrogate halves
    if (end < text.length && end > start && text.charCodeAt(end - 1) >= 0xD800 &&
        text.charCodeAt(end - 1) <= 0xDBFF) {
      end--;
    }
    chunks.push(text.substring(start, end));
    start = end;
  }
  return chunks;
}

// ---- Project Gutenberg -------------------------------------------------------

// Turn the links people are likely to paste into a plain-text download URL.
//   gutenberg.org/ebooks/1342            -> cache/epub/1342/pg1342.txt
//   gutenberg.org/ebooks/1342.txt.utf-8  -> same
//   gutenberg.org/files/1342/...         -> same
// Anything else is used as-is (any plain-text URL works).
function resolveBookUrl(input) {
  var url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  var m = url.match(/gutenberg\.org\/(?:ebooks|files|cache\/epub)\/(\d+)/i);
  if (m) return 'https://www.gutenberg.org/cache/epub/' + m[1] + '/pg' + m[1] + '.txt';
  return url;
}

// Gutenberg's main site rejects some networks (e.g. VPN exit nodes) with 503,
// so fall back to its official mirror. Non-Gutenberg URLs have one candidate.
var GUTENBERG_MIRRORS = ['https://www.gutenberg.org', 'https://gutenberg.pglaf.org'];

function downloadCandidates(url) {
  var m = String(url).match(/^https:\/\/www\.gutenberg\.org(\/cache\/epub\/\d+\/pg\d+\.txt)$/);
  if (!m) return [url];
  return GUTENBERG_MIRRORS.map(function(host) { return host + m[1]; });
}

function headerField(header, name) {
  var m = header.match(new RegExp('^' + name + ':[ \\t]*(.+)$', 'mi'));
  return m ? m[1].trim() : '';
}

// Gutenberg plain text marks italics as _word_ and leaves [Illustration: ...]
// placeholders, neither of which reads well on a watch.
function cleanGutenbergMarkup(body) {
  return body
    .replace(/\[Illustration(?::[^\]]*)?\]/gi, '')
    .replace(/(^|[\s(\["'])_([^_\n][^_]*?)_(?=[\s.,;:!?)\]"'-]|$)/gm, '$1$2');
}

// Remove Gutenberg's license header and footer and read title/author.
// Returns {title, author, body}; non-Gutenberg text passes through untouched.
function parseGutenberg(raw) {
  var text = String(raw).replace(/\r\n?/g, '\n');
  var start = text.search(/^\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*$/mi);
  if (start < 0) return { title: '', author: '', body: text };

  var header = text.substring(0, start);
  var bodyStart = text.indexOf('\n', start) + 1;
  var rest = text.substring(bodyStart);
  var end = rest.search(/^\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/mi);
  var body = end >= 0 ? rest.substring(0, end) : rest;

  body = cleanGutenbergMarkup(body);
  return {
    title: headerField(header, 'Title'),
    author: headerField(header, 'Author'),
    body: body
  };
}

// If UTF-8 text was decoded as Latin-1/Windows-1252 ("Aliceâ€™s"), undo it.
// Only applies when the telltale sequences appear and the whole text
// re-decodes cleanly, so correct text is never touched.
var WIN1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E,
  0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };

function repairUtf8(str) {
  if (!/[\u00C2-\u00F4][\u0080-\u00BF\u0152-\u2122]/.test(str)) return str;
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x100) bytes.push(c);
    else if (WIN1252[c] !== undefined) bytes.push(WIN1252[c]);
    else return str;  // a real non-Latin-1 character: the text wasn't mis-decoded
  }
  var escaped = '';
  for (var j = 0; j < bytes.length; j++) {
    escaped += bytes[j] < 0x80 ? String.fromCharCode(bytes[j]) : '%' + bytes[j].toString(16).toUpperCase();
  }
  try {
    return decodeURIComponent(escaped.replace(/%(?![0-9A-F]{2})/g, '%25'));
  } catch (e) {
    return str;  // not valid UTF-8 after all
  }
}

module.exports = {
  repairUtf8: repairUtf8,
  normalizeText: normalizeText,
  chunkText: chunkText,
  resolveBookUrl: resolveBookUrl,
  downloadCandidates: downloadCandidates,
  parseGutenberg: parseGutenberg
};
