/**
 * Kami - book library stored in localStorage.
 *
 * On iOS the Pebble app backs localStorage with NSUserDefaults, which is
 * loaded whole when the Pebble app starts (see storage_test.js). So:
 *  - the library list (titles, links) is small and kept for every book;
 *  - full text is kept for at most TEXT_CACHE_MAX books, most recently
 *    opened first, and re-downloaded from its link when needed;
 *  - every key is prefixed with "kami:".
 *
 * Book ids are never reused, so a watch holding an old id can't land in
 * the wrong book. Id 0 is the built-in sample book.
 */

var LIBRARY_KEY = 'kami:library';
var TEXT_PREFIX = 'kami:text:';
var TEXT_CACHE_MAX = 2;
var SAMPLE_ID = 0;

function emptyLibrary() {
  return { nextId: 1, current: SAMPLE_ID, books: [] };
}

function load() {
  try {
    var raw = localStorage.getItem(LIBRARY_KEY);
    if (raw) {
      var lib = JSON.parse(raw);
      if (lib && lib.books) return lib;
    }
  } catch (e) {
    console.log('Library unreadable, starting fresh: ' + e);
  }
  return emptyLibrary();
}

function save(lib) {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
}

function find(lib, id) {
  for (var i = 0; i < lib.books.length; i++) {
    if (lib.books[i].id === id) return lib.books[i];
  }
  return null;
}

// Adding a link that's already in the library opens that book instead.
// Returns {book, existing}.
function add(lib, url, title) {
  for (var i = 0; i < lib.books.length; i++) {
    if (lib.books[i].url === url) {
      setCurrent(lib, lib.books[i].id);
      return { book: lib.books[i], existing: true };
    }
  }
  var book = {
    id: lib.nextId++,
    url: url,
    title: title || '',
    author: '',
    added: Date.now(),
    opened: Date.now()
  };
  lib.books.push(book);
  lib.current = book.id;
  save(lib);
  return { book: book, existing: false };
}

function setCurrent(lib, id) {
  var book = find(lib, id);
  if (!book && id !== SAMPLE_ID) return false;
  lib.current = id;
  if (book) book.opened = Date.now();
  save(lib);
  return true;
}

function remove(lib, id) {
  lib.books = lib.books.filter(function(b) { return b.id !== id; });
  localStorage.removeItem(TEXT_PREFIX + id);
  if (lib.current === id) {
    // Fall back to the most recently opened remaining book, or the sample
    var next = lib.books.slice().sort(function(a, b) { return b.opened - a.opened; })[0];
    lib.current = next ? next.id : SAMPLE_ID;
  }
  save(lib);
}

function getText(id) {
  return localStorage.getItem(TEXT_PREFIX + id);
}

// Store a book's prepared text, evicting the least recently opened texts
// beyond TEXT_CACHE_MAX. The current book is never evicted.
function putText(lib, id, text) {
  localStorage.setItem(TEXT_PREFIX + id, text);
  var book = find(lib, id);
  if (book) book.cached = true;

  // Keep the current book, the one just stored, then most recently opened
  var cached = lib.books.filter(function(b) { return b.cached; }).sort(function(a, b) {
    var pa = a.id === lib.current ? 2 : a.id === id ? 1 : 0;
    var pb = b.id === lib.current ? 2 : b.id === id ? 1 : 0;
    return pb - pa || b.opened - a.opened;
  });
  for (var i = TEXT_CACHE_MAX; i < cached.length; i++) {
    localStorage.removeItem(TEXT_PREFIX + cached[i].id);
    cached[i].cached = false;
    console.log('Evicted text of book ' + cached[i].id);
  }
  save(lib);
}

module.exports = {
  SAMPLE_ID: SAMPLE_ID,
  load: load,
  save: save,
  find: find,
  add: add,
  setCurrent: setCurrent,
  remove: remove,
  getText: getText,
  putText: putText
};
