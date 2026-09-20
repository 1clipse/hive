import { describe, expect, test } from 'vitest'

import { sanitizePastedPath } from '../../src/shared/path-input.js'

describe('sanitizePastedPath', () => {
  test('strips a matched pair of surrounding double quotes after trimming whitespace', () => {
    // Windows "Copy as path" produces this exact shape: leading/trailing quotes
    // and frequently extra whitespace from copy/paste. Both must be removed so
    // realpathSync on the server side does not ENOENT.
    expect(sanitizePastedPath('  "C:\\Users\\刘小明\\项目"  ')).toBe('C:\\Users\\刘小明\\项目')
  })

  test('leaves an unquoted POSIX path untouched (only whitespace trim)', () => {
    expect(sanitizePastedPath('/Users/foo')).toBe('/Users/foo')
    expect(sanitizePastedPath('  /Users/foo  ')).toBe('/Users/foo')
  })

  test('leaves an unmatched leading double quote alone — conservative heuristic', () => {
    // A single dangling quote could be a legitimate part of the filename on
    // exotic filesystems. Only the symmetric outer pair gets stripped.
    expect(sanitizePastedPath('"C:\\Users\\name')).toBe('"C:\\Users\\name')
  })

  test('leaves an unmatched trailing double quote alone', () => {
    expect(sanitizePastedPath('C:\\Users\\name"')).toBe('C:\\Users\\name"')
  })

  test('strips a matched pair of surrounding single quotes', () => {
    expect(sanitizePastedPath("'/Users/foo'")).toBe('/Users/foo')
  })

  test('does not strip a leading double quote paired with a trailing single quote', () => {
    // Asymmetric quoting is suspicious; leave both characters in place rather
    // than guess at the user's intent.
    expect(sanitizePastedPath(`"/Users/foo'`)).toBe(`"/Users/foo'`)
    expect(sanitizePastedPath(`'/Users/foo"`)).toBe(`'/Users/foo"`)
  })

  test('preserves interior quotes — only the outer matched pair is removed', () => {
    // A path that legitimately contains a quote in the middle must round-trip.
    // If we ever blindly stripped all quotes this assertion flips.
    expect(sanitizePastedPath('"/Users/weird"name/dir"')).toBe('/Users/weird"name/dir')
  })

  test('empty input returns empty string', () => {
    expect(sanitizePastedPath('')).toBe('')
    expect(sanitizePastedPath('   ')).toBe('')
  })

  test('a string consisting of a single quote character is left alone', () => {
    // length < 2 → there is no matched pair to strip; the lone character must
    // survive verbatim so the server can surface a useful validation error.
    expect(sanitizePastedPath('"')).toBe('"')
    expect(sanitizePastedPath("'")).toBe("'")
  })
})
