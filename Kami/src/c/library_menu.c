/**
 * Kami - library menu
 *
 * Asks the phone for the book list each time the menu appears, so titles
 * and progress are fresh after reading or after changes in Settings.
 */

#include "library_menu.h"

#define MAX_BOOKS 32
#define TITLE_MAX 48
#define LIBRARY_TIMEOUT_MS 4000
#define LIBRARY_RETRIES 2

typedef struct {
  int16_t id;
  int8_t percent;  // -1 = never opened
  char title[TITLE_MAX];
} BookEntry;

typedef enum { MENU_LOADING, MENU_READY, MENU_ERROR } MenuState;

static Window *s_menu_window;
static MenuLayer *s_menu_layer;
static BookEntry s_books[MAX_BOOKS];
static int s_book_count = 0;
static MenuState s_menu_state = MENU_LOADING;
static int s_retries_left = 0;
static AppTimer *s_timer = NULL;
static bool s_waiting = false;  // a library request is outstanding
static char s_subtitle[32];

static void request_library(void);

// ---- Requests -------------------------------------------------------------

static void timer_callback(void *data) {
  s_timer = NULL;
  if (!s_waiting) return;
  if (s_retries_left-- > 0) {
    request_library();
    return;
  }
  // Keep showing a list we already had; otherwise show the error row
  s_waiting = false;
  if (s_book_count == 0) {
    s_menu_state = MENU_ERROR;
    if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
  }
}

static void request_library(void) {
  if (s_timer) app_timer_cancel(s_timer);
  // If the outbox is busy, the timer retries soon instead of waiting it out
  bool sent = comm_send_library_request();
  s_timer = app_timer_register(sent ? LIBRARY_TIMEOUT_MS : 300, timer_callback, NULL);
  if (!sent) s_retries_left++;  // a busy outbox doesn't use up a retry
}

static void start_loading(void) {
  s_waiting = true;
  s_retries_left = LIBRARY_RETRIES;
  if (s_book_count == 0) s_menu_state = MENU_LOADING;
  if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
  request_library();
}

// ---- Parsing --------------------------------------------------------------

void library_menu_handle_library(DictionaryIterator *iter) {
  Tuple *data = dict_find(iter, MESSAGE_KEY_KEY_LIBRARY_DATA);
  if (!data) return;

  s_book_count = 0;
  const char *p = data->value->cstring;
  while (*p && s_book_count < MAX_BOOKS) {
    const char *line_end = strchr(p, '\n');
    if (!line_end) line_end = p + strlen(p);

    // id \t percent \t title
    BookEntry *b = &s_books[s_book_count];
    b->id = atoi(p);
    const char *tab1 = strchr(p, '\t');
    const char *tab2 = tab1 && tab1 < line_end ? strchr(tab1 + 1, '\t') : NULL;
    if (tab1 && tab2 && tab2 < line_end) {
      b->percent = atoi(tab1 + 1);
      int len = line_end - (tab2 + 1);
      if (len > TITLE_MAX - 1) len = TITLE_MAX - 1;
      memcpy(b->title, tab2 + 1, len);
      b->title[len] = '\0';
      s_book_count++;
    }
    p = *line_end ? line_end + 1 : line_end;
  }

  s_menu_state = MENU_READY;
  s_waiting = false;
  if (s_timer) {
    app_timer_cancel(s_timer);
    s_timer = NULL;
  }
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
    // Highlight the book being read
    for (int i = 0; i < s_book_count; i++) {
      if (s_books[i].id == reader_book_id()) {
        menu_layer_set_selected_index(s_menu_layer, (MenuIndex){0, i}, MenuRowAlignCenter, false);
        break;
      }
    }
  }
}

// ---- Menu callbacks -------------------------------------------------------

static uint16_t get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return s_menu_state == MENU_READY ? s_book_count : 1;
}

static int16_t get_header_height(MenuLayer *menu, uint16_t section, void *ctx) {
  return PBL_IF_RECT_ELSE(MENU_CELL_BASIC_HEADER_HEIGHT, 0);
}

static void draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *data) {
  menu_cell_basic_header_draw(ctx, cell, "Library");
}

static int16_t get_cell_height(MenuLayer *menu, MenuIndex *index, void *ctx) {
  return PBL_IF_ROUND_ELSE(
      menu_layer_is_index_selected(menu, index) ? MENU_CELL_ROUND_FOCUSED_TALL_CELL_HEIGHT
                                                : MENU_CELL_ROUND_UNFOCUSED_SHORT_CELL_HEIGHT,
      44);
}

static void draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *data) {
  if (s_menu_state == MENU_LOADING) {
    menu_cell_basic_draw(ctx, cell, "Loading...", NULL, NULL);
    return;
  }
  if (s_menu_state == MENU_ERROR) {
    menu_cell_basic_draw(ctx, cell, "Phone not reachable", "Select to retry", NULL);
    return;
  }

  BookEntry *b = &s_books[index->row];
  int percent = b->percent;
  bool reading = b->id == reader_book_id();
  if (reading && reader_percent() >= 0) percent = reader_percent();

  if (reading) {
    snprintf(s_subtitle, sizeof(s_subtitle), "Reading - %d%%", percent < 0 ? 0 : percent);
  } else if (percent < 0) {
    snprintf(s_subtitle, sizeof(s_subtitle), "Not started");
  } else if (percent >= 100) {
    snprintf(s_subtitle, sizeof(s_subtitle), "Finished");
  } else {
    snprintf(s_subtitle, sizeof(s_subtitle), "%d%% read", percent);
  }
  menu_cell_basic_draw(ctx, cell, b->title, s_subtitle, NULL);
}

static void select_click(MenuLayer *menu, MenuIndex *index, void *ctx) {
  if (s_menu_state == MENU_ERROR) {
    start_loading();
    return;
  }
  if (s_menu_state != MENU_READY || index->row >= s_book_count) return;
  reader_open_book(s_books[index->row].id);
}

// ---- Window ---------------------------------------------------------------

static void menu_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_menu_layer = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_sections = NULL,
    .get_num_rows = get_num_rows,
    .get_header_height = get_header_height,
    .draw_header = draw_header,
    .get_cell_height = get_cell_height,
    .draw_row = draw_row,
    .select_click = select_click,
  });
  menu_layer_set_highlight_colors(s_menu_layer, PBL_IF_COLOR_ELSE(GColorDarkCandyAppleRed, GColorBlack),
                                  GColorWhite);
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void menu_window_appear(Window *window) {
  start_loading();
}

static void menu_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

void library_menu_init(void) {
  s_menu_window = window_create();
  window_set_window_handlers(s_menu_window, (WindowHandlers) {
    .load = menu_window_load,
    .appear = menu_window_appear,
    .unload = menu_window_unload,
  });
}

void library_menu_push(bool animated) {
  window_stack_push(s_menu_window, animated);
}

void library_menu_deinit(void) {
  if (s_timer) app_timer_cancel(s_timer);
  window_destroy(s_menu_window);
}
