# Quick Currency Converter

A no-build Chrome Manifest V3 extension that opens from the toolbar and converts between a persistent list of currencies.

## Features

- Default currencies on first install: USD, EUR, GBP
- Add currencies by searching code or name
- Persistent selected currency list via `chrome.storage.local`
- Debounced recalculation when any row value changes
- Primary API: exchangerate.fun
- Fallback API: frankfurter.dev

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select this folder.
5. Pin the extension and open it from the toolbar.

The popup fetches currencies and rates when it opens, then fetches fresh rates only after a user changes an amount or presses refresh.
