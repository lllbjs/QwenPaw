# Model Accordion

[简体中文](./README.zh.md) · **English**

> Single-open provider accordion and pinned favorites for the QwenPaw chat
> model selector. Ported from
> [dsh-model-accordion](https://github.com/lllbjs/dsh-model-accordion)'s core idea:
> **decorate the DOM, never rewrite the selector** — model selection, OAuth
> checks and free-switch confirmations stay with the host.

## Features

- **Single-open accordion**: clicking a provider header expands it and collapses
  the others; click again to collapse. `Ctrl`/`Cmd`+click toggles independently.
- **Expand / collapse all** toolbar buttons (`⊞` / `⊟`) in the search row.
- **Favorites**: a star on every model row pins it to a `★` group at the top;
  clicking a favorite selects it through the host's own button. Starring never
  switches the current model. Keys prefer `providerId/modelId`; duplicate names
  fall back to name + row index. Removed models are marked *Unavailable*.
- **Count badges**: `· N` on each provider header; `● model · N` when collapsed
  and the provider owns the active model.
- **Provider sort**: `↺` cycles default → name A→Z → model count ↓, implemented
  with CSS `order` (React nodes are never moved).
- **Persistent state**: open providers, favorites and sort survive menu close
  and page refresh (`localStorage`).
- **Search passthrough**: the host force-expands while searching; the plugin
  stands down and filters the favorites group by the same query.
- **Keyboard**: `↓` from search enters headers, `↑`/`↓` move between headers,
  `→`/`←` expand/collapse; favorite rows are focusable and Enter-selectable.
- **zh/en** following the console language; hot-reload safe (`dispose()`).

## Install

```sh
./install.sh
```

Prefers the running backend's `POST /api/plugins/install` (hot-load, no
restart); falls back to a symlink into `~/.qwenpaw/plugins/model-accordion`
(restart required). Refresh the console page afterwards.

## Storage

`qwenpaw-model-accordion:{favorites,sort,single-open,open}` in `localStorage`.

## Diagnostics

`window.__qwenpawModelAccordion` exposes `version`, `rescan()`, `state()`,
`favorites()`, `sort()`, `refresh()`, `dispose()`. A console warning fires if a
model list is present but no provider sections match — update the `SEL`
selectors in `lib/client.js` when the host markup changes.

## License

Apache-2.0 (same as the QwenPaw repository).