import { describe, expect, test } from 'vitest'

import {
  getSuggestedWorkspaceNameFromPath,
  getWindowsBrowseParentPath,
} from '../../src/server/fs-browse.js'
import { WINDOWS_DRIVES_ROOT } from '../../src/shared/fs-browse.js'

describe('getWindowsBrowseParentPath', () => {
  test('returns the virtual drive list for drive roots', () => {
    expect(getWindowsBrowseParentPath('C:\\')).toBe(WINDOWS_DRIVES_ROOT)
    expect(getWindowsBrowseParentPath('d:/')).toBe(WINDOWS_DRIVES_ROOT)
  })

  test('returns the virtual drive list for UNC share roots', () => {
    expect(getWindowsBrowseParentPath('\\\\server\\share\\')).toBe(WINDOWS_DRIVES_ROOT)
    expect(getWindowsBrowseParentPath('//server/share/')).toBe(WINDOWS_DRIVES_ROOT)
  })

  test('returns the containing directory for Windows children', () => {
    expect(getWindowsBrowseParentPath('C:\\Users\\28018')).toBe('C:\\Users')
    expect(getWindowsBrowseParentPath('\\\\server\\share\\repo')).toBe('\\\\server\\share\\')
  })
})

describe('getSuggestedWorkspaceNameFromPath', () => {
  test('strips the colon from Windows drive roots', () => {
    expect(getSuggestedWorkspaceNameFromPath('D:\\')).toBe('D')
    expect(getSuggestedWorkspaceNameFromPath('C:/')).toBe('C')
  })

  test('keeps regular leaf directory names', () => {
    expect(getSuggestedWorkspaceNameFromPath('C:\\Users\\28018\\project')).toBe('project')
    expect(getSuggestedWorkspaceNameFromPath('\\\\server\\share\\')).toBe('share')
  })
})
