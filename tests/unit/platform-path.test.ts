import { describe, expect, test } from 'vitest'

import { arePathsEqual, containsPathMarker } from '../../src/server/platform-path.js'

describe('arePathsEqual', () => {
  test('matches case-mismatched paths on win32', () => {
    expect(
      arePathsEqual('C:\\Users\\admin\\workspace', 'c:\\users\\admin\\workspace', 'win32')
    ).toBe(true)
  })

  test('treats forward and backward slashes as equivalent on win32', () => {
    expect(arePathsEqual('C:/Users/admin/workspace', 'C:\\Users\\admin\\workspace', 'win32')).toBe(
      true
    )
  })

  test('does not match case-mismatched paths on linux', () => {
    expect(arePathsEqual('/home/Admin/workspace', '/home/admin/workspace', 'linux')).toBe(false)
  })

  test('requires exact match on linux including separators', () => {
    expect(arePathsEqual('/home/admin/workspace', '/home/admin/workspace', 'linux')).toBe(true)
    expect(arePathsEqual('/home/admin/workspace', '/home/admin\\workspace', 'linux')).toBe(false)
  })

  test('returns false for genuinely different paths on win32', () => {
    expect(arePathsEqual('C:\\Users\\admin', 'C:\\Users\\bob', 'win32')).toBe(false)
  })
})

describe('containsPathMarker', () => {
  test('finds a forward-slash marker inside a backslash-only path on win32', () => {
    expect(
      containsPathMarker('C:\\Users\\admin\\.gemini\\tmp\\project-hash', '/tmp/', 'win32')
    ).toBe(true)
  })

  test('still finds the marker when separators already match on win32', () => {
    expect(containsPathMarker('/home/admin/.gemini/tmp/project-hash', '/tmp/', 'win32')).toBe(true)
  })

  test('matches marker casing case-insensitively on win32', () => {
    expect(
      containsPathMarker('C:\\Users\\admin\\.gemini\\TMP\\project-hash', '/tmp/', 'win32')
    ).toBe(true)
  })

  test('on linux, a forward-slash marker only matches forward-slash haystacks', () => {
    expect(containsPathMarker('/home/admin/.gemini/tmp/project-hash', '/tmp/', 'linux')).toBe(true)
    expect(
      containsPathMarker('C:\\Users\\admin\\.gemini\\tmp\\project-hash', '/tmp/', 'linux')
    ).toBe(false)
  })

  test('on linux, marker casing remains case-sensitive', () => {
    expect(containsPathMarker('/home/admin/.gemini/TMP/project-hash', '/tmp/', 'linux')).toBe(false)
  })

  test('returns false when the marker is absent on either platform', () => {
    expect(containsPathMarker('C:\\Users\\admin\\.gemini\\chats', '/tmp/', 'win32')).toBe(false)
    expect(containsPathMarker('/home/admin/.gemini/chats', '/tmp/', 'linux')).toBe(false)
  })
})
