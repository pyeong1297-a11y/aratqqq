import { fetchYahooData } from '../src/lib/dataFetcher.js';

async function test() {
    console.log("Fetching FNGU raw data...");
    try {
        const d1 = await fetchYahooData('FNGU', '2010-08-18', '2026-02-27');
        console.log(`FNGU data points: ${d1.dates.length}`);
        if (d1.dates.length > 0) {
            console.log(`First entry: ${d1.dates[0].toISOString()}`);
            console.log(`Last entry: ${d1.dates[d1.dates.length - 1].toISOString()}`);
        }

        const d2 = await fetchYahooData('BULZ', '2010-08-18', '2026-02-27');
        console.log(`BULZ data points: ${d2.dates.length}`);
        if (d2.dates.length > 0) {
            console.log(`First entry: ${d2.dates[0].toISOString()}`);
            console.log(`Last entry: ${d2.dates[d2.dates.length - 1].toISOString()}`);
        }
    } catch (e) {
        console.error(e);
    }
}
test();
