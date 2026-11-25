/**
 * Kami - PebbleKit JS
 * Milestone 2: Reading engine
 *
 * Holds books as plain text, splits them into word-boundary chunks and
 * serves chunks to the watch on request.
 */

var CMD_GET_CHUNK = 0;
var CMD_CHUNK = 1;
var CMD_GET_LIBRARY = 2;
var CMD_LIBRARY = 3;

// Max UTF-8 bytes per chunk. The watch buffers CHUNK_MAX (1600) bytes and
// its AppMessage inbox is 2048 bytes, so leave headroom for the dictionary.
var CHUNK_BYTES = 1500;

// Measure phone-side storage on launch (see storage_test.js). Blocks the JS
// thread while running, so the watch may show "Couldn't reach phone" until it
// finishes - press select to retry. When off, leftover probe data is removed.
// iPhone 17 Pro result (2026-11-25): 32 MB+ single value, 48 MB+ total,
// ~65 MB/s writes, survives a full Pebble app force-quit.
var RUN_STORAGE_TEST = false;

// ---- Text preparation ------------------------------------------------------

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

// ---- Books -----------------------------------------------------------------

function buildSampleText() {
  var paras = [
    '“It was the best of times, it was the worst of times, it was the age of wisdom, ' +
    'it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, ' +
    'it was the season of Light, it was the season of Darkness, it was the spring of hope, ' +
    'it was the winter of despair…”'
  ];
  // Numbered paragraphs of varying length make skipped or repeated text easy to spot
  var filler = [
    'This is test text for Kami.',
    'Each paragraph is numbered so you can check that no text is skipped or shown twice when turning pages.',
    'Pages should flow smoothly across chunk boundaries — the reader shouldn’t notice where one chunk ends.',
    'Press down or select to go forward and up to go back.',
    'Your place is saved when you leave the app.'
  ];
  for (var n = 1; n <= 60; n++) {
    var sentences = ['Paragraph ' + n + '.'];
    for (var s = 0; s < 1 + (n * 7) % 5; s++) sentences.push(filler[(n + s) % filler.length]);
    paras.push(sentences.join(' '));
  }
  paras.push('The End.');
  return paras.join('\n\n');
}

var books = {};

function addBook(id, title, rawText) {
  var chunks = chunkText(normalizeText(rawText), CHUNK_BYTES);
  books[id] = { id: id, title: title, chunks: chunks };
  console.log('Book ' + id + ' "' + title + '": ' + chunks.length + ' chunks');
}

addBook(0, 'Sample Book', buildSampleText());

// ---- Messaging -------------------------------------------------------------

function sendChunk(bookId, chunkIndex) {
  var book = books[bookId] || books[0];
  var data = book.chunks[chunkIndex];
  if (data === undefined) data = '';

  Pebble.sendAppMessage({
    'KEY_CMD': CMD_CHUNK,
    'KEY_BOOK_ID': book.id,
    'KEY_CHUNK_INDEX': chunkIndex,
    'KEY_CHUNK_TOTAL': book.chunks.length,
    'KEY_CHUNK_DATA': data
  }, function() {
    console.log('Sent chunk ' + chunkIndex + '/' + book.chunks.length);
  }, function(err) {
    console.log('Chunk ' + chunkIndex + ' send failed: ' + JSON.stringify(err));
  });
}

Pebble.addEventListener('ready', function() {
  console.log('Kami JS ready');
  if (RUN_STORAGE_TEST) {
    setTimeout(function() { require('./storage_test').run(); }, 1000);
  } else {
    setTimeout(function() {
      console.log('Purging storage probe data');
      try {
        require('./storage_test').purge();
      } catch (err) {
        console.log('Storage purge failed: ' + err);
      }
    }, 1000);
  }
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  var cmd = dict.KEY_CMD;

  if (cmd === CMD_GET_CHUNK) {
    sendChunk(dict.KEY_BOOK_ID || 0, dict.KEY_CHUNK_INDEX || 0);
  } else if (cmd === CMD_GET_LIBRARY) {
    console.log('Received library request');
    // TODO (milestone 4): send library list
  }
});

Pebble.addEventListener('showConfiguration', function() {
  // TODO (milestone 3): hosted config page for adding books
  var url = 'https://yourusername.github.io/kami-config/';
  Pebble.openURL(url);
});

Pebble.addEventListener('webviewclosed', function() {
  console.log('Configuration closed');
});

// Exported for local testing under Node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeText: normalizeText, chunkText: chunkText, buildSampleText: buildSampleText };
}
