# AGENTS.md — Project Guide for AI Agents

## Project Overview

This is a static HTML/CSS/vanilla JS personal website (terrancehah.com), deployed via Vercel. It is **not** a Next.js application, despite what `.windsurfrules` describes. The `.windsurfrules` file was written for a different project and does not apply to this codebase.

## Tech Stack

- Static HTML pages (`index.html`, `articles.html`, `projects.html`, `playground.html`)
- Vanilla CSS in `styles/` (no Tailwind build pipeline — `output.css` is pre-generated)
- Vanilla JavaScript in `js/` (classic scripts, not ES modules except `config.js`)
- Python API in `api/` (Vercel serverless functions)
- No npm build step (`package.json` build script is `echo No build step`)

## Pacey product

Pacey lives in `projects/pacey/` with APIs under `api/` (`coach-plan.py`, `radar.py`, `garmin-auth.py`, etc.).

**Product scope (source of truth):** `projects/pacey/PRODUCT.md`

**Voice:** `projects/pacey/pacey-writing-style.md`

Consensus: marathon pre-race companion. Diagnosis is six-area fitness vs the typed goal time. Plan is the full remaining block to race day (not one week). No in-run coaching. Do not treat unofficial Garmin email+password as the long-term auth path.

## Conventions

- Files: kebab-case
- Variables/functions: camelCase
- CSS classes: semantic names reflecting purpose
- No new npm dependencies without explicit request
- Never delete existing working code or comments
- Keep changes minimal and clean
