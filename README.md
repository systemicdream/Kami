# Kami

An eBook reader for Pebble smartwatches — turning your Pebble into the world's smallest eReader.

> [!WARNING]
> **Work in Progress:** Kami is still in active development and is **not ready to be used**. Features are incomplete and things may break or change without notice.

## Overview

Kami streams plain-text books from your phone to your Pebble watch in small chunks so you can read on the watch without running out of memory.

- **Watch app (`Kami/src/c/`)** — Written in C for Pebble SDK 3. Maintains a small sliding window of text chunks in memory, paginates on the fly, and saves your reading position.
- **Companion JS (`Kami/src/pkjs/`)** — PebbleKit JS code that downloads plain-text books (such as Project Gutenberg links), stores your library on the phone, and sends word-boundary chunks to the watch over AppMessage.
- **Settings page (`config/`)** — Static web page (published via GitHub Pages) for adding books and managing your library from the Pebble phone app.

## Target Platforms

Configured for Pebble SDK 3 on:
- `basalt`
- `chalk`
- `diorite`
- `emery`
- `flint`

## Building

Requires the Pebble SDK (`pebble` CLI):

```sh
cd Kami
pebble build
```

## License

MIT — see [LICENSE](LICENSE).
