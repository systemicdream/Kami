/**
 * Kami - PebbleKit JS
 * Milestone 3: Book import
 *
 * Downloads plain-text books (Project Gutenberg links work best), keeps a
 * library in localStorage, and serves the current book to the watch in
 * word-boundary chunks.
 *
 * Phone -> watch messages:
 *   CMD_CHUNK      a chunk of the requested book
 *   CMD_OPEN_BOOK  switch the watch to another book (from the settings page)
 *   CMD_STATUS     a line of text to show while the watch waits (downloading)
 */

var text = require('./text');
var library = require('./library');

var CMD_GET_CHUNK = 0;
var CMD_CHUNK = 1;
var CMD_GET_LIBRARY = 2;
var CMD_LIBRARY = 3;
var CMD_OPEN_BOOK = 4;
var CMD_STATUS = 5;

// Max UTF-8 bytes per chunk. The watch buffers CHUNK_MAX (1600) bytes and
// its AppMessage inbox is 2048 bytes, so leave headroom for the dictionary.
var CHUNK_BYTES = 1500;

// Settings page. config/index.html in this repo, served from GitHub Pages.
var CONFIG_URL = 'https://systemicdream.github.io/Kami/config/';

// Set to true to measure phone-side storage on launch (see storage_test.js).
var RUN_STORAGE_TEST = false;

var DOWNLOAD_TIMEOUT_MS = 60000;

// ---- Messaging -------------------------------------------------------------

// The watch handles one message at a time, so send in order and wait for acks.
var outbox = [];
var sending = false;

function send(dict) {
  outbox.push(dict);
  flush();
}

function flush() {
  if (sending || !outbox.length) return;
  sending = true;
  var dict = outbox.shift();
  Pebble.sendAppMessage(dict, function() {
    sending = false;
    flush();
  }, function(err) {
    console.log('Send failed (cmd ' + dict.KEY_CMD + '): ' + JSON.stringify(err && err.error || err));
    sending = false;
    flush();
  });
}

function sendStatus(message) {
  send({ 'KEY_CMD': CMD_STATUS, 'KEY_CHUNK_DATA': message });
}

function sendOpenBook(id, total) {
  send({ 'KEY_CMD': CMD_OPEN_BOOK, 'KEY_BOOK_ID': id, 'KEY_CHUNK_TOTAL': total });
}

// ---- Loaded book ------------------------------------------------------------

// Chunks of the current book, kept in memory while the app runs.
var loaded = null;        // {id, chunks}
var pending = null;       // chunk request waiting for a download: {book, chunk}
var downloading = null;   // id of the book being downloaded

function bookLabel(book) {
  return book.title ? '"' + book.title + '"' : 'book';
}

function loadChunks(lib, id) {
  if (loaded && loaded.id === id) return loaded;
  var prepared;
  if (id === library.SAMPLE_ID) {
    prepared = text.normalizeText(buildSampleText());
  } else {
    prepared = library.getText(id);
    if (prepared === null) {
      var book = library.find(lib, id);
      if (book && book.cached) {
        book.cached = false;
        library.save(lib);
      }
      return null;
    }
  }
  loaded = { id: id, chunks: text.chunkText(prepared, CHUNK_BYTES) };
  console.log('Loaded book ' + id + ': ' + loaded.chunks.length + ' chunks');
  return loaded;
}

function sendChunk(book, chunkIndex) {
  var data = book.chunks[chunkIndex];
  send({
    'KEY_CMD': CMD_CHUNK,
    'KEY_BOOK_ID': book.id,
    'KEY_CHUNK_INDEX': chunkIndex,
    'KEY_CHUNK_TOTAL': book.chunks.length,
    'KEY_CHUNK_DATA': data === undefined ? '' : data
  });
}

function handleChunkRequest(bookId, chunkIndex) {
  var lib = library.load();

  // The settings page switched books while the watch app was closed
  if (bookId !== lib.current) {
    console.log('Watch asked for book ' + bookId + ', current is ' + lib.current);
    var cur = loadChunks(lib, lib.current);
    sendOpenBook(lib.current, cur ? cur.chunks.length : -1);
    return;
  }

  var book = loadChunks(lib, bookId);
  if (book) {
    sendChunk(book, chunkIndex);
    return;
  }

  // Text not on the phone: download it, then answer
  pending = { book: bookId, chunk: chunkIndex };
  download(lib, library.find(lib, bookId));
}

// ---- Downloading ------------------------------------------------------------

function download(lib, book) {
  if (!book) return;
  if (downloading === book.id) {
    sendStatus('Downloading ' + bookLabel(book) + '...');
    return;
  }
  downloading = book.id;
  sendStatus('Downloading ' + bookLabel(book) + '...');
  console.log('Downloading book ' + book.id + ' from ' + book.url);

  fetchFirst(text.downloadCandidates(book.url), 0, null, function(body) {
    onDownloaded(book.id, body);
  }, function(reason) {
    onDownloadFailed(book.id, reason);
  });
}

// Try each URL in turn until one returns text.
function fetchFirst(urls, i, lastError, done, fail) {
  if (i >= urls.length) {
    fail(lastError || 'no URL');
    return;
  }
  var next = function(reason) {
    console.log('Download from ' + urls[i] + ' failed: ' + reason);
    fetchFirst(urls, i + 1, reason, done, fail);
  };
  var xhr = new XMLHttpRequest();
  xhr.open('GET', urls[i], true);
  xhr.timeout = DOWNLOAD_TIMEOUT_MS;
  xhr.onload = function() {
    if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) done(xhr.responseText);
    else next('HTTP ' + xhr.status);
  };
  xhr.onerror = function() { next('network error'); };
  xhr.ontimeout = function() { next('timed out'); };
  xhr.send();
}

function onDownloaded(id, raw) {
  downloading = null;
  var lib = library.load();
  var book = library.find(lib, id);
  if (!book) return;  // removed while downloading

  var parsed = text.parseGutenberg(raw);
  var prepared = text.normalizeText(parsed.body);
  if (!prepared) {
    onDownloadFailed(id, 'no text found');
    return;
  }
  if (!book.title && parsed.title) book.title = parsed.title;
  if (!book.author && parsed.author) book.author = parsed.author;
  if (!book.title) book.title = 'Untitled';
  library.putText(lib, id, prepared);
  console.log('Stored book ' + id + ' "' + book.title + '": ' + prepared.length + ' chars');

  if (loaded && loaded.id === id) loaded = null;
  var chunks = loadChunks(lib, id);
  if (pending && pending.book === id) {
    sendChunk(chunks, pending.chunk);
    pending = null;
  }
}

function onDownloadFailed(id, reason) {
  downloading = null;
  console.log('Download of book ' + id + ' failed: ' + reason);
  var lib = library.load();
  var book = library.find(lib, id);
  if (pending && pending.book === id) {
    // A book that has never downloaded probably has a bad link
    var neverWorked = book && !book.title;
    sendStatus("Couldn't download " + (book ? bookLabel(book) : 'book') + ' (' + reason + '). ' +
               (neverWorked ? 'Check the link in Kami settings.' : 'Retrying soon.'));
  }
}

// ---- Settings page ------------------------------------------------------------

function configUrl() {
  var lib = library.load();
  var state = {
    current: lib.current,
    books: lib.books.map(function(b) {
      return { id: b.id, title: b.title, author: b.author, url: b.url };
    })
  };
  return CONFIG_URL + '#' + encodeURIComponent(JSON.stringify(state));
}

function handleConfigResult(action) {
  var lib = library.load();

  if (action.add) {
    var url = text.resolveBookUrl(action.add.url);
    if (!url) return;
    var book = library.add(lib, url, action.add.title);
    console.log('Added book ' + book.id + ': ' + url);
    sendOpenBook(book.id, -1);  // watch will ask for chunk 0, which downloads it
    pending = { book: book.id, chunk: 0 };
    download(lib, book);
  } else if (action.open !== undefined) {
    if (!library.setCurrent(lib, action.open)) return;
    var cur = loadChunks(lib, action.open);
    sendOpenBook(action.open, cur ? cur.chunks.length : -1);
  } else if (action.remove !== undefined) {
    library.remove(lib, action.remove);
    if (loaded && loaded.id === action.remove) loaded = null;
    var next = loadChunks(lib, lib.current);
    sendOpenBook(lib.current, next ? next.chunks.length : -1);
  }
}

// ---- Events -------------------------------------------------------------------

Pebble.addEventListener('ready', function() {
  console.log('Kami JS ready');
  // Tell the watch which book is current; this also prompts it to re-send a
  // request it made before JS was running.
  var lib = library.load();
  var cur = loadChunks(lib, lib.current);
  sendOpenBook(lib.current, cur ? cur.chunks.length : -1);
  if (RUN_STORAGE_TEST) {
    setTimeout(function() { require('./storage_test').run(); }, 1000);
  }
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  var cmd = dict.KEY_CMD;

  if (cmd === CMD_GET_CHUNK) {
    handleChunkRequest(dict.KEY_BOOK_ID || 0, dict.KEY_CHUNK_INDEX || 0);
  } else if (cmd === CMD_GET_LIBRARY) {
    // TODO (milestone 4): send library list
  }
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(configUrl());
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) return;  // closed without choosing anything
  var action;
  try {
    action = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    console.log('Bad settings response: ' + e.response);
    return;
  }
  handleConfigResult(action);
});

// ---- Sample book --------------------------------------------------------------

function buildSampleText() {
  var paras = [
    '“It was the best of times, it was the worst of times, it was the age of wisdom, ' +
    'it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, ' +
    'it was the season of Light, it was the season of Darkness, it was the spring of hope, ' +
    'it was the winter of despair…”',
    'Welcome to Kami. Open the Kami settings in the Pebble app on your phone to add a book: ' +
    'paste a Project Gutenberg link, or any link to a plain-text file.'
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
