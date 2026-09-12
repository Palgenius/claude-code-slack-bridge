import test from 'node:test'
import assert from 'node:assert/strict'

import {
    normalizeSteps, applyPatches, advance, renderBoard,
    summarize, isStatus, ProgressStore, ICON, type Step,
} from './progress.js'

const steps = (...texts: string[]): Step[] =>
    texts.map((text) => ({ text, status: 'pending' as const }))

test('normalizeSteps', async (t) => {
    await t.test('accepts plain strings and starts them pending', () => {
        assert.deepEqual(normalizeSteps(['one', 'two']), [
            { text: 'one', status: 'pending' },
            { text: 'two', status: 'pending' },
        ])
    })

    await t.test('accepts objects with a status', () => {
        assert.deepEqual(normalizeSteps([{ text: 'one', status: 'done' }]),
            [{ text: 'one', status: 'done' }])
    })

    await t.test('falls back to pending on an unknown status', () => {
        assert.deepEqual(normalizeSteps([{ text: 'one', status: 'finished' }]),
            [{ text: 'one', status: 'pending' }])
    })

    await t.test('drops entries with no text', () => {
        assert.deepEqual(normalizeSteps(['', '  ', { text: '' }, 'real']),
            [{ text: 'real', status: 'pending' }])
    })

    await t.test('is safe on anything that is not a list', () => {
        assert.deepEqual(normalizeSteps(undefined), [])
        assert.deepEqual(normalizeSteps('one'), [])
    })
})

test('isStatus', () => {
    assert.equal(isStatus('done'), true)
    assert.equal(isStatus('nearly'), false)
    assert.equal(isStatus(3), false)
})

test('applyPatches', async (t) => {
    await t.test('patches by index', () => {
        const r = applyPatches(steps('a', 'b'), [{ step: 1, status: 'done' }])
        assert.equal(r.steps[1].status, 'done')
        assert.equal(r.steps[0].status, 'pending')
        assert.deepEqual(r.missed, [])
    })

    await t.test('patches by a substring of the text', () => {
        const r = applyPatches(steps('upload the release', 'run the script'),
            [{ step: 'release', status: 'done' }])
        assert.equal(r.steps[0].status, 'done')
    })

    await t.test('matches a substring regardless of case', () => {
        const r = applyPatches(steps('Upload The Release'), [{ step: 'upload', status: 'failed' }])
        assert.equal(r.steps[0].status, 'failed')
    })

    await t.test('can rewrite the wording too', () => {
        const r = applyPatches(steps('deploy'), [{ step: 0, status: 'done', text: 'deployed to prod' }])
        assert.deepEqual(r.steps[0], { text: 'deployed to prod', status: 'done' })
    })

    await t.test('reports a patch that matched nothing', () => {
        // Dropping it silently leaves the board looking stalled while the work
        // moved on, which reads as a hung job.
        const r = applyPatches(steps('a'), [{ step: 'nowhere', status: 'done' }, { step: 9, status: 'done' }])
        assert.deepEqual(r.missed, ['nowhere', 9])
        assert.equal(r.steps[0].status, 'pending')
    })

    await t.test('does not mutate the steps it was given', () => {
        const original = steps('a')
        applyPatches(original, [{ step: 0, status: 'done' }])
        assert.equal(original[0].status, 'pending')
    })
})

test('advance', async (t) => {
    await t.test('finishes the active step and starts the next', () => {
        const board: Step[] = [
            { text: 'a', status: 'done' },
            { text: 'b', status: 'active' },
            { text: 'c', status: 'pending' },
        ]
        assert.deepEqual(advance(board).map((s) => s.status), ['done', 'done', 'active'])
    })

    await t.test('starts the first step when nothing is running yet', () => {
        assert.deepEqual(advance(steps('a', 'b')).map((s) => s.status), ['active', 'pending'])
    })

    await t.test('leaves a finished board finished', () => {
        const board: Step[] = [{ text: 'a', status: 'done' }]
        assert.deepEqual(advance(board).map((s) => s.status), ['done'])
    })

    await t.test('steps over a failure rather than restarting it', () => {
        const board: Step[] = [
            { text: 'a', status: 'failed' },
            { text: 'b', status: 'pending' },
        ]
        assert.deepEqual(advance(board).map((s) => s.status), ['failed', 'active'])
    })
})

test('renderBoard', async (t) => {
    await t.test('an icon per status, one line each', () => {
        const text = renderBoard({
            steps: [
                { text: 'reading the deployed file', status: 'done' },
                { text: 'uploading the release', status: 'active' },
                { text: 'running the deploy script', status: 'pending' },
            ],
        })
        assert.equal(text, [
            `${ICON.done} reading the deployed file`,
            `${ICON.active} *uploading the release*`,
            `${ICON.pending} running the deploy script`,
        ].join('\n'))
    })

    await t.test('bolds only the running step', () => {
        // Pending and active share an icon; the bold is what separates them.
        const text = renderBoard({ steps: [{ text: 'x', status: 'active' }, { text: 'y', status: 'pending' }] })
        assert.match(text, /\*x\*/)
        assert.doesNotMatch(text, /\*y\*/)
    })

    await t.test('title and footer when given', () => {
        const text = renderBoard({ title: 'Deploy', steps: steps('a'), footer: 'verified: 200' })
        assert.equal(text.split('\n')[0], '*Deploy*')
        assert.match(text, /verified: 200$/)
    })

    await t.test('says so rather than rendering nothing', () => {
        assert.match(renderBoard({ steps: [] }), /no steps/)
    })
})

test('summarize', async (t) => {
    await t.test('counts what is done and names what is running', () => {
        const text = summarize([
            { text: 'a', status: 'done' },
            { text: 'b', status: 'active' },
            { text: 'c', status: 'pending' },
        ])
        assert.match(text, /1\/3 done/)
        assert.match(text, /now: b/)
    })

    await t.test('calls out failures and skips', () => {
        const text = summarize([
            { text: 'a', status: 'failed' },
            { text: 'b', status: 'skipped' },
        ])
        assert.match(text, /1 failed/)
        assert.match(text, /1 skipped/)
    })
})

test('ProgressStore', async (t) => {
    await t.test('remembers a board by channel and ts', () => {
        const store = new ProgressStore()
        store.set('C1', '1.1', { steps: steps('a') })
        assert.deepEqual(store.get('C1', '1.1')?.steps, steps('a'))
    })

    await t.test('keeps boards in different channels apart', () => {
        // Two channels can hold a board at the same ts; one must not shadow
        // the other and rewrite the wrong message.
        const store = new ProgressStore()
        store.set('C1', '1.1', { steps: steps('one') })
        store.set('C2', '1.1', { steps: steps('two') })
        assert.equal(store.get('C1', '1.1')?.steps[0].text, 'one')
        assert.equal(store.get('C2', '1.1')?.steps[0].text, 'two')
    })

    await t.test('returns nothing for a board it never saw', () => {
        assert.equal(new ProgressStore().get('C1', '9.9'), undefined)
    })

    await t.test('evicts the least recently touched board', () => {
        const store = new ProgressStore(3)
        store.set('C', '1', { steps: steps('a') })
        store.set('C', '2', { steps: steps('b') })
        store.set('C', '3', { steps: steps('c') })
        store.get('C', '1')                            // a read is not a touch
        store.set('C', '1', { steps: steps('a2') })    // but a write is
        store.set('C', '4', { steps: steps('d') })

        assert.equal(store.size, 3)
        assert.equal(store.get('C', '2'), undefined, 'the oldest write should be gone')
        assert.ok(store.get('C', '1'))
        assert.ok(store.get('C', '4'))
    })
})
