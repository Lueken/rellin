import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as plain } from 'node:util';
import { renderMarkdown, cellWidth } from '../station-markdown.mjs';

test('provider accents format headings, emphasis, code and links without literal markers', () => {
  const source = '## Findings\n**Strong evidence** and `code` with [source](docs/evidence.md).';
  for (const agent of ['claude', 'codex']) {
    const output = renderMarkdown(source, 70, agent).join('\n');
    assert.doesNotMatch(plain(output), /##|\*\*|`/);
    assert.match(output, agent === 'claude' ? /100;155;255/ : /255;133;173/);
    assert.match(plain(output), /docs\/evidence.md/);
  }
});
test('Markdown tables wrap cells within aligned columns, preserving their text', () => {
  const rows = renderMarkdown('| Element | Required behavior |\n|---|---|\n| Identity | **Stable** identity across every retry |\n| Retry | Keep the original record |', 48, 'codex');
  assert.ok(rows.some(row => row.includes('─┼─')));
  assert.ok(rows.filter(row => plain(row).includes(' │ ')).every(row => plain(row).indexOf(' │ ') === 8));
  for (const row of rows) assert.ok([...plain(row)].reduce((sum, c) => sum + cellWidth(c), 0) <= 48);
  assert.match(plain(rows.join(' ')), /Stable/);
  const narrow = renderMarkdown('| Element | Required behavior |\n|---|---|\n| Retry | Keep record |', 15).map(plain).join(' ');
  assert.match(narrow, /Element: Retry/); assert.match(narrow, /Keep record/);
});
test('untrusted terminal escapes are removed; fenced Markdown stays literal', () => {
  const output = renderMarkdown('\x1b[2J\x1b]52;c;evil\x07## Safe\n```js\nconst text = "**literal**";\n```', 40).join('\n');
  assert.doesNotMatch(output, /\x1b\[2J|\x1b\]52/);
  assert.match(plain(output), /\*\*literal\*\*/);
});
