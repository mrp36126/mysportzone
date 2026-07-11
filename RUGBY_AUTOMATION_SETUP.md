# Rugby Results Automation Setup Guide

Your sports app now has automatic rugby results updates from one source only:
- Rugby365 scraping from https://rugby365.com/results/

Here's how to complete the setup:

## Step 1: Verify the Workflow

The workflow is active at `.github/workflows/rugby-results.yml`:
- **Schedule**: Runs every 30 minutes (around the clock)
- **Trigger**: Manual dispatch available via "Run workflow" button on GitHub Actions tab
- **Updates**: `data/rugby-results.json` and `data/rugby_results.csv`
- **Auto-commits**: Changes committed directly to your repository

## Step 2: Test Locally (Optional)

To test the scraper locally before relying on the automated workflow:

```bash
npm run update:rugby
```

This will:
1. Scrape rugby results from Rugby365
2. Match scraped matches against existing fixtures in `data/rugby_fixtures.csv`
3. Update only matched fixture records
4. Write updated data to `data/rugby-results.json`
5. Sync `data/rugby_results.csv` from the JSON results data when scores changed

## Step 3: Monitor Updates

- Visit **GitHub Actions** tab to see workflow run history
- Green checkmarks = successful update
- Check commit history to verify `data/rugby-results.json` and `data/rugby_results.csv` updates
- The frontend automatically reloads the latest CSV

## CSV Format

Rugby results are stored as:
```
Date,HomeTeam,HomeScore,AwayScore,AwayTeam,Competition
2026-04-10,Croatia,17,33,Mexico,Test Match
```

The script automatically:
- Scrapes Rugby365 result entries
- Matches only against existing fixture rows
- Preserves fixture-bound output records
- Updates scores where matches are confidently matched

## What Gets Updated

- **data/rugby-results.json** - Fixture-aligned match state
- **data/rugby_results.csv** - Completed match results
- No changes to `rugby_fixtures.csv` (manually maintained for upcoming matches)

## Troubleshooting

**"No match found for fixture"** - A scraped match could not be confidently matched to the corresponding fixture row, so that fixture was left unchanged.

**"Ambiguous match for fixture"** - Multiple scraped matches looked equally valid; the fixture was intentionally skipped to avoid bad score writes.

**Manual workflow trigger** - Go to **Actions → Rugby365 Results Update → Run workflow** to force an immediate update.

## Scraper Behavior

The updater:
- Scrapes `https://rugby365.com/results/`
- Parses result rows from Rugby365 content blocks
- Matches rows to existing fixtures using date/team/competition scoring
- Never inserts new fixtures that are not already in `data/rugby_fixtures.csv`
- Only writes CSV if changes detected (saves git history)

## Next Steps

1. Check that the workflow has at least one successful run
2. Verify `data/rugby-results.json` and `data/rugby_results.csv` are being updated
3. The frontend will display results from the latest CSV on page reload
