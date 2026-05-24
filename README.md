# mysportzone

## Automatic F1 Results Updates

This project can update Formula 1 race results and standings automatically from the Jolpica F1 API, which provides Ergast-compatible Formula 1 data.

The automation updates these CSV files:

- `data/f1_results.csv` - latest race classification, stored by season and round
- `data/f1_drivers.csv` - current driver standings
- `data/f1_constructors.csv` - current constructor standings

The frontend only reads CSV files from `data/`. It does not write to GitHub, expose GitHub tokens, or update repository files from the browser.

### Files Added

- `scripts/update-f1-results.js`
- `.github/workflows/update-f1-results.yml`
- `data/f1_results.csv`
- `data/f1_constructors.csv`
- `package.json`

### How It Works

The updater script fetches:

- latest race results from `https://api.jolpi.ca/ergast/f1/current/last/results.json`
- driver standings from `https://api.jolpi.ca/ergast/f1/current/driverStandings.json`
- constructor standings from `https://api.jolpi.ca/ergast/f1/current/constructorStandings.json`

It converts the API response into CSV, safely escapes CSV values, and writes only valid non-empty data. For race results, it replaces rows for the same season and round instead of duplicating them.

When GitHub Actions commits changed CSV files, Vercel should redeploy automatically from the GitHub commit.

### Run Locally

Use Node.js 18 or newer.

```bash
npm run update:f1
```

If Jolpica has not published the newest race result yet, the script leaves the existing CSV data unchanged.

### Run Manually In GitHub Actions

1. Open the repository on GitHub.
2. Go to **Actions**.
3. Select **Update F1 Results**.
4. Click **Run workflow**.

### Schedule

The workflow runs every Monday at `06:30 UTC`, which is after most Formula 1 race weekends. Use the manual workflow trigger for unusual race schedules, sprint weekends, delayed classifications, or if Jolpica publishes data later than usual.

### Troubleshooting

- If no files change, Jolpica may not have published new data yet, or the CSV files may already be up to date.
- If the workflow fails with a network or API error, rerun it later from GitHub Actions.
- If Vercel does not redeploy, check that Vercel is still connected to the GitHub repository and deploys from commits to the selected branch.
- If a constructor table is empty, the frontend falls back to calculating constructors from `data/f1_drivers.csv`.
- Do not use social media posts as the source of truth for official race results. The automation uses structured API data from Jolpica.
