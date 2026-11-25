/**
 * Kami - Pebble eBook Reader
 * Milestone 1: Plumbing
 * Hardcoded text in JS -> one chunk -> raw display on Emery
 */

#include <pebble.h>

#define CMD_GET_CHUNK 0
#define CMD_CHUNK 1
#define CMD_GET_LIBRARY 2
#define CMD_LIBRARY 3

#define APP_MESSAGE_BUFFER_SIZE 2048
#define REQUEST_TIMEOUT_MS 3000
#define MAX_RETRIES 3

static Window *s_window;
static TextLayer *s_text_layer;

static char s_chunk_buffer[2048];
static bool s_chunk_ready = false;
static int s_retry_count = 0;
static AppTimer *s_timeout_timer = NULL;

static void request_chunk(uint16_t book_id, uint16_t chunk_index);

static void timeout_timer_callback(void *data) {
  s_timeout_timer = NULL;
  if (s_retry_count < MAX_RETRIES) {
    s_retry_count++;
    APP_LOG(APP_LOG_LEVEL_WARNING, "Request timed out, retry %d/%d", s_retry_count, MAX_RETRIES);
    request_chunk(0, 0);
  } else {
    text_layer_set_text(s_text_layer, "Failed to load. Check phone connection.");
  }
}

static void start_timeout_timer() {
  if (s_timeout_timer) {
    app_timer_cancel(s_timeout_timer);
  }
  s_timeout_timer = app_timer_register(REQUEST_TIMEOUT_MS, timeout_timer_callback, NULL);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  APP_LOG(APP_LOG_LEVEL_DEBUG, "Inbox received callback fired");

  Tuple *cmd_tuple = dict_find(iterator, MESSAGE_KEY_KEY_CMD);
  if (!cmd_tuple) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "No CMD key in message");
    return;
  }

  uint8_t cmd = cmd_tuple->value->uint8;
  APP_LOG(APP_LOG_LEVEL_DEBUG, "Received cmd: %d", cmd);

  if (cmd == CMD_CHUNK) {
    if (s_timeout_timer) {
      app_timer_cancel(s_timeout_timer);
      s_timeout_timer = NULL;
    }
    s_retry_count = 0;

    Tuple *data_tuple = dict_find(iterator, MESSAGE_KEY_KEY_CHUNK_DATA);
    if (data_tuple) {
      APP_LOG(APP_LOG_LEVEL_DEBUG, "Got chunk data, length: %d", (int)strlen(data_tuple->value->cstring));
      strncpy(s_chunk_buffer, data_tuple->value->cstring, sizeof(s_chunk_buffer) - 1);
      s_chunk_buffer[sizeof(s_chunk_buffer) - 1] = '\0';
      s_chunk_ready = true;

      text_layer_set_text(s_text_layer, s_chunk_buffer);
      APP_LOG(APP_LOG_LEVEL_DEBUG, "Text set successfully");
    } else {
      APP_LOG(APP_LOG_LEVEL_ERROR, "No chunk data in message");
    }
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", reason);
}

static void outbox_failed_callback(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox send failed: %d", reason);
}

static void outbox_sent_callback(DictionaryIterator *iterator, void *context) {
  APP_LOG(APP_LOG_LEVEL_DEBUG, "Outbox send success");
}

static void request_chunk(uint16_t book_id, uint16_t chunk_index) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox begin failed: %d", result);
    return;
  }

  dict_write_uint8(iter, MESSAGE_KEY_KEY_CMD, CMD_GET_CHUNK);
  dict_write_uint16(iter, MESSAGE_KEY_KEY_BOOK_ID, book_id);
  dict_write_uint16(iter, MESSAGE_KEY_KEY_CHUNK_INDEX, chunk_index);

  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox send failed: %d", result);
  } else {
    start_timeout_timer();
  }
}

static void request_chunk_timer_callback(void *data) {
  request_chunk(0, 0);
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_text_layer = text_layer_create(GRect(4, 4, bounds.size.w - 8, bounds.size.h - 8));
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text(s_text_layer, "Loading...");
  text_layer_set_text_color(s_text_layer, GColorBlack);
  text_layer_set_background_color(s_text_layer, GColorWhite);
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeWordWrap);
  layer_add_child(window_layer, text_layer_get_layer(s_text_layer));

  // Delay request slightly to ensure AppMessage is ready
  app_timer_register(500, request_chunk_timer_callback, NULL);
}

static void window_unload(Window *window) {
  text_layer_destroy(s_text_layer);
}

static void init(void) {
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  // Set up AppMessage with modest buffer size
  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_register_outbox_sent(outbox_sent_callback);
  app_message_open(APP_MESSAGE_BUFFER_SIZE, APP_MESSAGE_BUFFER_SIZE);
}

static void deinit(void) {
  if (s_timeout_timer) {
    app_timer_cancel(s_timeout_timer);
  }
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
