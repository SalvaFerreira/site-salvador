---
title: "Deloitte"
# One line at the top of the panel and the Profile page.
summary: "Building an AI agent that migrates legacy data warehouses to dbt, in a team where multi-agent workflows made delivery about 10x faster."
label: "Deloitte"
category: "job"
place: "Amoreiras"
role: "AI & Data Analyst · Technology & Transformation (Financial Services)"
period: "Sep 2026 – Present"
# Deloitte Hub, Avenida Engenheiro Duarte Pacheco 7 (Amoreiras), as placed in OpenStreetMap.
coordinates: [-9.1571308, 38.724672]
order: 3
# Start: orders the journey line and the Tour.
date: "2026-09"
stack: ["Python", "SQL", "dbt", "T-SQL", "SSIS", "LLM agents"]
links:
  - label: "deloitte.com"
    url: "https://www.deloitte.com/pt/pt.html"
---

- Optimised multi-agent AI workflows, accelerating the team’s rate of delivery by ~10x.
- Built SQL and Python data transformations in dbt to support database migrations.

### AI agent for migrating legacy data warehouses

I am developing an AI agent that automates the migration of legacy data warehouses, built on T-SQL stored procedures and SSIS packages, to a modern dbt architecture. The agent works as a multi-stage pipeline. First, it cleans the SQL code of comments and noise while preserving the business logic. Then it classifies each procedure by migration complexity and analyses its dependencies, execution paths and data transformations in depth. From that analysis, it generates synthetic test data without ever accessing real data. Finally, it produces and validates the dbt models in a medallion architecture and automatically fixes the errors it finds. To ensure security and traceability, it includes guardrails that control the commands it runs and record every action in an audit log. The goal is to drastically reduce the manual effort of migrations that typically involve hundreds of procedures, without losing rigour or quality.
