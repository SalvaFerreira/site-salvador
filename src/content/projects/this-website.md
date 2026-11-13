---
title: "This website"
label: "This website"
category: "personal"
place: "Arco da Rua Augusta"
role: "Personal project"
tagline: "How this map was built"
# The arch at the top of Praça do Comércio: every coordinate on the map is measured from the square.
coordinates: [-9.136816, 38.708443]
# The arch is modelled by hand, not a building: the label stands above it.
spot: 36
order: 9.5
date: "2026-11"
images:
  - src: "/videos/city-day-to-night.mp4"
    poster: "/videos/city-day-to-night.jpg"
    alt: "The Baixa from late afternoon to night: the sun goes down and the street lamps come on."
  - src: "/videos/city-flight.mp4"
    poster: "/videos/city-flight.jpg"
    alt: "The camera flies from the whole city down to the Arco da Rua Augusta."
  - src: "/images/height-model.svg"
    alt: "Bar chart of the mean height error by building height. Up to 7 m: model 1.6 m, previous method 2.75 m. 7 to 13 m: 1.48 and 1.68. 13 to 22 m: 2.18 and 2.33. 22 to 40 m: 4.85 and 5.36. Above 40 m, 292 buildings: 20.2 and 19.65."
stack: ["Astro", "React", "Three.js", "React Three Fiber", "TypeScript", "Python", "GeoPandas", "scikit-learn"]
links:
  - label: "Source code"
    url: "https://github.com/SalvaFerreira/site-salvador"
---

A map of Lisbon you can fly over, with the places I have worked and studied lit up in it. Everything you see is drawn in the browser from open data: there are no photos or map tiles.

- **The city.** 79,000 building footprints from OpenStreetMap, raised to their height (from the number of floors where it is mapped). A Python pipeline (GeoPandas, Shapely) cleans them, cuts them to the area and packs the whole city, streets and parks into under 4 MB of compact binary files. Trees and green spaces come from the Câmara Municipal de Lisboa's open data.
- **Heights, learnt.** About 70% of the buildings have no height or number of floors in OpenStreetMap. A gradient-boosted model (scikit-learn), trained on the 23,819 that do, predicts the rest from each building's shape and kind and from its surroundings, rounded to whole floors. Tested on parts of the city it had not seen (spatial cross-validation, 600 m squares held out), it is off by 2.3 m on average, against 2.8 m for the rule it replaced (the median of the nearest mapped buildings), and puts 84% of buildings within one floor of their real height, against 78%. It helps most with low buildings; above 40 m both are about 20 m off (chart below).
- **Drawing it.** Astro serves a static page; the city is a React island using Three.js through React Three Fiber. Roofs, windows and shop fronts are made by shaders, not textures, and anything that repeats (trees, cars, lamps, people) is drawn as one instanced mesh.
- **A city that lives.** Cars follow the real streets and stop at the 2,294 traffic lights and 8,354 zebra crossings mapped in OpenStreetMap; buses run on 80 real bus lines; trains, trams and funiculars on their tracks.
- **Light and weather.** The sun's position over Lisbon is worked out for the current minute, so the city follows the real day and night, and the weather is the real weather, from Open-Meteo.
- **Running smoothly.** Detail is drawn only near the camera, and the page lowers its own quality if a computer struggles to keep up.

Designed by me and built with Claude Code, an AI coding agent.
