import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { AiError, useBackend, type AiBackend, type StructuredRequest } from '../src/main/ai/backend.ts'
import { configureLicense } from '../src/main/license.ts'
import { revalue, searchSites } from '../src/main/valuation.ts'

// The value lookup's web search stays on a fixed list of sites for each kind
// of asset, a house's or a vehicle's, the same in every edition. Any other
// asset's has no list.

const dir = mkdtempSync(join(tmpdir(), 'finance-valuation-sites-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const HOME_SITES = ['zillow.com', 'redfin.com', 'realtor.com', 'trulia.com']
const VEHICLE_SITES = ['kbb.com', 'edmunds.com', 'cars.com', 'autotrader.com', 'cargurus.com', 'carfax.com', 'truecar.com', 'jdpower.com']

/** A backend with web search that answers every lookup with one value and keeps each request. */
function searching(): AiBackend & { requests: StructuredRequest[] } {
  const requests: StructuredRequest[] = []
  return {
    provider: 'api',
    capabilities: { webSearch: true, documents: false },
    requests,
    async structured(req) {
      requests.push(req)
      return { value: 400_000, low: 380_000, high: 420_000, basis: 'Nearby sales.', sources: ['https://example.com/estimate'] }
    },
    async step() {
      throw new AiError('unavailable', 'not in this test')
    },
    async status() {
      return { ready: true, provider: 'api' }
    }
  }
}

describe('the value lookup\'s sites', () => {
  let house = ''
  let car = ''
  before(() => {
    db.openDb(join(dir, 'finance.db'))
    house = db.addManualAccount({ name: 'Home · 14 Alder Lane', assetType: 'property', points: [{ day: '2024-01-01', cents: 38_500_000 }] })
    car = db.addManualAccount({ name: 'Hatchback', assetType: 'vehicle', points: [{ day: '2024-01-01', cents: 1_800_000 }] })
  })
  after(() => {
    useBackend(null)
    configureLicense({ dev: true, openEdition: false })
    db.closeDb()
  })

  test('the open edition keeps a house\'s search to the home-value sites and a vehicle\'s to the listing sites', async () => {
    configureLicense({ dev: false, openEdition: true })
    assert.deepEqual(searchSites('property'), HOME_SITES)
    assert.deepEqual(searchSites('vehicle'), VEHICLE_SITES)
    assert.equal(searchSites('other_asset'), undefined)
    const backend = searching()
    useBackend(backend)
    await revalue(house)
    await revalue(car)
    assert.deepEqual(backend.requests.map((r) => r.searchDomains), [HOME_SITES, VEHICLE_SITES])
  })

  test('every other build searches the same sites', async () => {
    configureLicense({ dev: true, openEdition: false })
    assert.deepEqual(searchSites('property'), HOME_SITES)
    assert.deepEqual(searchSites('vehicle'), VEHICLE_SITES)
    const backend = searching()
    useBackend(backend)
    await revalue(house)
    assert.deepEqual(backend.requests.map((r) => r.searchDomains), [HOME_SITES])
  })
})
