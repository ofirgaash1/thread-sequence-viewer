# Thread Sequence Viewer

A minimal public viewer for physical thread/string-art sequence exports.

The page autoloads `mona-lisa.zip`, autoplays, and supports drag/zoom on desktop and mobile.

Line thickness comes from the exported JSON `ratio` field (circle diameter / thread width, same as peel's `optimizationResolution / lineWidthPx`). Optional URL override:

```text
?ratio=600
```

To add another sequence, drop a `.zip` in `public/sequences/` and rebuild. A button is created automatically from the filename (for example `mona-lisa.zip` → "Mona Lisa"). Use **lowercase** filenames — GitHub Pages is case-sensitive (`OFIR.zip` and `ofir.zip` are different files).
