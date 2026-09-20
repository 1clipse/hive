const WINDOWS_DEVICE_NAMES =
  /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/iu
const WINDOWS_INVALID_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

const hasWindowsInvalidFilenameChar = (filename: string): boolean => {
  for (const char of filename) {
    if (WINDOWS_INVALID_FILENAME_CHARS.has(char)) return true
    const code = char.codePointAt(0) ?? 0
    if (code >= 0 && code <= 31) return true
  }
  return false
}

export const getWindowsFilenameError = (filename: string): string | undefined => {
  if (!filename.trim()) return 'filename must not be empty'
  if (filename === '.' || filename === '..') return 'filename must not be a relative segment'
  if (hasWindowsInvalidFilenameChar(filename)) {
    return 'filename contains characters Windows cannot create'
  }
  if (/[. ]$/u.test(filename)) return 'filename must not end with a space or period'

  const stem = filename.split('.')[0] ?? filename
  if (WINDOWS_DEVICE_NAMES.test(stem)) {
    return `filename uses reserved Windows device name: ${stem}`
  }
  return undefined
}

export const assertWindowsSafeFilename = (filename: string): void => {
  const error = getWindowsFilenameError(filename)
  if (error) throw new Error(error)
}
