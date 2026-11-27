import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { categoryRole, nameWithRole } from '../src/shared/categoryRole.ts'

describe('categoryRole', () => {
  test('the default category names', () => {
    assert.equal(categoryRole('Dining Out'), 'dining')
    assert.equal(categoryRole('Coffee'), 'coffee')
    assert.equal(categoryRole('Groceries'), 'groceries')
    assert.equal(categoryRole('Housing'), 'housing')
    assert.equal(categoryRole('Health & Medical'), 'health')
    assert.equal(categoryRole('Fees & Interest'), 'fees')
    assert.equal(categoryRole('Taxes'), 'taxes')
    assert.equal(categoryRole('Paycheck'), 'paycheck')
    assert.equal(categoryRole('Transfers'), 'transfers')
  })
  test('case, spacing and punctuation do not matter', () => {
    assert.equal(categoryRole('dining out'), 'dining')
    assert.equal(categoryRole('  DINING   OUT '), 'dining')
    assert.equal(categoryRole('Health and Medical'), 'health')
    assert.equal(categoryRole('Fees/Interest'), 'fees')
  })
  test('synonyms', () => {
    assert.equal(categoryRole('Restaurants'), 'dining')
    assert.equal(categoryRole('Salary'), 'paycheck')
    assert.equal(categoryRole('Rent'), 'housing')
    assert.equal(categoryRole('Supermarket'), 'groceries')
  })
  test("a car's upkeep is auto; Transportation, with its rides and transit, is not", () => {
    for (const name of ['Auto & Transport', 'Auto Maintenance', 'Car Maintenance', 'Auto Repair', 'auto and transport']) assert.equal(categoryRole(name), 'auto', name)
    assert.equal(categoryRole('Transportation'), null)
  })
  test('other categories have no role', () => {
    assert.equal(categoryRole('Other Income'), null)
    assert.equal(categoryRole('Shopping'), null)
    assert.equal(categoryRole(''), null)
    assert.equal(categoryRole(null), null)
  })
  test('nameWithRole finds the category as the user named it', () => {
    assert.equal(nameWithRole(['Shopping', 'Restaurants', 'Coffee'], 'dining'), 'Restaurants')
    assert.equal(nameWithRole(['Shopping'], 'dining'), null)
  })
})
