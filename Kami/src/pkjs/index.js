/**
 * Kami - PebbleKit JS
 * Milestone 1: Plumbing
 */

var CMD_GET_CHUNK = 0;
var CMD_CHUNK = 1;
var CMD_GET_LIBRARY = 2;
var CMD_LIBRARY = 3;

// Hardcoded book for milestone 1
var HARDCODED_BOOK = {
  id: 0,
  title: "Sample Book",
  chunks: [
    "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us, we were all going direct to Heaven, we were all going direct the other way."
  ]
};

Pebble.addEventListener('ready', function(e) {
  console.log('Kami JS ready');
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  var cmd = dict.KEY_CMD;

  if (cmd === CMD_GET_CHUNK) {
    var bookId = dict.KEY_BOOK_ID;
    var chunkIndex = dict.KEY_CHUNK_INDEX;
    console.log('Received chunk request: book=' + bookId + ', chunk=' + chunkIndex);

    var chunkData = HARDCODED_BOOK.chunks[chunkIndex] || "";
    var chunkTotal = HARDCODED_BOOK.chunks.length;

    Pebble.sendAppMessage({
      'KEY_CMD': CMD_CHUNK,
      'KEY_CHUNK_INDEX': chunkIndex,
      'KEY_CHUNK_TOTAL': chunkTotal,
      'KEY_CHUNK_DATA': chunkData
    }, function() {
      console.log('Chunk sent successfully');
    }, function(err) {
      console.log('Chunk send failed: ' + JSON.stringify(err));
    });
  } else if (cmd === CMD_GET_LIBRARY) {
    console.log('Received library request');
    // TODO: implement library response
  }
});

Pebble.addEventListener('showConfiguration', function() {
  var url = 'https://yourusername.github.io/kami-config/';
  console.log('Showing configuration: ' + url);
  Pebble.openURL(url);
});

Pebble.addEventListener('webviewclosed', function(e) {
  console.log('Configuration closed');
  // TODO: process config data
});
