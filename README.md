# Pitch, Please!

A perfect pitch trainer that runs in the browser.

- **Identify** — hear a note and name it on a circle, a piano or a guitar neck; with a range of several octaves, name the exact key.
- **Sing** — sing a named note from memory; the tuner locks when you hold it within 20 cents.
- **Play** — play a named note on your own instrument (piano, guitar, …); one clean note is scored as soon as its pitch settles, with no need to hold it.
- **Explore** — play any pitch freely on a circle, a piano or a guitar neck.
- **Stats** — accuracy per note and best streak, saved in your own browser.

Live: https://nettt87.github.io/pitch-please/

## Run locally

Plain HTML, CSS and JavaScript modules with no build step. Serve the folder over HTTP
(opening `index.html` from disk blocks the modules), for example on Windows:

```powershell
.\serve.ps1   # http://127.0.0.1:5173/
```

## Releasing

Every asset reference carries a version tag (`?v=11`) in `index.html` and in the module
imports in `src/`. Bump it everywhere in each release so browsers fetch the new files
together instead of mixing cached old modules with new ones.
