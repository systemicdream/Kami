#pragma once

#include <pebble.h>

// Library menu: the list of books on the phone. Back from the reader lands
// here; selecting a book opens it in the reader.

void library_menu_init(void);
void library_menu_deinit(void);
void library_menu_push(bool animated);

// CMD_LIBRARY from the phone: KEY_LIBRARY_DATA holds one book per line,
// "id\tpercent\ttitle" (percent is -1 if never opened); KEY_BOOK_ID is the
// phone's current book.
void library_menu_handle_library(DictionaryIterator *iter);

// Provided by main.c
bool comm_send_library_request(void);
void reader_open_book(int book_id);
int reader_book_id(void);
int reader_percent(void);  // -1 if unknown
