---
title: "This website"
label: "This website"
category: "personal"
place: "Arco da Rua Augusta"
role: "Personal project"
tagline: "How this map was built"
# The arch at the top of Praça do Comércio: every coordinate on the map is measured from the square.
coordinates: [-9.136816, 38.708443]
order: 9.5
date: "2026-11"
images: []
stack: ["Astro", "React", "Three.js", "React Three Fiber", "TypeScript", "Python", "GeoPandas"]
links:
  - label: "Source code"
    url: "https://github.com/SalvaFerreira/site-salvador"
---

A map of Lisbon you can fly over, with the places I have worked and studied lit up in it. Everything you see is drawn in the browser from open data: there are no photos or map tiles.

- **The city.** 79,000 building footprints from OpenStreetMap, raised to their height (from the number of floors where it is mapped). A Python pipeline (GeoPandas, Shapely) cleans them, cuts them to the area and packs the whole city, streets and parks into about 3 MB of compact binary files. Trees and green spaces come from the Câmara Municipal de Lisboa's open data.
- **Drawing it.** Astro serves a static page; the city is a React island using Three.js through React Three Fiber. Roofs, windows and shop fronts are made by shaders, not textures, and anything that repeats (trees, cars, lamps, people) is drawn as one instanced mesh.
- **A city that lives.** Cars follow the real streets and stop at the 2,294 traffic lights and 8,354 zebra crossings mapped in OpenStreetMap; buses run on 80 real bus lines; trains, trams and funiculars on their tracks.
- **Light and weather.** The sun's position over Lisbon is worked out for the current minute, so the city follows the real day and night, and the weather is the real weather, from Open-Meteo.
- **Running smoothly.** Detail is drawn only near the camera, and the page lowers its own quality if a computer struggles to keep up.

Designed by me and built with Claude Code, an AI coding agent.
