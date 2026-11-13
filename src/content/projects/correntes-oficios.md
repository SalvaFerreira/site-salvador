---
# Provisional title: replace with the final one.
title: "Correntes de Memória: ofícios agent"
label: "Correntes de Memória"
group: "Correntes de Memória"
category: "job"
place: "Areeiro"
role: "AI Engineer & Financial Controller"
period: "Jun 2025 – Present"
# Rua Margarida de Abreu. The street is right, but the map data has no door numbers:
# this is one of the buildings on it. Replace with the exact [longitude, latitude] of number 11.
coordinates: [-9.129815, 38.744369]
order: 1
# Start: orders the journey line and the Tour.
date: "2025-06"
# Screenshots for the panel, saved in public/images/: [{ src: "/images/name.jpg", alt: "what it shows" }]
images:
  - src: "/images/correntes-agent-flow.svg"
    alt: "Diagram: a caregiver-replacement order arrives as a PDF; the LLM agent reads it, updates the care-management system and reconciles the caregiver payments."
# From the CV: "Built 10+ AI agents and automations (Python, LLMs)".
stack: ["Python", "LLMs"]
links:
  - label: "correntes.pt"
    url: "https://correntes.pt/"
---

Developing an LLM-powered agent that reads unstructured caregiver-replacement orders (PDF), updates the internal care-management system and reconciles caregiver payments automatically, replacing an end-to-end manual process.

Every caregiver-replacement order arrives as an unstructured PDF. Until now each one went through the same manual process from end to end: someone read it, entered the change in the internal care-management system, and then reconciled the caregiver's payments by hand.

The agent takes that over. It reads the order with an LLM, updates the care-management system and reconciles the payments on its own. I am building it in Python; it is one of the 10+ AI agents and automations I have built at Correntes de Memória, which together cut the team's manual workload by about 6x.

<!-- Case study drafted only from the CV bullets above. Salvador: review and rewrite in your own words. -->
