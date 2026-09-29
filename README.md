# Research Progress Dashboard

A dashboard for tracking research progress. It's a static web app that needs no server or build step. It is
hosted free on GitHub Pages and designed for iPhone, and visitors can look but not edit.

- **Live dashboard (view only):** <https://purin1999.github.io/Research-dashboard/>
- **Edit mode (owner):** <https://purin1999.github.io/Research-dashboard/?admin>
- **Repository:** <https://github.com/purin1999/Research-dashboard>

- **Dashboard**: every ongoing project with a progress bar, what's next, and what still needs an update.
- **Project page**: tap a project to see its stages. Each stage has an action name, experiment conditions
  (Condition 1, 2, 3, …), a schedule, notes and a comment.
- **Calendar**: Month, Week (3 days on phone, 7 on desktop, with a time grid like Google Calendar) and List views,
  with a project filter.
- **Status colours**
  - 🟨 **Yellow**: the next upcoming (or in-progress) stage of each project
  - 🟩 **Green**: completed as planned
  - 🟥 **Red**: not completed as planned (a comment explaining why is required)
  - 🟧 **Orange, dashed**: the planned date has passed and the stage is waiting for you to update it
  - ⬜ **Grey**: planned later
- **Export** (⇪ tab): a printable report you can save as PDF, a spreadsheet (`.csv`), a calendar file (`.ics` for
  Google or Apple Calendar) and a full data backup (`.json`). You can export one project or everything.

## How it works

```
index.html          app shell
assets/app.js       all logic (no dependencies)
assets/styles.css   styles (light + dark mode, iPhone layout)
data.json           YOUR DATA: what visitors see
```

Visitors load `data.json` and can only view it. When you edit on your own device and tap **Publish**, the app
commits the new `data.json` to this repository through the GitHub API. GitHub Pages then updates the public
site within about a minute.

## One-time setup

1. **Turn on GitHub Pages**: go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, pick
   branch `main` and folder `/ (root)`, then save. The site will be at
   <https://purin1999.github.io/Research-dashboard/>.
   (GitHub Pages on a free account needs a **public** repository.)
2. **Create an access token** for publishing:
   <https://github.com/settings/personal-access-tokens/new>
   - *Repository access*: **Only select repositories**, then pick `purin1999/Research-dashboard`
   - *Permissions → Repository permissions → Contents*: **Read and write**
3. **Open the site in edit mode on your iPhone**: <https://purin1999.github.io/Research-dashboard/?admin>
   - Tap **✎ Edit**, then **⚙︎** (Settings), paste the token and check the fields read user `purin1999`,
     repository `Research-dashboard`, branch `main`, then Save.
   - In Safari, tap **Share → Add to Home Screen** so the dashboard opens like an app. The Home Screen app
     keeps its own storage, so the first time you open it, tap **Owner sign-in** at the bottom of the page
     and paste your token.
   - Do the same on any other device you want to edit from.
4. **Share the plain address**, <https://purin1999.github.io/Research-dashboard/> (without `?admin`), with anyone who wants to follow your progress. They can
   only view.

> The token is stored only in your own browser (localStorage) and is sent only to `api.github.com`.
> Use **Settings → Forget token** or *Stop editing on this device* on shared computers.

## Everyday use

1. **✎ Edit**, then **＋ New project** / **＋ Add stage**. Add as many conditions as you need.
2. Give each stage a date and optionally a time range or an end date (for multi-day stages). In the week view you
   can also tap an empty time slot to create a stage there.
3. After the planned date passes, the stage turns **orange** and appears under *Needs your update* on the
   dashboard. Tap **✓ Done as planned** (green) or **✕ Not as planned** (red, comment required). A red stage
   can be **↻ Rescheduled as a new stage**.
4. Tap **⬆ Publish** to put your changes online. Until then they're saved as a draft on your device only.

Progress = completed stages ÷ (all stages − stages marked *not as planned*). A failed attempt is kept as a
record, and the repeat you schedule is what counts toward progress.

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/?admin
```

Opening `index.html` directly from disk won't work, because the browser blocks loading `data.json` from a `file://` page.
