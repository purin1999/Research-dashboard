# Research Progress Dashboard

A dashboard for tracking the research progress of a group of students. It's a static web app that needs no server
or build step. It is hosted free on GitHub Pages and designed for iPhone. Everyone can look at every student's
progress, and **each student can only edit their own**.

- **All students (view only):** <https://purin1999.github.io/Research-dashboard/>
- **One student's dashboard:** `https://purin1999.github.io/Research-dashboard/#/s/<student>`, e.g.
  <https://purin1999.github.io/Research-dashboard/#/s/purin>
- **Sign in to edit your own dashboard:** <https://purin1999.github.io/Research-dashboard/?admin> (or *Student sign-in*
  at the bottom of any page)
- **Repository:** <https://github.com/purin1999/Research-dashboard>

- **All students** (home page): made for the professor to skim the whole group. Students are listed in grade order
  (D3 → B4), with the grade shown next to each name, and the 🔍 search bar at the top finds a member by name
  (press Enter to open the first match). Each row shows the student's ongoing projects with a progress bar each, their next stage, days off in
  the next 7 days, and when they last updated: grey within a week, 🟠 orange after 1 week, 🔴 red after 2 weeks.
  Switch between **☰ List** (default, compact for 20+ people) and **▦ Cards**. Tap a student to open their dashboard.

- **Dashboard** (per student): every ongoing project with a progress bar, what's next, and what still needs an update.
- **Project page**: tap a project to see its stages. Each stage has an action name, experiment conditions
  (Condition 1, 2, 3, …), a schedule, notes and a comment.
- **Calendar**: Month, Week (3 days on phone, 7 on desktop, with a time grid like Google Calendar) and List views,
  with a project filter.
- **Status colours**
  - 🟨 **Yellow**: the next upcoming stage of each project
  - 🟩 **Green**: completed as planned
  - 🟥 **Red**: not completed as planned (a comment explaining why is required)
  - 🟧 **Orange, dashed**: the stage has started and is waiting for you to update it
  - ⬜ **Grey**: planned later
  - 🤍 **White**: holidays and leave (public holidays, personal appointments, university closed). These never
    ask for a status update and don't count toward progress.
- **Holiday & leave**: tap **＋ Day off** on the dashboard or the calendar. The first time, a "Holidays & leave"
  project is created for you, or you can choose *Type → Holiday & leave* when creating a project.
- **Private days off**: each day off has *Who can see it*:
  - **Everyone sees the details** (default)
  - **Others only see that I'm away**: the dashboard shows only the type (e.g. "Personal leave") and the dates;
    the title and notes are never published
  - **Only me**: not published at all; nobody else sees it, not even that you're away

  The private details are kept only in the browser of the device where you entered them (the data files are
  public, so they can't be stored there). On your other devices the day off shows as "Personal leave", and
  "Only me" days off don't show. Days off that were published *before* you made them private stay readable in the
  repository's commit history.
- **Calendar colours**: each bar uses its project's colour, and the status is a small dot on the bar
  (🟡 up next, 🟢 completed, 🔴 not as planned, 🟠 awaiting update, no dot = planned later). The calendar only lists
  ongoing projects, special events and Holiday & leave by default; choose *All projects (incl. paused & completed)* to see your overall workload.
- **Special events** (📌): for regular meetings, slide preparation and other activities. Choose *Type → Special
  event* for a project. Its entries keep their status colours and update prompts and always appear in the calendar
  and the new-stage list, but the event is not counted as an ongoing project (no progress bar, not in the stats).
- **Archive tab**: projects set to *Paused* or *Completed* move off the dashboard into the Archive tab.
- **Pinned event + visitor comments**: a special event can be shown at the top of the dashboard (last 2 entries and
  the next one) and can allow visitors to comment on each entry ("Comments from members", name optional).
- **🔗 Share**: copies or shares the view-only link to the page you're on (the student's dashboard, or all students).
- **Export** (⇪ tab): a printable report you can save as PDF, a spreadsheet (`.csv`), a calendar file (`.ics` for
  Google or Apple Calendar) and a full data backup (`.json`). You can export one project or everything.
- **📽 Plan slide for the next meeting** (⇪ Export): one 4:3 PowerPoint slide (`.pptx`) with what you'll do until
  the next meeting. Pick the timespan (by default until the next entry of your pinned meeting event, or 1 or 2
  weeks), the projects, and whether to include experiment conditions, notes and days off. Stages are grouped by
  project with their dates; the preview shows the slide exactly as it will look. If it doesn't fit, notes and extra
  conditions are left out first, then the latest stages become "+N more"; everything is always in the speaker
  notes. Private days off show only as their type, and "Only me" ones never appear.

## How it works

```
index.html            app shell
assets/app.js         all logic (no dependencies)
assets/styles.css     styles (light + dark mode, iPhone layout)
students.json         THE STUDENT LIST: who is in the group, and the admins
students/<id>.json    each student's data: what visitors see
```

`students.json` looks like this:

```json
{
  "meta": { "title": "Research Progress", "subtitle": "…", "admins": ["purin1999"] },
  "students": [
    { "id": "purin", "name": "Purin", "grade": "D2", "github": "purin1999" },
    { "id": "alice", "name": "Alice", "grade": "M1", "github": "alice-gh", "repo": "alice-gh/research-data" }
  ]
}
```

- `id` is the page address (`#/s/purin`) and, by default, the data file name (`students/purin.json`).
- `grade` (optional) sorts students on the home page and is shown next to their name. The order is `meta.grades`, by default
  `["D3", "D2", "D1", "M2", "M1", "B4"]`; other grades follow, and students without a grade come last.
- `github` is the **only** GitHub account allowed to edit that student's dashboard.
- `repo` (optional, with optional `branch` and `path`, default `main` and `data.json`) keeps the student's data in
  their own public repository instead of this one.
- `admins` can add, edit and remove students from inside the app (**👥 Manage students** on the home page). Admins
  can't edit other students' progress.

Visitors load the JSON files and can only view them. A student signs in with a GitHub token; the app asks GitHub
whose token it is and unlocks editing only on the dashboard whose `github` matches. When they tap **Publish**, the
app commits their own data file through the GitHub API, and GitHub Pages updates the public site within about a
minute.

### Who can edit what

| Data stored in | Who can technically write it | Who the app lets edit it |
| --- | --- | --- |
| this repository (`students/<id>.json`, default) | every collaborator of this repository | only the matching student |
| the student's own repository (`repo`) | only that student (GitHub enforces it) | only the matching student |

The default is the easiest to set up, and every commit shows who made it, so it suits a lab where everyone trusts
each other. If you need students to be *unable* to change each other's files, put each student's data in their own
repository.

## One-time setup (admin)

1. **Turn on GitHub Pages**: go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, pick
   branch `main` and folder `/ (root)`, then save. The site will be at
   <https://purin1999.github.io/Research-dashboard/>.
   (GitHub Pages on a free account needs a **public** repository.)
2. Put your own GitHub username in `admins` in `students.json`, then sign in on the site (see below).
3. **Add each student**: on the home page tap **👥 Manage students → ＋ Add student**, and enter their name and GitHub
   username, and optionally their grade. Then either
   - *Data in this repository* (default): invite them under *Settings → Collaborators* so they can publish, or
   - *Data in their own repository*: they create a **public** repository (it can be empty) and you enter it as
     `owner/name`. No access to this repository is needed.

## Student setup (each student, once per device)

1. **Create an access token**: <https://github.com/settings/personal-access-tokens/new>
   - *Repository access*: **Only select repositories**, then pick the repository that holds your data
     (`purin1999/Research-dashboard`, or your own one)
   - *Permissions → Repository permissions → Contents*: **Read and write**
2. **Sign in on your iPhone**: open <https://purin1999.github.io/Research-dashboard/?admin> (or tap *Student sign-in* at
   the bottom of any page), paste the token and tap **Sign in**. The app takes you to your dashboard with editing
   turned on. Everyone else's dashboards stay view-only for you.
   - In Safari, tap **Share → Add to Home Screen** so the dashboard opens like an app. The Home Screen app keeps its
     own storage, so sign in there once too.
   - Do the same on any other device you want to edit from.
3. **Share the plain address**, <https://purin1999.github.io/Research-dashboard/#/s/your-id> (without `?admin`), with
   anyone who wants to follow your progress. They can only view.

> The token is stored only in your own browser (localStorage) and is sent only to `api.github.com`.
> Use **Account → Sign out on this device** on shared computers.

> **Upgrading from the single-user version:** `data.json` moved to `students/purin.json`. Devices that were set up
> before keep working: the saved token and any unpublished draft move over to your dashboard automatically. Old links
> such as `#/project/<id>` open the first student's page.

## Everyday use

1. On your own dashboard, **✎ Edit**, then **＋ New project** / **＋ Add stage**. Add as many conditions as you need.
2. Give each stage a date and optionally a time range or an end date (for multi-day stages). In the week view you
   can also tap an empty time slot to create a stage there.
3. As soon as a stage starts (00:00 on its date for all-day stages, or its start time), it turns **orange** and
   appears under *Needs your update* on the dashboard, so you can record the result the same day. Tap **✓ Done as planned** (green) or **✕ Not as planned** (red, comment required). A red stage
   can be **↻ Rescheduled as a new stage**.
4. Tap **⬆ Publish** to put your changes online. Until then they're saved as a draft on your device only.

Progress = completed stages ÷ (all stages − stages marked *not as planned*). A failed attempt is kept as a
record, and the repeat you schedule is what counts toward progress.

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/
```

On `localhost` the app can't guess the repository, so fill in *Site repository* in the sign-in dialog. On GitHub
Pages it is always taken from the site's address (`purin1999/Research-dashboard`, branch `main`) and can't be
changed, so a mistyped value can never send someone's changes to the wrong repository.

Opening `index.html` directly from disk won't work, because the browser blocks loading the JSON files from a `file://` page.

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
4. In your dashboard: **✎ Edit → ⚙︎ → Visitor comments**. Paste both values, tap **Save**, then **⬆ Publish**.
   To share one Supabase project with the whole group instead, an admin puts the same two values in
   `meta.comments` in `students.json`; students who leave their own fields empty use it.
5. On a special event (e.g. *Meeting*), **✎ Edit**, then tick **Allow visitor comments**.

Visitors can only read and add comments, never edit or delete them. To moderate, tap **Hide** on a comment in edit
mode and Publish, or delete rows in Supabase → **Table Editor → comments**. Never paste the `service_role` /
secret key into the dashboard.
