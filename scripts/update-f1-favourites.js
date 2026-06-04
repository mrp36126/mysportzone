#!/usr/bin/env node

/*
 * Refreshes the F1 Race Favourites Index cache in Supabase.
 *
 * This can be run from a scheduler before race weekends and after FP1, FP2,
 * FP3, and qualifying. The public app continues to work without this script,
 * because /api/f1-favourites can calculate live data when no cache exists.
 */

const { buildF1Favourites } = require('../lib/f1-favourites');

buildF1Favourites({ preferCache: false, persist: true })
  .then(payload => {
    const raceName = payload.race?.name || 'no upcoming race';
    console.log(`F1 favourites refreshed for ${raceName}: ${payload.favourites.length} drivers.`);
  })
  .catch(error => {
    console.error(`F1 favourites refresh failed: ${error.message}`);
    process.exit(1);
  });
