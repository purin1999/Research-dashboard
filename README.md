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
  - 🤍 **White**: holidays and leave (public holidays, personal appointments, university closed). These never
    ask for a status update and don't count toward progress.
- **Holiday & leave**: tap **＋ Day off** on the dashboard or the calendar. The first time, a "Holidays & leave"
  project is created for you, or you can choose *Type → Holiday & leave* when creating a project.
- **Calendar colours**: each bar uses its project's colour, and the status is a small dot on the bar
  (🟡 up next, 🟢 completed, 🔴 not as planned, 🟠 awaiting update, no dot = planned later). The calendar only lists
  ongoing projects, special events and Holiday & leave by default; choose *All projects (incl. paused & completed)* to see your overall workload.
- **Special events** (📌): for regular meetings, slide preparation and other activities. Choose *Type → Special
  event* for a project. Its entries keep their status colours and update prompts and always appear in the calendar
  and the new-stage list, but the event is not counted as an ongoing project (no progress bar, not in the stats).
- **Archive tab**: projects set to *Paused* or *Completed* move off the dashboard into the Archive tab.
- **Pinned event + visitor comments**: a special event can be shown at the top of the dashboard (last 2 entries and
  the next one) and can allow visitors to comment on each entry ("Comments from members", name optional).
- **🔗 Share**: copies or shares the view-only link (without `?admin`).
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

## Visitor comments (one-time setup, about 5 minutes)

Meeting comments are stored in a free [Supabase](https://supabase.com) database, because GitHub Pages can't store
anything visitors write.

1. Sign up at <https://supabase.com/dashboard> and create a **New project** (any name, free plan, region near you).
2. Open **SQL Editor**, paste the setup SQL and press **Run**. You can copy it in the app from
   ⚙︎ Settings → Visitor comments → *Copy setup SQL*, or from here:

   ```sql
   create table public.comments (
     id bigint generated always as identity primary key,
     stage_id text not null check (char_length(stage_id) <= 64),
     name text check (char_length(name) <= 60),
     body text not null check (char_length(body) between 1 and 2000),
     created_at timestamptz not null default now()
   );
   alter table public.comments enable row level security;
   grant select, insert on public.comments to anon;
   create policy "Anyone can read comments" on public.comments
     for select to anon using (true);
   create policy "Anyone can add comments" on public.comments
     for insert to anon with check (true);
   ```
3. Open **Project Settings → API** (or *Connect*). Copy the **Project URL** and the **publishable** (or `anon`
   public) key.
4. In the dashboard: **✎ Edit → ⚙︎ → Visitor comments**. Paste both values, tap **Save**, then **⬆ Publish**.
5. On a special event (e.g. *Meeting*), **✎ Edit**, then tick **Allow visitor comments**.

Visitors can only read and add comments, never edit or delete them. To moderate, tap **Hide** on a comment in edit
mode and Publish, or delete rows in Supabase → **Table Editor → comments**. Never paste the `service_role` /
secret key into the dashboard.
