# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a standalone single-file HTML app (`希望休申請アプリ.html`) for managing vacation/day-off requests (希望休申請) for a hospital pharmacy department (病院薬剤部). It runs directly in a browser with no server or build step required.

## Development

Open `希望休申請アプリ.html` directly in a browser to run the app. There is no build, lint, or test toolchain.

## Architecture

Everything lives in one file: `希望休申請アプリ.html`. It has three logical sections:

**HTML structure** — Three main panels that are shown/hidden via `display` toggling:
- `#login-panel` — name selection + admin entry
- `#main-panel` — staff calendar view with dynamic tabs (`#staff-tabs` / `#cal-contents`)
- `#admin-panel` — admin view with dynamic tabs (`#admin-tabs` / `#adm-contents`)

Tab contents are rebuilt dynamically by `rebuildStaffPanel()` and `rebuildAdminPanel()` using IDs like `cal${month}` and `adm${month}`, so IDs are not hardcoded in HTML.

**Persistence** — All data is stored in `localStorage` with these keys:
| Key | Contents |
|-----|----------|
| `kiboushu_teams_2026` | Team→members map (JSON) |
| `kiboushu_requests` | `{ staffName: { "YYYY-MM-DD": type } }` (migrates from old key `kiboushu_2026_79`) |
| `kiboushu_period` | `{ year, months: [m1, m2, m3] }` |
| `kiboushu_admin_pw` | Admin password (plaintext) |
| `kiboushu_rules` | Rules text |
| `kiboushu_rule_pdfs` | Array of `{ name, size, date, data }` where `data` is base64 PDF |

**Key functions and their roles:**
- `getPeriod()` / `getYear()` / `getMonths()` — dynamic period (replaces hardcoded `YEAR`/`MONTHS`)
- `rebuildStaffPanel()` / `rebuildAdminPanel()` — rebuild DOM tabs+content when period changes; called at init and on `applyPeriod()`
- `renderAdminTable(m, containerId)` — renders the full staff×day table for month `m`; used by both admin view and the staff "全員の申請" view
- `computeDayCounts(m, data, staff)` — batches day-count calculation to avoid repeated localStorage reads
- `_admRendered` cache object + `invalidateAdminCache()` — lazy rendering for admin month tables; invalidated on any staff/data change
- `isRestDay(m, d)` → `getLimit()` returns `Infinity` for weekends/holidays; modal shows only「×」for those days

**External dependency:** SheetJS `xlsx.full.min.js` v0.18.5 via CDN (for Excel export only).

**Holiday data:** Built-in `HOLIDAYS_BUILTIN` constant covers 2025–2027. No dynamic holiday fetching.

## Domain Context

- Staff are organized into teams (A–E + その他 + 事務); default members are in `DEFAULT_TEAMS`
- Request types: `特`, `夏`, `有`, `振`, `振◆`, `×`
- Weekdays: max 5 people per day; weekends/holidays: `×` only, no limit
- The period is 3 arbitrary months selected by admin (default: July–September 2026)
- Japanese public holidays for 2026 include 国民の休日 (sandwich holiday) on 9/22
