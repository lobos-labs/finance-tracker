import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarName, GOOGLE_NAME, isAppTask, LEGACY_NAME, TASK_MARK, taskMarkOf, taskNotes } from '../src/main/googleNames.ts'
import { APP_NAME } from '../src/shared/app.ts'

// What the app calls what it makes in Google: a new connection's calendar,
// task list and tasks carry the product's name; a connection made before the
// rename keeps its "Finance Tracker" calendar and goes on recognizing the
// tasks it marked with the old name, without rewriting them.

describe('Google names', () => {
  test('new calendars, lists and tasks carry the product name', () => {
    assert.equal(GOOGLE_NAME, APP_NAME)
    assert.equal(TASK_MARK, APP_NAME)
    assert.equal(taskNotes(), APP_NAME)
    assert.equal(taskNotes(undefined), APP_NAME)
  })

  test('tasks made under either name are the app\'s', () => {
    assert.equal(taskMarkOf(APP_NAME), APP_NAME)
    assert.equal(taskMarkOf(LEGACY_NAME), LEGACY_NAME)
    assert.equal(taskMarkOf(`Bring the title\n${LEGACY_NAME}`), LEGACY_NAME)
    assert.ok(isAppTask('Finance Tracker'))
    assert.ok(isAppTask(APP_NAME))
  })

  test('the user\'s own tasks are left alone', () => {
    for (const notes of [undefined, null, '', 'Buy milk', 'Finance Tracker meeting', 'Ask the bookkeeper', 42, { notes: APP_NAME }]) {
      assert.equal(taskMarkOf(notes), null, String(notes))
      assert.equal(isAppTask(notes), false, String(notes))
    }
  })

  test('a task keeps the mark it was made with; only new tasks get the new one', () => {
    assert.equal(taskNotes(LEGACY_NAME), LEGACY_NAME)
    assert.equal(taskNotes(APP_NAME), APP_NAME)
    // Notes the user cleared or replaced: the app's mark goes back, the new one.
    assert.equal(taskNotes(''), APP_NAME)
    assert.equal(taskNotes('Buy milk'), APP_NAME)
  })

  test('a calendar made before names were stored is the old one', () => {
    assert.equal(calendarName(null), LEGACY_NAME)
    assert.equal(calendarName(undefined), LEGACY_NAME)
    assert.equal(calendarName(''), LEGACY_NAME)
    assert.equal(calendarName(APP_NAME), APP_NAME)
  })
})
