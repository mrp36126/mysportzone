const fs = require('fs');
const path = require('path');
const https = require('https');
const csv = fs.readFileSync(path.join(process.cwd(), 'data', 'f1_drivers.csv'), 'utf8')
  .trim().split('\n').slice(1).map(line => {
    const parts = line.split(',');
    return { Position: parts[0], Change: parts[1], Driver: parts[2], Team: parts[3], CarNumber: parts[4], Points: parts[5], PointsChange: parts[6] };
  });
console.log('prev count', csv.length);
console.log('sample prev', csv.slice(0, 5));
https.get('https://api.jolpi.ca/ergast/f1/current/driverStandings.json', res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const payload = JSON.parse(body);
    const items = payload.MRData.StandingsTable.StandingsLists[0].DriverStandings;
    const api = items.map(item => ({ name: item.Driver.givenName + ' ' + item.Driver.familyName, position: item.position }));
    console.log('api sample', api.slice(0, 5));
    const diff = api.filter(item => !csv.some(r => r.Driver === item.name));
    console.log('missing names count', diff.length);
    if (diff.length > 0) console.log('missing names', diff);
    const mismatched = api.map(item => {
      const prev = csv.find(r => r.Driver === item.name);
      return { name: item.name, current: item.position, previous: prev?.Position || 'MISSING' };
    }).slice(0, 20);
    console.log('compare sample', mismatched);
  });
}).on('error', err => {
  console.error(err);
});
