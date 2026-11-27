// The UTC run of the suite (npm run test:utc): the process's clock is UTC, as
// a hosted ledger's is, and a ledger with no time zone of its own counts its
// days in FINANCE_TRACKER_TEST_ZONE (the fixed zone the tests' dates are written
// in), so every test should pass whatever zone the machine is in.
// Loaded after ts-esm.mjs, so the module here is the one the app imports.
process.env.TZ = 'UTC'
process.env.FINANCE_TRACKER_TEST_ZONE ||= 'America/Chicago'

const { setDefaultZone } = await import('../src/shared/zone.ts')
setDefaultZone(process.env.FINANCE_TRACKER_TEST_ZONE)
