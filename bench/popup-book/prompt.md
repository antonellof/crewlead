Build a 30-second film in Three.js, in this empty folder.

The film: a closed paper book sits on a table. It opens, and four pop-up paper worlds fold up out of its pages one after another: a castle, a jungle, a port with boats, and snowy mountain peaks. The camera moves between them. Paper look: flat colours, folded card, visible edges, soft shadows. At 30 seconds the book closes and the film loops.

Technical rules:
- Plain HTML and ES modules. No build step, no npm install.
- Load Three.js 0.170.0 from https://cdn.jsdelivr.net/npm/three@0.170.0/ with an import map.
- index.html is the entry point. Put the code in several modules under src/ (for example one per world, plus the book, camera, timeline).
- It plays automatically on load at full window size.
- The URL parameter ?t=SECONDS (for example index.html?t=12.5) jumps to that time and freezes the film there. This is used to take screenshots.
- No console errors.

When you are done, tell me the file list and how to view it (any static file server).
