import test from 'node:test'
import assert from 'node:assert/strict'

import { toMrkdwn, splitForSlack, escapeSlack, MAX_TEXT } from './mrkdwn.js'

test('escapeSlack', async (t) => {
    await t.test('escapes what Slack requires escaped', () => {
        assert.equal(escapeSlack('a & b'), 'a &amp; b')
        assert.equal(escapeSlack('if a < b'), 'if a &lt; b')
    })

    await t.test('leaves a blockquote marker alone', () => {
        // Escaping the leading `>` turns a quote into a line that merely
        // starts with a greater-than sign.
        assert.equal(escapeSlack('> quoted'), '> quoted')
        assert.equal(escapeSlack('> a > b'), '> a &gt; b')
    })
})

test('toMrkdwn', async (t) => {
    await t.test('bold, italic and strikethrough', () => {
        assert.equal(toMrkdwn('**bold**'), '*bold*')
        assert.equal(toMrkdwn('__bold__'), '*bold*')
        assert.equal(toMrkdwn('*italic*'), '_italic_')
        assert.equal(toMrkdwn('~~gone~~'), '~gone~')
    })

    await t.test('bold is not re-read as italic', () => {
        // The whole reason bold is marked rather than replaced outright: the
        // italic rule runs afterwards and would otherwise see its own output.
        assert.equal(toMrkdwn('**a** and **b**'), '*a* and *b*')
        assert.equal(toMrkdwn('**bold _and_ italic**'), '*bold _and_ italic*')
    })

    await t.test('headings become a bold line', () => {
        assert.equal(toMrkdwn('# Title'), '*Title*')
        assert.equal(toMrkdwn('### Deeper'), '*Deeper*')
        assert.equal(toMrkdwn('# One\ntext\n## Two'), '*One*\ntext\n*Two*')
    })

    await t.test('links take Slack shape', () => {
        assert.equal(toMrkdwn('[docs](https://x.dev)'), '<https://x.dev|docs>')
        assert.equal(toMrkdwn('![shot](https://x.dev/a.png)'), '<https://x.dev/a.png|shot>')
    })

    await t.test('a url with an ampersand survives the escaping', () => {
        assert.equal(toMrkdwn('[q](https://x.dev/?a=1&b=2)'), '<https://x.dev/?a=1&amp;b=2|q>')
    })

    await t.test('bullets and task lists', () => {
        assert.equal(toMrkdwn('- one\n- two'), '• one\n• two')
        assert.equal(toMrkdwn('* one'), '• one')
        assert.equal(toMrkdwn('  - nested'), '  • nested')
        assert.equal(toMrkdwn('- [ ] todo\n- [x] done'), '• ☐ todo\n• ☑ done')
    })

    await t.test('numbered lists are left alone', () => {
        // Slack renders them as written, and any conversion loses the numbers.
        assert.equal(toMrkdwn('1. first\n2. second'), '1. first\n2. second')
    })

    await t.test('never rewrites anything inside code', () => {
        // This is the failure that makes a naive converter worse than none:
        // the asterisks in a code sample are part of the code.
        assert.equal(toMrkdwn('`a ** b`'), '`a ** b`')
        assert.equal(
            toMrkdwn('```\nconst x = a ** b\n# not a heading\n```'),
            '```\nconst x = a ** b\n# not a heading\n```')
    })

    await t.test('drops the language off a fence', () => {
        // Slack has no highlighting and prints the info string as a first line.
        assert.equal(toMrkdwn('```ts\nlet a = 1\n```'), '```\nlet a = 1\n```')
    })

    await t.test('prose around a code block is still converted', () => {
        assert.equal(
            toMrkdwn('**before**\n```\nraw **text**\n```\n**after**'),
            '*before*\n```\nraw **text**\n```\n*after*')
    })

    await t.test('leaves arithmetic and globs alone', () => {
        assert.equal(toMrkdwn('2 * 3 * 4'), '2 * 3 * 4')
        assert.equal(toMrkdwn('src/**/*.ts'), 'src/**/*.ts')
    })

    await t.test('a horizontal rule becomes a visible line', () => {
        assert.equal(toMrkdwn('---'), '──────────')
    })

    await t.test('a table becomes an aligned code block', () => {
        // Slack has no table syntax and renders the source as stray pipes —
        // the separator row arrives as a literal "| --- | --- |", which makes
        // a careful table look like a bug. Monospace at least holds its shape.
        const table = '| Symptom | Cause |\n| --- | --- |\n| no styling | missing css |'
        const out = toMrkdwn(table)

        assert.match(out, /^```\n/)
        assert.match(out, /Symptom {5}Cause/)
        assert.match(out, /no styling {2}missing css/)
        assert.doesNotMatch(out, /\|/)
        assert.doesNotMatch(out, /---/)
    })

    await t.test('a table cell keeps its text, not a code placeholder', () => {
        // The table rule has to run before inline code is parked, or a cell
        // holding `code` captures the placeholder and the column renders as a
        // bare number.
        const table = '| Field | Was |\n| --- | --- |\n| path | `req.path` |'
        const out = toMrkdwn(table)

        assert.match(out, /req\.path/)
        assert.doesNotMatch(out, //)
    })

    await t.test('leaves a line of pipes that is not a table alone', () => {
        // No separator row means it was never a table.
        assert.equal(toMrkdwn('a | b | c'), 'a | b | c')
    })
})

test('splitForSlack', async (t) => {
    await t.test('leaves a short message in one piece', () => {
        assert.deepEqual(splitForSlack('hello'), ['hello'])
    })

    await t.test('splits a long message rather than losing the tail', () => {
        // Truncating loses the conclusion, which is the part worth reading.
        const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
        const parts = splitForSlack(body, 500)

        assert.ok(parts.length > 1)
        for (const part of parts) assert.ok(part.length <= 500, `part is ${part.length}`)
        assert.equal(parts.join('\n'), body)
    })

    await t.test('never ends a part inside an open fence', () => {
        // An unclosed fence renders the rest of the channel as code.
        const code = '```\n' + Array.from({ length: 300 }, (_, i) => `row ${i}`).join('\n') + '\n```'
        const parts = splitForSlack(code, 500)

        assert.ok(parts.length > 1)
        for (const part of parts) {
            const fences = (part.match(/```/g) || []).length
            assert.equal(fences % 2, 0, `unbalanced fence in: ${part.slice(0, 40)}`)
        }
    })

    await t.test('cuts a single over-long line', () => {
        const parts = splitForSlack('x'.repeat(1200), 500)
        assert.equal(parts.length, 3)
        assert.equal(parts.join('').length, 1200)
    })

    await t.test('defaults to a limit Slack accepts', () => {
        const parts = splitForSlack('y'.repeat(MAX_TEXT * 3))
        for (const part of parts) assert.ok(part.length <= MAX_TEXT)
    })
})
