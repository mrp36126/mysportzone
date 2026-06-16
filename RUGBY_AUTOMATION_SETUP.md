# Rugby Results Automation Setup Guide

Your sports app now has automatic rugby results updates from Highlightly API. Here's how to complete the setup:

## Step 1: Add Your Highlightly API Key to GitHub Secrets

1. Go to your GitHub repository: **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Create a secret named: `HIGHLIGHTLY_API_KEY`
4. Paste your Highlightly API key as the value
5. Click **Add secret**

## Step 2: Verify the Workflow

The workflow is now active at `.github/workflows/update-rugby-results.yml`:
- **Schedule**: Runs every 2 hours (around the clock)
- **Trigger**: Manual dispatch available via "Run workflow" button on GitHub Actions tab
- **Updates**: `data/rugby_results.csv` automatically after each match
- **Auto-commits**: Changes committed directly to your repository

## Step 3: Test Locally (Optional)

To test the updater locally before relying on the automated workflow:

```bash
HIGHLIGHTLY_API_KEY=your_key_here npm run update:rugby
```

This will:
1. Fetch international men's rugby results from Highlightly
2. Merge with existing results (avoiding duplicates)
3. Update `data/rugby_results.csv` if changes detected
4. Show success/no-change message

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

**"No new rugby results available"** - Highlightly returned no completed matches. This is normal during off-season.

**Manual workflow trigger** - Go to **Actions → Update Rugby Results → Run workflow** to force an immediate update.

## API Behavior

The updater:
- Polls Highlightly for completed international rugby matches
- Handles graceful failures (returns empty if API is unavailable)
- Logs all results fetched to console during workflow run
- Only writes CSV if changes detected (saves git history)

## Next Steps

1. Confirm your API key is in GitHub Secrets
2. Check that the workflow has at least one successful run
3. Verify `data/rugby_results.csv` is being updated with new match results
4. The frontend will display results from the latest CSV on page reload
