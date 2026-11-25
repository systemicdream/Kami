/**
 * Kami - Pebble eBook Reader
 * Milestone 2: Reading engine
 *
 * The phone sends a book as numbered chunks (~1.5 KB, split on word
 * boundaries). The watch keeps a small window of chunks in memory
 * (previous, current, next) and paginates them on the fly by measuring
 * text, so pages flow seamlessly across chunk boundaries.
 *
 * Reading position is (chunk index, byte offset) and is persisted on exit.
 */

#include <pebble.h>

// ---- Protocol -------------------------------------------------------------

#define CMD_GET_CHUNK 0
#define CMD_CHUNK 1
#define CMD_GET_LIBRARY 2
#define CMD_LIBRARY 3

#define INBOX_SIZE 2048
#define OUTBOX_SIZE 128
#define REQUEST_TIMEOUT_MS 3000
#define MAX_RETRIES 3

// ---- Persistence ----------------------------------------------------------

#define PERSIST_BOOK_ID 1
#define PERSIST_CHUNK 2
#define PERSIST_OFFSET 3

// ---- Buffers --------------------------------------------------------------

#define CHUNK_MAX 1600   // must exceed the JS-side CHUNK_BYTES
#define SLOT_COUNT 3     // prev, current, next
#define PAGE_MAX 1024    // more bytes than can ever fit on one screen
#define HISTORY_MAX 32   // page starts remembered for exact back-paging

#define PROGRESS_H 3

typedef struct {
  int16_t index;   // -1 = empty
  uint16_t len;
  char text[CHUNK_MAX];
} ChunkSlot;

typedef struct {
  int16_t chunk;
  uint16_t off;
} Pos;

typedef enum { STATE_LOADING, STATE_READY, STATE_ERROR } ReaderState;

static Window *s_window;
static Layer *s_page_layer;
static GFont s_font;
static GRect s_text_box;

static ChunkSlot s_slots[SLOT_COUNT];
static int s_book_id = 0;
static int s_chunk_total = -1;  // unknown until the first chunk arrives

static Pos s_start;             // start of the current page (raw, may sit on whitespace)
static Pos s_end;               // start of the following page
static bool s_at_end = false;   // current page is the last page of the book
static Pos s_history[HISTORY_MAX];
static int s_history_len = 0;
static bool s_back_pending = false;  // waiting for the previous chunk to page back

static ReaderState s_state = STATE_LOADING;
static char s_work[PAGE_MAX + 1];    // scratch text for measuring
static char s_display[PAGE_MAX + 1]; // text of the page on screen

static int s_inflight = -1;
static int s_retries = 0;
static AppTimer *s_timeout_timer = NULL;
static AppTimer *s_pump_timer = NULL;

static void pump_requests(void);
static void render(void);

// ---- Chunk cache ----------------------------------------------------------

static ChunkSlot *find_slot(int index) {
  if (index < 0) return NULL;
  for (int i = 0; i < SLOT_COUNT; i++) {
    if (s_slots[i].index == index) return &s_slots[i];
  }
  return NULL;
}

static bool chunk_exists(int index) {
  if (index < 0) return false;
  return s_chunk_total < 0 || index < s_chunk_total;
}

static bool chunk_wanted(int index) {
  int c = s_start.chunk;
  return index >= c - 1 && index <= c + 1;
}

static void store_chunk(int index, const char *text) {
  if (!chunk_wanted(index) || find_slot(index)) return;
  ChunkSlot *slot = NULL;
  for (int i = 0; i < SLOT_COUNT && !slot; i++) {
    if (s_slots[i].index < 0 || !chunk_wanted(s_slots[i].index)) slot = &s_slots[i];
  }
  if (!slot) return;
  slot->index = index;
  strncpy(slot->text, text, CHUNK_MAX - 1);
  slot->text[CHUNK_MAX - 1] = '\0';
  slot->len = strlen(slot->text);
}

static void reset_cache(void) {
  for (int i = 0; i < SLOT_COUNT; i++) s_slots[i].index = -1;
}

// ---- Text helpers ---------------------------------------------------------

static bool is_space(char ch) {
  return ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t';
}

static bool is_utf8_cont(char ch) {
  return ((uint8_t)ch & 0xC0) == 0x80;
}

static int utf8_floor(const char *buf, int n) {
  while (n > 0 && is_utf8_cont(buf[n])) n--;
  return n;
}

static int utf8_ceil(const char *buf, int n, int len) {
  while (n < len && is_utf8_cont(buf[n])) n++;
  return n;
}

static int16_t text_height(const char *text) {
  GSize size = graphics_text_layout_get_content_size(
      text, s_font, GRect(0, 0, s_text_box.size.w, 2000),
      GTextOverflowModeWordWrap, GTextAlignmentLeft);
  return size.h;
}

// Does buf[from, to) fit on one screen? Temporarily terminates the string.
static bool fits(char *buf, int from, int to) {
  char saved = buf[to];
  buf[to] = '\0';
  bool ok = text_height(buf + from) <= s_text_box.size.h;
  buf[to] = saved;
  return ok;
}

// Largest prefix of buf (len bytes) that fits, ending on a word boundary.
static int fit_forward(char *buf, int len) {
  if (len == 0 || fits(buf, 0, len)) return len;
  int lo = 0, hi = len;  // lo fits, hi doesn't
  while (hi - lo > 1) {
    int mid = (lo + hi) / 2;
    if (fits(buf, 0, utf8_floor(buf, mid))) lo = mid; else hi = mid;
  }
  int n = utf8_floor(buf, lo);
  if (n < len && !is_space(buf[n])) {
    int k = n;
    while (k > 0 && !is_space(buf[k - 1])) k--;
    if (k > 0) n = k;  // otherwise one giant word: hard cut
  }
  return n > 0 ? n : utf8_ceil(buf, 1, len);
}

// Smallest s such that buf[s, len) fits, starting on a word boundary.
static int fit_backward(char *buf, int len) {
  if (fits(buf, 0, len)) return 0;
  int lo = 0, hi = len;  // lo doesn't fit, hi fits
  while (hi - lo > 1) {
    int mid = (lo + hi) / 2;
    if (fits(buf, utf8_ceil(buf, mid, len), len)) hi = mid; else lo = mid;
  }
  int s = utf8_ceil(buf, hi, len);
  if (s > 0 && !is_space(buf[s - 1])) {
    int k = s;
    while (k < len && !is_space(buf[k])) k++;
    if (k < len) s = k;
  }
  while (s < len && is_space(buf[s])) s++;
  return s;
}

static Pos advance(Pos p, int bytes) {
  while (bytes > 0) {
    ChunkSlot *slot = find_slot(p.chunk);
    int remaining = slot ? slot->len - p.off : 0;
    if (bytes < remaining) {
      p.off += bytes;
      return p;
    }
    bytes -= remaining;
    p.chunk++;
    p.off = 0;
  }
  return p;
}

// ---- Pagination -----------------------------------------------------------

// Lay out the page at s_start. Returns false if more text must be loaded first.
static bool layout_page(void) {
  ChunkSlot *cur = find_slot(s_start.chunk);
  if (!cur) return false;

  // Skip whitespace at the start of the page (may cross into the next chunk)
  Pos p = s_start;
  while (true) {
    ChunkSlot *slot = find_slot(p.chunk);
    if (!slot) return false;
    while (p.off < slot->len && is_space(slot->text[p.off])) p.off++;
    if (p.off < slot->len || !chunk_exists(p.chunk + 1)) break;
    p.chunk++;
    p.off = 0;
  }

  // Compose current-chunk remainder + next chunk into s_work
  int len = 0;
  bool more_unloaded = false;
  for (int c = p.chunk; len < PAGE_MAX && chunk_exists(c); c++) {
    ChunkSlot *slot = find_slot(c);
    if (!slot) {
      more_unloaded = true;
      break;
    }
    int from = (c == p.chunk) ? p.off : 0;
    int take = slot->len - from;
    if (take > PAGE_MAX - len) take = utf8_floor(slot->text + from, PAGE_MAX - len);
    memcpy(s_work + len, slot->text + from, take);
    len += take;
  }
  s_work[len] = '\0';

  int n = fit_forward(s_work, len);
  if (n == len && more_unloaded) return false;  // page might continue into unloaded text

  // Trim trailing whitespace so a trailing newline doesn't push text off-screen
  int shown = n;
  while (shown > 0 && is_space(s_work[shown - 1])) shown--;
  memcpy(s_display, s_work, shown);
  s_display[shown] = '\0';

  s_start = p;
  s_end = advance(p, n);
  // Everything left in the book was composed and it all fit
  s_at_end = (n == len && !more_unloaded && len < PAGE_MAX);
  return true;
}

// Compute the page that ends at s_start. Returns false if the previous chunk is needed.
static bool page_back_estimate(Pos *out) {
  ChunkSlot *cur = find_slot(s_start.chunk);
  if (!cur) return false;

  int prev_take = 0;
  ChunkSlot *prev = NULL;
  if (s_start.off < PAGE_MAX && s_start.chunk > 0) {
    prev = find_slot(s_start.chunk - 1);
    if (!prev) return false;
    prev_take = PAGE_MAX - s_start.off;
    if (prev_take > prev->len) prev_take = prev->len;
    prev_take = prev->len - utf8_ceil(prev->text, prev->len - prev_take, prev->len);
  }

  int cur_take = s_start.off < PAGE_MAX ? s_start.off : PAGE_MAX;
  int cur_from = utf8_ceil(cur->text, s_start.off - cur_take, s_start.off);
  cur_take = s_start.off - cur_from;

  int len = 0;
  if (prev) {
    memcpy(s_work, prev->text + prev->len - prev_take, prev_take);
    len = prev_take;
  }
  memcpy(s_work + len, cur->text + cur_from, cur_take);
  len += cur_take;
  while (len > 0 && is_space(s_work[len - 1])) len--;
  s_work[len] = '\0';

  int s = fit_backward(s_work, len);
  if (s < prev_take) {
    out->chunk = s_start.chunk - 1;
    out->off = prev->len - prev_take + s;
  } else {
    out->chunk = s_start.chunk;
    out->off = cur_from + (s - prev_take);
  }
  return true;
}

static bool at_book_start(void) {
  if (s_start.chunk > 0) return false;
  ChunkSlot *cur = find_slot(0);
  if (!cur) return s_start.off == 0;
  for (int i = 0; i < s_start.off; i++) {
    if (!is_space(cur->text[i])) return false;
  }
  return true;
}

// ---- Navigation -----------------------------------------------------------

static void next_page(void) {
  if (s_state != STATE_READY || s_at_end) {
    if (s_at_end) vibes_short_pulse();
    return;
  }
  if (s_history_len == HISTORY_MAX) {
    memmove(s_history, s_history + 1, sizeof(Pos) * (HISTORY_MAX - 1));
    s_history_len--;
  }
  s_history[s_history_len++] = s_start;
  s_start = s_end;
  render();
  pump_requests();
}

static void prev_page(void) {
  if (s_state == STATE_ERROR || at_book_start()) return;
  if (s_history_len > 0) {
    s_start = s_history[--s_history_len];
    render();
    pump_requests();
    return;
  }
  Pos p;
  if (page_back_estimate(&p)) {
    s_back_pending = false;
    s_start = p;
    render();
  } else {
    s_back_pending = true;
  }
  pump_requests();
}

// ---- AppMessage -----------------------------------------------------------

static bool send_request(int chunk) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return false;
  dict_write_uint8(iter, MESSAGE_KEY_KEY_CMD, CMD_GET_CHUNK);
  dict_write_uint16(iter, MESSAGE_KEY_KEY_BOOK_ID, s_book_id);
  dict_write_uint16(iter, MESSAGE_KEY_KEY_CHUNK_INDEX, chunk);
  return app_message_outbox_send() == APP_MSG_OK;
}

static int next_missing_chunk(void) {
  int c = s_start.chunk;
  if (!find_slot(c)) return c;
  if (s_back_pending && c > 0 && !find_slot(c - 1)) return c - 1;
  if (chunk_exists(c + 1) && !find_slot(c + 1)) return c + 1;
  if (c > 0 && !find_slot(c - 1)) return c - 1;
  return -1;
}

static void timeout_callback(void *data) {
  s_timeout_timer = NULL;
  APP_LOG(APP_LOG_LEVEL_WARNING, "Chunk %d timed out (retry %d)", s_inflight, s_retries + 1);
  s_inflight = -1;
  if (++s_retries > MAX_RETRIES) {
    s_state = STATE_ERROR;
    layer_mark_dirty(s_page_layer);
    return;
  }
  pump_requests();
}

static void pump_timer_callback(void *data) {
  s_pump_timer = NULL;
  pump_requests();
}

static void pump_requests(void) {
  if (s_inflight >= 0 || s_state == STATE_ERROR) return;
  int want = next_missing_chunk();
  if (want < 0) return;
  if (send_request(want)) {
    s_inflight = want;
    s_timeout_timer = app_timer_register(REQUEST_TIMEOUT_MS, timeout_callback, NULL);
  } else if (!s_pump_timer) {
    s_pump_timer = app_timer_register(250, pump_timer_callback, NULL);  // outbox busy
  }
}

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  Tuple *cmd = dict_find(iter, MESSAGE_KEY_KEY_CMD);
  if (!cmd || cmd->value->uint8 != CMD_CHUNK) return;

  Tuple *book = dict_find(iter, MESSAGE_KEY_KEY_BOOK_ID);
  Tuple *index = dict_find(iter, MESSAGE_KEY_KEY_CHUNK_INDEX);
  Tuple *total = dict_find(iter, MESSAGE_KEY_KEY_CHUNK_TOTAL);
  Tuple *data = dict_find(iter, MESSAGE_KEY_KEY_CHUNK_DATA);
  if (!index || !total || !data) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Malformed chunk message");
    return;
  }
  if (book && (int)book->value->int32 != s_book_id) return;

  int idx = index->value->int32;
  if (idx != s_inflight) return;  // stale response

  if (s_timeout_timer) {
    app_timer_cancel(s_timeout_timer);
    s_timeout_timer = NULL;
  }
  s_inflight = -1;
  s_retries = 0;
  s_chunk_total = total->value->int32;

  // Saved position no longer valid (book changed): start over
  if (s_start.chunk >= s_chunk_total) {
    s_start = (Pos){0, 0};
    s_history_len = 0;
    reset_cache();
    pump_requests();
    return;
  }

  store_chunk(idx, data->value->cstring);

  if (s_back_pending) {
    Pos p;
    if (page_back_estimate(&p)) {
      s_back_pending = false;
      s_start = p;
    }
  }
  render();
  pump_requests();
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", reason);
}

static void outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox failed: %d", reason);
}

// ---- Drawing --------------------------------------------------------------

static void render(void) {
  if (s_state == STATE_ERROR) return;
  s_state = layout_page() ? STATE_READY : STATE_LOADING;
  layer_mark_dirty(s_page_layer);
}

static void draw_message(GContext *ctx, GRect bounds, const char *msg) {
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GRect box = grect_inset(bounds, GEdgeInsets(bounds.size.h / 2 - 30, 12, 0, 12));
  graphics_draw_text(ctx, msg, font, box, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

static void page_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorBlack);

  if (s_state == STATE_ERROR) {
    draw_message(ctx, bounds, "Couldn't reach phone.\nPress select to retry.");
    return;
  }
  if (s_state == STATE_LOADING) {
    draw_message(ctx, bounds, "Loading...");
    return;
  }

  graphics_draw_text(ctx, s_display, s_font, s_text_box,
                     GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);

  // Progress through the book
  if (s_chunk_total > 0) {
    ChunkSlot *cur = find_slot(s_start.chunk);
    int32_t permille = s_start.chunk * 1000;
    if (cur && cur->len) permille += (int32_t)s_start.off * 1000 / cur->len;
    permille /= s_chunk_total;
    if (s_at_end) permille = 1000;
#if defined(PBL_ROUND)
    graphics_context_set_stroke_color(ctx, GColorDarkGray);
    graphics_context_set_stroke_width(ctx, PROGRESS_H);
    graphics_draw_arc(ctx, grect_inset(bounds, GEdgeInsets(2)), GOvalScaleModeFitCircle,
                      0, DEG_TO_TRIGANGLE(360 * permille / 1000));
#else
    graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_fill_rect(ctx, GRect(0, bounds.size.h - PROGRESS_H,
                                  bounds.size.w * permille / 1000, PROGRESS_H), 0, GCornerNone);
#endif
  }
}

// ---- Buttons --------------------------------------------------------------

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  next_page();
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  prev_page();
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_state == STATE_ERROR) {
    s_state = STATE_LOADING;
    s_retries = 0;
    layer_mark_dirty(s_page_layer);
    pump_requests();
    return;
  }
  next_page();
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

// ---- Window ---------------------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_font = fonts_get_system_font(bounds.size.w >= 200 ? FONT_KEY_GOTHIC_24 : FONT_KEY_GOTHIC_18);
#if defined(PBL_ROUND)
  // Keep the box's corners inside the circle and clear of the progress arc.
  // TODO (polish): use screen text flow to fill more of the round display.
  s_text_box = grect_inset(bounds, GEdgeInsets(24, 30, 30, 30));
#else
  s_text_box = grect_inset(bounds, GEdgeInsets(2, 5, PROGRESS_H + 4, 5));
#endif

  s_page_layer = layer_create(bounds);
  layer_set_update_proc(s_page_layer, page_update_proc);
  layer_add_child(root, s_page_layer);

  pump_requests();
}

static void window_unload(Window *window) {
  layer_destroy(s_page_layer);
}

static void init(void) {
  reset_cache();
  if (persist_exists(PERSIST_CHUNK)) {
    s_book_id = persist_read_int(PERSIST_BOOK_ID);
    s_start.chunk = persist_read_int(PERSIST_CHUNK);
    s_start.off = persist_read_int(PERSIST_OFFSET);
  }

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
}

static void deinit(void) {
  persist_write_int(PERSIST_BOOK_ID, s_book_id);
  persist_write_int(PERSIST_CHUNK, s_start.chunk);
  persist_write_int(PERSIST_OFFSET, s_start.off);
  if (s_timeout_timer) app_timer_cancel(s_timeout_timer);
  if (s_pump_timer) app_timer_cancel(s_pump_timer);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
