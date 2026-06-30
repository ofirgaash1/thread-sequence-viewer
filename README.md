# Thread Sequence Viewer

A minimal public viewer for physical thread/string-art sequence exports.

The page autoloads `mona-lisa.zip`, autoplays, and supports drag/zoom on desktop and mobile.

URL parameters:

```text
?diameter=50&width=2
```

- `diameter`: circle diameter in centimeters
- `width`: thread width in millimeters

To add another sequence, place a zip in `public/sequences/` and add it to `SEQUENCES` in `src/ThreadSequenceViewer.tsx`.
