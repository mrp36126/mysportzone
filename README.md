# mysportzone

## Automatic F1 Results Updates

This project can update Formula 1 race results and standings automatically from the Jolpica F1 API, which provides Ergast-compatible Formula 1 data.

The automation updates these CSV files:

- `data/f1_results.csv` - latest race classification, stored by season and round
- `data/f1_sprint_results.csv` - latest sprint classification, stored by season and round
- `data/f1_drivers.csv` - current driver standings
- `data/f1_constructors.csv` - current constructor standings

The frontend only reads CSV files from `data/`. It does not write to GitHub, expose GitHub tokens, or update repository files from the browser.

### Files Added

- `scripts/update-f1-results.js`
- `.github/workflows/update-f1-results.yml`
- `data/f1_results.csv`
- `data/f1_sprint_results.csv`
- `data/f1_constructors.csv`
- `package.json`

### How It Works

The updater script fetches:

- latest race results from `https://api.jolpi.ca/ergast/f1/current/last/results.json`
- latest sprint results from `https://api.jolpi.ca/ergast/f1/current/last/sprint.json`
- driver standings from `https://api.jolpi.ca/ergast/f1/current/driverStandings.json`
- constructor standings from `https://api.jolpi.ca/ergast/f1/current/constructorStandings.json`

It converts the API response into CSV, safely escapes CSV values, and writes only valid non-empty data. For race and sprint results, it replaces rows for the same season and round instead of duplicating them.

On sprint weekends, the Formula 1 tab displays the sprint result if it belongs to a newer round than the latest completed Grand Prix. Once the Grand Prix result is available for that same round, the Grand Prix result becomes the displayed result.

When GitHub Actions commits changed CSV files, Vercel should redeploy automatically from the GitHub commit.

### Run Locally

Use Node.js 18 or newer.

```bash
npm run update:f1
```

If Jolpica has not published the newest race or sprint result yet, the script leaves the existing CSV data unchanged. Scheduled automation will keep polling through the race weekend recovery window, so late-published results should be picked up without a manual run.

## F1 Race Favourites Index

The Formula 1 tab includes a "Next Race Favourites" section powered by `/api/f1-favourites`. It finds the next race from `data/f1_calendar.csv`, scores drivers from racing data only, and returns the favourites sorted by `favourite_score`.

To enable cached refreshes in Supabase:

1. Run `supabase/f1_favourites.sql` in the Supabase SQL editor.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Vercel environment variables.
3. Optionally add `NEWS_API_KEY` if you want the news/sentiment score to use recent Formula 1 headlines.
4. Optionally add `CRON_SECRET`; `/api/update-f1-favourites` will require `Authorization: Bearer <CRON_SECRET>` when it is set.

The `Update F1 Favourites` GitHub Actions workflow runs `npm run update:f1-favourites` once daily, plus targeted refreshes around typical Friday, Saturday, and Sunday F1 session windows. In a normal race week that is about 12 workflow runs. No betting links, bookmaker data, gambling recommendations, or betting advice are used.

Add these GitHub repository secrets for the workflow:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEWS_API_KEY` optional, only for the news/sentiment score

### F1 Driver Podium Images

The latest race result podium is generated automatically from `data/f1_results.csv`. Upload one podium PNG per driver using this naming pattern:

```text
icons/podium-driver-FirstnameLastname.png
```

Remove spaces and keep the driver name spelling exactly as it appears in the CSV. For example:

```text
icons/podium-driver-KimiAntonelli.png
icons/podium-driver-LewisHamilton.png
icons/podium-driver-MaxVerstappen.png
```

These are separate from the smaller driver avatar images used in the championship table, which still use `icons/driver-FirstnameLastname.png`. For the best podium result, use transparent full-body PNG images. The latest result will place 3rd on the left, 1st in the center, and 2nd on the right.

### Run Manually In GitHub Actions

1. Open the repository on GitHub.
2. Go to **Actions**.
3. Select **Update F1 Results**.
4. Click **Run workflow**.

### Schedule

The workflow runs every two hours at minute `30` on Fridays, Saturdays, Sundays, Mondays, and Tuesdays. This lets sprint results publish during sprint weekends and gives late Grand Prix classifications extra chances to update automatically. Use the manual workflow trigger only for unusual race schedules or if you want to force an immediate check.

Each API request is retried before the updater fails, which helps avoid missing updates because of short Jolpica or network outages.

### Troubleshooting

- If no files change, Jolpica may not have published new data yet, or the CSV files may already be up to date. The schedule will keep checking every two hours from Friday through Tuesday.
- If the workflow fails with a network or API error after retries, the next scheduled run should try again automatically.
- If Vercel does not redeploy, check that Vercel is still connected to the GitHub repository and deploys from commits to the selected branch.
- If a constructor table is empty, the frontend falls back to calculating constructors from `data/f1_drivers.csv`.
- Do not use social media posts as the source of truth for official race results. The automation uses structured API data from Jolpica.
