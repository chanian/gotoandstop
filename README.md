# gotoAndStop

A notebook of small interactive experiments, named after `gotoAndStop()` from the Flash days.
Each experiment lives in its own folder with its own `index.html`, and GitHub Pages serves them all.

**Site:** https://chanian.github.io/gotoandstop/

| # | Experiment | Live |
| --- | --- | --- |
| 01 | [Whiskey Caustics](caustics/): the whiskey glass from *Final Fantasy: The Spirits Within*, with real-time caustics you can slosh around | [view](https://chanian.github.io/gotoandstop/caustics/) |

## Adding an experiment

1. Make a folder, e.g. `my-thing/`, with an `index.html`. It gets served at `/gotoandstop/my-thing/`.
2. Use relative paths for assets, and load libraries from a CDN (no build step).
3. Add a card to the root `index.html` with `data-frame="N"`. It shows up as a keyframe on the timeline.
   A 16:9 `thumb.jpg` in the folder makes a good card image.
4. Add a row to the table above, then push.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.
