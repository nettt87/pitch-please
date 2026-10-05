# Pitch, Please!

A perfect pitch trainer that runs in the browser.

- **Identify** — hear a note and name it on a circle, a piano or a guitar neck; with a range of several octaves, name the exact key.
- **Sing** — sing a named note from memory; the tuner locks when you hold it within 20 cents.
- **Play** — play a named note on your own instrument (piano, guitar, …); one clean note is scored as soon as its pitch settles, with no need to hold it.
- **Explore** — play any pitch freely on a circle, a piano or a guitar neck.
- **Stats** — accuracy per note and best streak, saved in your own browser.
- **Tuner** — a chromatic tuner for any instrument, under the Settings button: note, cents to 0.1 and frequency to 0.01 Hz, green within ±2 cents, with A4 calibration.

The piano is a recorded grand: the [Salamander Grand Piano](samples/piano/README.md) by
Alexander Holm, CC BY 3.0. The guitar is a recorded steel-string acoustic: the University
of Iowa samples via tonejs-instruments (CC BY 3.0), and above D5 the Musyng Kite soundfont
(CC BY-SA 3.0); see [samples/guitar](samples/guitar/README.md).

Live: https://nettt87.github.io/pitch-please/

## Run locally

Plain HTML, CSS and JavaScript modules with no build step. Serve the folder over HTTP
(opening `index.html` from disk blocks the modules), for example on Windows:

```powershell
.\serve.ps1   # http://127.0.0.1:5173/
```

## Releasing

Every asset reference carries a version tag (`?v=15`) in `index.html` and in the module
imports in `src/`. Bump it everywhere in each release so browsers fetch the new files
together instead of mixing cached old modules with new ones.
