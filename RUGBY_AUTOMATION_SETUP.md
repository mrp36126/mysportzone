# Rugby Results Automation Setup Guide

Your sports app now has automatic rugby results updates with a two-source chain:
- Primary: Highlightly API
- Fallback: SportDB.dev API when Highlightly has no completed score yet

Here's how to complete the setup:

## Step 1: Add Both API Keys to GitHub Secrets

1. Go to your GitHub repository: **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Create a secret named: `HIGHLIGHTLY_API_KEY`
4. Paste your Highlightly API key as the value
5. Click **Add secret**
6. Click **New repository secret** again
7. Create a secret named: `SPORTDB_API_KEY`
8. Paste your SportDB.dev API key as the value
9. Click **Add secret**

## Step 2: Verify the Workflow

The workflow is now active at `.github/workflows/update-rugby-results.yml`:
- **Schedule**: Runs every 2 hours (around the clock)
- **Trigger**: Manual dispatch available via "Run workflow" button on GitHub Actions tab
- **Updates**: `data/rugby_results.csv` automatically after each match
- **Auto-commits**: Changes committed directly to your repository

## Step 3: Test Locally (Optional)

To test the updater locally before relying on the automated workflow:

```bash
HIGHLIGHTLY_API_KEY=your_highlightly_key SPORTDB_API_KEY=your_sportdb_key npm run update:rugby
```

Optional local override:

```bash
HIGHLIGHTLY_BASE_URL=https://rugby.highlightly.net
HIGHLIGHTLY_RAPIDAPI_HOST=rugby-highlights-api.p.rapidapi.com
SPORTDB_BASE_URL=https://api.sportdb.dev
```

This will:
1. Fetch completed rugby results from Highlightly first
2. Detect completed fixtures that still have no score
3. Query SportDB for those missing completed fixtures
4. Merge both sources and deduplicate by date + teams
5. Update `data/rugby_results.csv` if changes detected

## Step 4: Monitor Updates

- Visit **GitHub Actions** tab to see workflow run history
- Green checkmarks = successful update
- Check commit history to verify `rugby_results.csv` updates
- The frontend automatically reloads the latest CSV

## CSV Format

Rugby results are stored as:
```
Date,HomeTeam,HomeScore,AwayScore,AwayTeam,Competition
2026-04-10,Croatia,17,33,Mexico,Test Match
```

The script automatically:
- Fetches completed international men's rugby matches
- Deduplicates by date + teams
- Sorts by most recent first
- Replaces/upserts existing records

## What Gets Updated

- **data/rugby_results.csv** - Completed match results
- No changes to `rugby_fixtures.csv` (manually maintained for upcoming matches)

## Troubleshooting

**"API returned status 401"** - Your `HIGHLIGHTLY_API_KEY` is invalid or has expired. Update it in GitHub Secrets.

**"SportDB fallback skipped because SPORTDB_API_KEY is not set"** - Add the `SPORTDB_API_KEY` GitHub secret so fallback checks run automatically.

**SportDB.dev auth note** - The fallback uses the `X-API-Key` header against `https://api.sportdb.dev`.

**"No completed matches found from Highlightly or SportDB fallback"** - Neither source has published completed score data for your tracked fixtures yet.

**Manual workflow trigger** - Go to **Actions → Update Rugby Results → Run workflow** to force an immediate update.

## API Behavior

The updater:
- Polls Highlightly first for completed rugby matches
- Uses Highlightly Rugby API (`https://rugby.highlightly.net`) with `x-rapidapi-key`
- Automatically checks SportDB.dev rugby-union data for completed fixtures still missing after Highlightly
- Handles graceful failures (returns empty if API is unavailable)
- Logs all results fetched to console during workflow run
- Only writes CSV if changes detected (saves git history)

## Next Steps

1. Confirm both API keys are in GitHub Secrets
2. Check that the workflow has at least one successful run
3. Verify `data/rugby_results.csv` is being updated with new match results
4. The frontend will display results from the latest CSV on page reload
