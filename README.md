# Thread Sequence Viewer

A minimal public viewer for physical thread/string-art sequence exports.

The page autoloads the first sequence in the manifest, autoplays, and supports drag/zoom on desktop and mobile.

Line thickness comes from the exported JSON `ratio` field (circle diameter / thread width, same as peel's `optimizationResolution / lineWidthPx`). Optional URL override:

```text
?ratio=600
```

The gallery is `public/sequences/manifest.json` (copied to `docs/sequences/` on build), read at runtime. Peel Studio's Publish adds artworks to it. To add one by hand, drop a lowercase `.zip` in `public/sequences/` and rebuild: unlisted zips are appended to the manifest (groups and labels for the built-in ones are set in `scripts/generateSequenceManifest.mjs`).

To delete an artwork from the live site, hover it in the gallery and click the trash icon. The site asks for a GitHub fine-grained token with Contents read/write on this repository only, then commits the removal (zip and manifest entry, in both `public/` and `docs/`) through the GitHub API. Pages redeploys in about a minute. Run `git pull` locally afterwards.

## 3D (prototype)

The **3D** switch (or `?3d`, with `&lift=N` for N× taller and `&cell=N` for the pile's cell size in thread widths,
default 6) shows the threads as built, stacked, with the same playback (`src/Viewer3D.tsx`). Each thread is taut: it
rests on the pile already under its path and is straight between the points it rests on (the upper hull, so its slope
only decreases from nail to nail). The pile is the threads' volume spread over the cells they cross (their local
density, pressed together by tension); a lifted thread adds only its volume, not its lifted span, which would compound
into towers. Near its own nails a thread adds nothing (the threads of one nail fan out around it). Drag to turn,
scroll to zoom, double-click to reset.
